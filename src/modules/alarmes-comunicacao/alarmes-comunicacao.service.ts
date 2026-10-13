import { BadRequestException, ForbiddenException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import * as nodemailer from 'nodemailer';
import { PrismaService, ScopedUser } from '@/core';
import { WhatsappService } from '../monitoramento-fv/notificacao/whatsapp.service';

/**
 * ALARMES DE COMUNICAÇÃO (substitui o EquipmentMonitorService, que era só e-mail em memória).
 *
 * "Sem comunicação" vira ALARME em logs_mqtt (aparece em Alarmes ativos, tem histórico,
 * reconhecimento e resolução automática), identificado por dados_snapshot.origem='comunicacao'.
 * Estado mora no BANCO (sobrevive a restart). A cada 2 min:
 *   - TON: offline se o heartbeat (iot_dispositivos_online.last_seen) passou do limiar → UM
 *     alarme "TON X sem comunicação (afeta N)", e os equipamentos atrás dela NÃO abrem alarme
 *     próprio (causa-raiz, não lista solta).
 *   - Equipamento: offline se o último dado (equipamentos_dados) passou do limiar do TIPO
 *     (ton 15, inversor 30, medidor 30, gateway/A966 45, relé 15; override por equipamento).
 *   - Inversor só ABRE alarme dentro da janela de sol (08:00–17:30 Brasília): de noite parar é normal.
 *   - Anti-oscilação: abre só após o limiar; NORMALIZA só após `estavel_min` estável. Se cair de
 *     novo antes disso, conta "oscilações" no mesmo alarme (sem e-mail novo).
 * Avisos: e-mail ao abrir e ao normalizar (admins Aupus + destinatários da usina — cada um só
 * recebe as usinas dele) e RESUMO DIÁRIO (WhatsApp no grupo + e-mail) com o que segue aberto —
 * serve de lembrete enquanto o problema durar.
 * 1ª execução (nenhum alarme de comunicação no banco): abre os alarmes SEM notificar (sem spam).
 */

type Familia = 'ton' | 'inversor' | 'medidor' | 'gateway' | 'rele' | 'outro';
const PAPEIS_ADMIN = ['super_admin', 'admin'];
const FAMILIA_LABEL: Record<Familia, string> = {
  ton: 'TON', inversor: 'Inversor', medidor: 'Medidor', gateway: 'Gateway/A966', rele: 'Relé', outro: 'Equipamento',
};

export interface ConfigAlarmes {
  ativo: boolean;
  email_eventos: boolean;
  resumo_hora: string;
  resumo_whatsapp: boolean;
  resumo_email: boolean;
  /** Resumo vai como seção final do boletim das 21:05 (mensagem do grupo). */
  incluir_no_boletim: boolean;
  grupo_jid: string | null;
  inversor_janela_inicio: string;
  inversor_janela_fim: string;
  estavel_min: number;
  limiares: Record<Familia, number>;
  ultimo_resumo_data: string | null;
}

interface Equip {
  id: string;
  nome: string;
  topico: string | null;
  familia: Familia;
  planta_id: string;
  planta_nome: string;
  unidade_nome: string;
  ultima: Date | null;
  limiar_override: number | null;
  ignorar: boolean;
}

interface AlarmeAberto {
  id: string;
  equipamento_id: string;
  created_at: Date;
  snapshot: Record<string, any>;
}

interface Evento {
  tipo: 'aberto' | 'normalizado';
  planta_id: string;
  planta_nome: string;
  unidade_nome: string;
  titulo: string;          // "TON TON1" / "Inversor IV1"
  detalhe: string;         // "afeta 3 inversores + A966" / "sem dados há 42 min"
  duracaoMin?: number;
  oscilacoes?: number;
}

const brt = (d = new Date()) => new Date(d.getTime() - 3 * 3600_000);   // Brasília (sem horário de verão)
const hhmm = (s: string) => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const minutosBrt = (d = new Date()) => { const b = brt(d); return b.getUTCHours() * 60 + b.getUTCMinutes(); };
const dataBrt = (d = new Date()) => brt(d).toISOString().slice(0, 10);
const fmtDur = (min: number) => {
  if (!Number.isFinite(min)) return '—';
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${String(m % 60).padStart(2, '0')}`;
  return `${Math.floor(h / 24)} dias`;
};
const esc = (s: string) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

@Injectable()
export class AlarmesComunicacaoService implements OnModuleInit {
  private readonly logger = new Logger(AlarmesComunicacaoService.name);
  private rodando = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly whats: WhatsappService,
  ) {}

  onModuleInit() {
    // 1ª avaliação logo após subir (não espera o cron).
    setTimeout(() => this.tick().catch(() => undefined), 30_000);
  }

  assertAdmin(user?: ScopedUser) {
    if (!user?.role || !PAPEIS_ADMIN.includes(user.role)) {
      throw new ForbiddenException('Somente administradores configuram os alarmes de comunicação.');
    }
  }

  // ------------------------------------------------------------------ config
  async getConfig(): Promise<ConfigAlarmes> {
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT ativo, email_eventos, resumo_hora, resumo_whatsapp, resumo_email, incluir_no_boletim, grupo_jid,
             inversor_janela_inicio, inversor_janela_fim, estavel_min, limiares,
             to_char(ultimo_resumo_data, 'YYYY-MM-DD') AS ultimo_resumo_data
      FROM alarme_comunicacao_config WHERE id = 'default' LIMIT 1`;
    const r = rows[0] ?? {};
    const lim = { ton: 15, inversor: 30, medidor: 30, gateway: 45, rele: 15, outro: 30, ...(r.limiares ?? {}) };
    return {
      ativo: r.ativo !== false,
      email_eventos: r.email_eventos === true,
      resumo_hora: r.resumo_hora ?? '18:00',
      resumo_whatsapp: r.resumo_whatsapp === true,
      resumo_email: r.resumo_email === true,
      incluir_no_boletim: r.incluir_no_boletim === true,
      grupo_jid: r.grupo_jid ?? null,
      inversor_janela_inicio: r.inversor_janela_inicio ?? '08:00',
      inversor_janela_fim: r.inversor_janela_fim ?? '17:30',
      estavel_min: Number(r.estavel_min) || 10,
      limiares: lim,
      ultimo_resumo_data: r.ultimo_resumo_data ?? null,
    };
  }

  async updateConfig(p: Partial<ConfigAlarmes>): Promise<ConfigAlarmes> {
    const atual = await this.getConfig();
    const hora = (v: any, d: string) => (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : d);
    const n = {
      ativo: p.ativo ?? atual.ativo,
      email_eventos: p.email_eventos ?? atual.email_eventos,
      resumo_hora: hora(p.resumo_hora, atual.resumo_hora),
      resumo_whatsapp: p.resumo_whatsapp ?? atual.resumo_whatsapp,
      resumo_email: p.resumo_email ?? atual.resumo_email,
      incluir: p.incluir_no_boletim ?? atual.incluir_no_boletim,
      grupo_jid: p.grupo_jid === undefined ? atual.grupo_jid : (String(p.grupo_jid || '').trim() || null),
      ini: hora(p.inversor_janela_inicio, atual.inversor_janela_inicio),
      fim: hora(p.inversor_janela_fim, atual.inversor_janela_fim),
      estavel: Math.max(1, Math.min(240, Number(p.estavel_min ?? atual.estavel_min) || 10)),
      limiares: { ...atual.limiares, ...(p.limiares ?? {}) },
    };
    for (const k of Object.keys(n.limiares)) {
      const v = Number((n.limiares as any)[k]);
      (n.limiares as any)[k] = Number.isFinite(v) ? Math.max(2, Math.min(1440, Math.round(v))) : 30;
    }
    await this.prisma.$executeRaw`
      UPDATE alarme_comunicacao_config SET
        ativo = ${n.ativo}, email_eventos = ${n.email_eventos}, resumo_hora = ${n.resumo_hora},
        resumo_whatsapp = ${n.resumo_whatsapp}, resumo_email = ${n.resumo_email}, grupo_jid = ${n.grupo_jid},
        incluir_no_boletim = ${n.incluir},
        inversor_janela_inicio = ${n.ini}, inversor_janela_fim = ${n.fim}, estavel_min = ${n.estavel},
        limiares = ${JSON.stringify(n.limiares)}::jsonb, updated_at = now()
      WHERE id = 'default'`;
    return this.getConfig();
  }

  // --------------------------------------------------------- destinatários
  async listarDestinatarios() {
    return this.prisma.$queryRaw<any[]>`
      SELECT TRIM(d.id) AS id, TRIM(d.planta_id) AS planta_id, p.nome AS planta_nome, d.email, d.nome, d.ativo
      FROM alarme_destinatarios d JOIN plantas p ON p.id = d.planta_id
      ORDER BY p.nome, d.email`;
  }

  async adicionarDestinatario(plantaId: string, email: string, nome?: string) {
    const e = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new ForbiddenException('E-mail inválido.');
    const pid = String(plantaId || '').trim();
    await this.prisma.$executeRaw`
      INSERT INTO alarme_destinatarios (id, planta_id, email, nome, ativo)
      VALUES (${randomUUID().replace(/-/g, '').slice(0, 25)}, ${pid}, ${e}, ${nome?.trim() || null}, true)
      ON CONFLICT (planta_id, lower(email)) DO UPDATE SET ativo = true, nome = COALESCE(EXCLUDED.nome, alarme_destinatarios.nome)`;
    return this.listarDestinatarios();
  }

  async removerDestinatario(id: string) {
    await this.prisma.$executeRaw`DELETE FROM alarme_destinatarios WHERE TRIM(id) = ${String(id).trim()}`;
    return this.listarDestinatarios();
  }

  async definirLimiar(equipamentoId: string, limiarMin: number | null, ignorar: boolean) {
    const id = String(equipamentoId).trim();
    const lim = limiarMin == null || limiarMin === ('' as any) ? null : Math.max(2, Math.min(1440, Math.round(Number(limiarMin))));
    await this.prisma.$executeRaw`
      INSERT INTO alarme_comunicacao_limiar (equipamento_id, limiar_min, ignorar, updated_at)
      VALUES (${id}, ${lim}, ${!!ignorar}, now())
      ON CONFLICT (equipamento_id) DO UPDATE SET limiar_min = EXCLUDED.limiar_min, ignorar = EXCLUDED.ignorar, updated_at = now()`;
    return { equipamento_id: id, limiar_min: lim, ignorar: !!ignorar };
  }

  // ----------------------------------------------- unidades fora do monitoramento
  /** Unidades desligadas do monitoramento de comunicação (+ as com status 'inativo'). */
  async listarUnidadesDesativadas() {
    return this.prisma.$queryRaw<any[]>`
      SELECT TRIM(u.id) AS unidade_id, TRIM(u.nome) AS unidade, TRIM(p.nome) AS planta,
             COALESCE(au.motivo, 'inativa') AS motivo, au.observacao, au.created_at
      FROM unidades u
      JOIN plantas p ON p.id = u.planta_id AND p.deleted_at IS NULL
      LEFT JOIN alarme_comunicacao_unidade au ON au.unidade_id = u.id
      WHERE u.deleted_at IS NULL AND (au.unidade_id IS NOT NULL OR u.status = 'inativo')
      ORDER BY p.nome, u.nome`;
  }

  /**
   * Tira a unidade do monitoramento (motivo: retirado | api | outro) e fecha em silêncio os
   * alarmes de comunicação abertos dela. `motivo = null` volta a monitorar.
   */
  async definirUnidade(unidadeId: string, motivo: 'retirado' | 'api' | 'outro' | null, observacao?: string | null, user?: ScopedUser) {
    const id = String(unidadeId).trim();
    if (!motivo) {
      await this.prisma.$executeRaw`DELETE FROM alarme_comunicacao_unidade WHERE unidade_id = ${id}::bpchar`;
      return this.listarUnidadesDesativadas();
    }
    if (!['retirado', 'api', 'outro'].includes(motivo)) throw new BadRequestException('motivo inválido');
    await this.prisma.$executeRaw`
      INSERT INTO alarme_comunicacao_unidade (unidade_id, motivo, observacao, definido_por)
      VALUES (${id}::bpchar, ${motivo}, ${observacao?.trim() || null}, ${user?.id?.trim() || null})
      ON CONFLICT (unidade_id) DO UPDATE SET motivo = EXCLUDED.motivo, observacao = EXCLUDED.observacao,
        definido_por = EXCLUDED.definido_por, created_at = now()`;
    await this.prisma.$executeRaw`
      UPDATE logs_mqtt l SET resolvido_em = now(), resolvido_por = ${user?.id?.trim() || null},
        dados_snapshot = l.dados_snapshot || '{"silencioso": true, "unidade_desativada": true}'::jsonb
      FROM equipamentos e
      WHERE e.id = l.equipamento_id AND e.unidade_id = ${id}::bpchar
        AND l.tipo = 'alerta' AND l.resolvido_em IS NULL AND (l.dados_snapshot->>'origem') = 'comunicacao'`;
    return this.listarUnidadesDesativadas();
  }

  // ------------------------------------------------------------- avaliação
  @Cron('*/2 * * * *')
  async tick() {
    if (this.rodando) return;
    this.rodando = true;
    try {
      const cfg = await this.getConfig();
      if (cfg.ativo) {
        const eventos = await this.avaliar(cfg);
        if (eventos.length && cfg.email_eventos) await this.emailEventos(eventos);
        await this.talvezResumo(cfg);
      }
    } catch (e: any) {
      this.logger.error(`Falha na avaliação: ${e?.message || e}`);
    } finally {
      this.rodando = false;
    }
  }

  private async equipamentos(): Promise<Equip[]> {
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT TRIM(e.id) AS id, TRIM(e.nome) AS nome, NULLIF(TRIM(e.topico_mqtt), '') AS topico,
             CASE
               WHEN COALESCE(e.tipo_equipamento, '') ILIKE 'TON%' THEN 'ton'
               WHEN CONCAT_WS(' ', t.codigo, t.nome, e.tipo_equipamento, e.topico_mqtt, c.nome) ~* 'INVERSOR' THEN 'inversor'
               WHEN CONCAT_WS(' ', t.codigo, t.nome, e.tipo_equipamento, e.topico_mqtt, c.nome) ~* '(A-?966|/SSU/|GATEWAY|EQTL)' THEN 'gateway'
               WHEN CONCAT_WS(' ', t.codigo, t.nome, e.tipo_equipamento, c.nome) ~* 'REL[EÉ]' THEN 'rele'
               WHEN CONCAT_WS(' ', t.codigo, t.nome, e.tipo_equipamento, e.topico_mqtt, c.nome) ~* '(METER|MEDIDOR|M160|PD666)' THEN 'medidor'
               ELSE 'outro'
             END AS familia,
             TRIM(p.id) AS planta_id, TRIM(p.nome) AS planta_nome, TRIM(u.nome) AS unidade_nome,
             ed.ultima, l.limiar_min, COALESCE(l.ignorar, false) AS ignorar
      FROM equipamentos e
      JOIN unidades u ON u.id = e.unidade_id AND u.deleted_at IS NULL
      JOIN plantas  p ON p.id = u.planta_id AND p.deleted_at IS NULL
      LEFT JOIN tipos_equipamentos t ON t.id = e.tipo_equipamento_id
      LEFT JOIN categorias_equipamentos c ON c.id = t.categoria_id
      LEFT JOIN alarme_comunicacao_limiar l ON l.equipamento_id = e.id
      LEFT JOIN LATERAL (
        SELECT d.timestamp_dados AS ultima FROM equipamentos_dados d
        WHERE d.equipamento_id = e.id ORDER BY d.timestamp_dados DESC LIMIT 1
      ) ed ON true
      WHERE e.mqtt_habilitado = true AND e.deleted_at IS NULL
        AND COALESCE(e.topico_mqtt, '') !~* '^(TESTE|BANCADA)(/|$)'   -- bancada não alarma
        AND COALESCE(u.status, 'ativo') <> 'inativo'                   -- unidade desativada
        AND NOT EXISTS (SELECT 1 FROM alarme_comunicacao_unidade au WHERE au.unidade_id = u.id)
      `;
    return rows.map((r) => ({
      id: r.id, nome: r.nome, topico: r.topico, familia: r.familia as Familia,
      planta_id: r.planta_id, planta_nome: r.planta_nome, unidade_nome: r.unidade_nome,
      ultima: r.ultima ? new Date(r.ultima) : null,
      limiar_override: r.limiar_min != null ? Number(r.limiar_min) : null,
      ignorar: !!r.ignorar,
    }));
  }

  private async heartbeats(): Promise<Map<string, Date | null>> {
    const rows = await this.prisma.$queryRaw<Array<{ topico: string; last_seen: Date | null }>>`
      SELECT TRIM(topico_mqtt) AS topico, last_seen FROM iot_dispositivos_online
      WHERE topico_mqtt NOT LIKE 'TESTE/%'`;
    return new Map(rows.map((r) => [r.topico, r.last_seen ? new Date(r.last_seen) : null]));
  }

  private async abertos(): Promise<Map<string, AlarmeAberto>> {
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT TRIM(id) AS id, TRIM(equipamento_id) AS equipamento_id, created_at, dados_snapshot
      FROM logs_mqtt
      WHERE tipo = 'alerta' AND resolvido_em IS NULL AND (dados_snapshot->>'origem') = 'comunicacao'`;
    return new Map(rows.map((r) => [r.equipamento_id, { id: r.id, equipamento_id: r.equipamento_id, created_at: new Date(r.created_at), snapshot: r.dados_snapshot ?? {} }]));
  }

  /** Avalia tudo e devolve os eventos (abertos/normalizados) a notificar. */
  async avaliar(cfg: ConfigAlarmes): Promise<Evento[]> {
    const agora = new Date();
    const [equips, hb, abertos] = await Promise.all([this.equipamentos(), this.heartbeats(), this.abertos()]);
    const primeiraVez = (await this.prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*) AS n FROM logs_mqtt WHERE (dados_snapshot->>'origem') = 'comunicacao'`)[0]?.n === BigInt(0);
    const minDesde = (d: Date | null) => (d ? (agora.getTime() - d.getTime()) / 60000 : Infinity);
    const mBrt = minutosBrt(agora);
    const naJanelaSol = mBrt >= hhmm(cfg.inversor_janela_inicio) && mBrt <= hhmm(cfg.inversor_janela_fim);
    const eventos: Evento[] = [];

    // TONs (equipamento tipo TON cujo tópico tem heartbeat)
    const tons = equips.filter((e) => e.familia === 'ton' && e.topico && hb.has(e.topico));
    const tonOffline = new Map<string, Equip>(); // topico -> TON offline
    const limiarDe = (e: Equip) => (e.limiar_override ?? cfg.limiares[e.familia] ?? 30);
    for (const t of tons) {
      if (t.ignorar) continue;
      // offline pelo heartbeat OU ainda com alarme aberto (estabilizando após voltar): os
      // equipamentos dela levam alguns minutos para voltar a publicar — sem isso abriam
      // alarme próprio logo após a TON voltar.
      if (minDesde(hb.get(t.topico!) ?? null) >= limiarDe(t) || abertos.has(t.id)) tonOffline.set(t.topico!, t);
    }
    const tonDoEquip = (e: Equip): Equip | undefined => {
      if (!e.topico) return undefined;
      let melhor: Equip | undefined;
      for (const t of tons) if (e.topico.startsWith(`${t.topico}/`) && (!melhor || t.topico!.length > melhor.topico!.length)) melhor = t;
      return melhor;
    };

    for (const e of equips) {
      if (e.ignorar) continue;
      const aberto = abertos.get(e.id);
      let offline: boolean;
      let detalhe = '';
      let afetados: string[] = [];
      let desde: Date | null = null;   // último dado/heartbeat — base da duração real
      if (e.familia === 'ton') {
        if (!e.topico || !hb.has(e.topico)) continue;          // TON sem heartbeat conhecido: nada a avaliar
        desde = hb.get(e.topico) ?? null;
        const min = minDesde(desde);
        offline = min >= limiarDe(e);
        afetados = [...new Set(equips.filter((x) => x.familia !== 'ton' && tonDoEquip(x)?.id === e.id).map((x) => x.nome))];
        detalhe = `sem comunicação há ${fmtDur(min)}${afetados.length ? ` · afeta ${afetados.length}: ${afetados.join(', ')}` : ''}`;
      } else {
        if (!e.ultima) continue;                                  // nunca mandou dado: não comissionado
        const ton = tonDoEquip(e);
        if (ton && tonOffline.has(ton.topico!)) {
          // causa-raiz é a TON: não abre alarme do equipamento; um já aberto é absorvido pelo
          // alarme da TON (que o lista em "afetados") e fecha sem aviso.
          if (aberto) {
            const snap = { ...aberto.snapshot, silencioso: true, absorvido_pela_ton: ton.id };
            await this.prisma.$executeRaw`
              UPDATE logs_mqtt SET resolvido_em = now(), dados_snapshot = ${JSON.stringify(snap)}::jsonb WHERE TRIM(id) = ${aberto.id}`;
          }
          continue;
        }
        desde = e.ultima;
        const min = minDesde(e.ultima);
        offline = min >= limiarDe(e);
        detalhe = `sem dados há ${fmtDur(min)}`;
        if (offline && !aberto && e.familia === 'inversor' && !naJanelaSol) continue;   // noite: normal
      }

      // "TON TON" / "Inversor Inversor Solar 2": só prefixa o tipo se o nome não o tiver.
      const rotulo = FAMILIA_LABEL[e.familia];
      const titulo = e.nome.toLowerCase().includes(rotulo.split('/')[0].toLowerCase()) ? e.nome : `${rotulo} ${e.nome}`;
      if (offline && !aberto) {
        await this.prisma.logs_mqtt.create({
          data: {
            tipo: 'alerta',
            equipamento_id: e.id,
            mensagem: `${titulo} sem comunicação`.slice(0, 500),
            severidade: e.familia === 'ton' || e.familia === 'inversor' ? 'ALTA' : 'MEDIA',
            dados_snapshot: {
              origem: 'comunicacao', sem_comunicacao: true, familia: e.familia,
              limiar_min: limiarDe(e), afetados, detalhe, oscilacoes: 0, volta_em: null,
              desde: desde?.toISOString() ?? null,
              silencioso: primeiraVez,
            },
          },
        });
        if (!primeiraVez) {
          eventos.push({ tipo: 'aberto', planta_id: e.planta_id, planta_nome: e.planta_nome, unidade_nome: e.unidade_nome, titulo, detalhe });
        }
      } else if (offline && aberto && aberto.snapshot?.volta_em) {
        // caiu de novo antes de estabilizar: oscilação (sem e-mail novo)
        const snap = { ...aberto.snapshot, volta_em: null, oscilacoes: Number(aberto.snapshot.oscilacoes || 0) + 1, detalhe, afetados,
          desde: aberto.snapshot?.desde ?? desde?.toISOString() ?? null };
        await this.prisma.$executeRaw`UPDATE logs_mqtt SET dados_snapshot = ${JSON.stringify(snap)}::jsonb WHERE TRIM(id) = ${aberto.id}`;
      } else if (offline && aberto) {
        // mantém detalhe/afetados atualizados; 'desde' fica o da queda original
        const snap = { ...aberto.snapshot, detalhe, afetados, desde: aberto.snapshot?.desde ?? desde?.toISOString() ?? null };
        await this.prisma.$executeRaw`UPDATE logs_mqtt SET dados_snapshot = ${JSON.stringify(snap)}::jsonb WHERE TRIM(id) = ${aberto.id}`;
      } else if (!offline && aberto) {
        const volta = aberto.snapshot?.volta_em ? new Date(aberto.snapshot.volta_em) : null;
        if (!volta) {
          const snap = { ...aberto.snapshot, volta_em: agora.toISOString() };
          await this.prisma.$executeRaw`UPDATE logs_mqtt SET dados_snapshot = ${JSON.stringify(snap)}::jsonb WHERE TRIM(id) = ${aberto.id}`;
        } else if (minDesde(volta) >= cfg.estavel_min) {
          const caiu = aberto.snapshot?.desde ? new Date(aberto.snapshot.desde) : null;
          const duracao = caiu
            ? (volta.getTime() - caiu.getTime()) / 60000
            : (volta.getTime() - aberto.created_at.getTime()) / 60000 + Number(aberto.snapshot?.limiar_min || 0);
          const snap = { ...aberto.snapshot, normalizado_em: agora.toISOString(), duracao_min: Math.round(duracao) };
          await this.prisma.$executeRaw`
            UPDATE logs_mqtt SET resolvido_em = now(), dados_snapshot = ${JSON.stringify(snap)}::jsonb WHERE TRIM(id) = ${aberto.id}`;
          // aberto em silêncio (1ª execução): o "caiu" nunca foi avisado → não avisa o "voltou"
          if (!aberto.snapshot?.silencioso) {
            eventos.push({
              tipo: 'normalizado', planta_id: e.planta_id, planta_nome: e.planta_nome, unidade_nome: e.unidade_nome,
              titulo, detalhe: `voltou após ${fmtDur(duracao)}`, duracaoMin: duracao,
              oscilacoes: Number(aberto.snapshot?.oscilacoes || 0),
            });
          }
        }
      }
    }
    if (eventos.length) this.logger.log(`Comunicação: ${eventos.filter((x) => x.tipo === 'aberto').length} aberto(s), ${eventos.filter((x) => x.tipo === 'normalizado').length} normalizado(s)`);
    return eventos;
  }

  // ------------------------------------------------------------ destinos
  /** e-mail -> plantas que ele recebe (null = todas, equipe Aupus). */
  private async destinos(): Promise<Map<string, Set<string> | null>> {
    const mapa = new Map<string, Set<string> | null>();
    const admins = await this.prisma.$queryRaw<Array<{ email: string }>>`
      SELECT DISTINCT lower(TRIM(email)) AS email FROM usuarios
      WHERE deleted_at IS NULL AND COALESCE(email, '') <> '' AND role IN ('super_admin', 'admin')`;
    for (const a of admins) mapa.set(a.email, null);
    const porPlanta = await this.prisma.$queryRaw<Array<{ email: string; planta_id: string }>>`
      SELECT lower(TRIM(email)) AS email, TRIM(planta_id) AS planta_id FROM alarme_destinatarios WHERE ativo = true`;
    for (const d of porPlanta) {
      if (mapa.get(d.email) === null) continue;            // admin já recebe tudo
      const s = (mapa.get(d.email) as Set<string> | undefined) ?? new Set<string>();
      s.add(d.planta_id);
      mapa.set(d.email, s);
    }
    return mapa;
  }

  private transporter(): nodemailer.Transporter | null {
    if (!process.env.SMTP_HOST) { this.logger.warn('SMTP_HOST não configurado — alarmes só no painel'); return null; }
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }

  private htmlLista(itens: Evento[], cor: string) {
    const porPlanta = new Map<string, Evento[]>();
    for (const i of itens) porPlanta.set(i.planta_nome, [...(porPlanta.get(i.planta_nome) ?? []), i]);
    let h = '';
    for (const [planta, evs] of porPlanta) {
      h += `<p style="margin:16px 0 6px;font-weight:bold;color:#16213e">${esc(planta)}</p><table style="width:100%;border-collapse:collapse">`;
      for (const ev of evs) {
        h += `<tr><td style="padding:7px 10px;border-bottom:1px solid #eee"><b>${esc(ev.titulo)}</b><br><span style="font-size:12px;color:#666">${esc(ev.unidade_nome)}</span></td>
          <td style="padding:7px 10px;border-bottom:1px solid #eee;color:${cor};font-size:13px">${esc(ev.detalhe)}${ev.oscilacoes ? ` · oscilou ${ev.oscilacoes}×` : ''}</td></tr>`;
      }
      h += '</table>';
    }
    return h;
  }

  private async emailEventos(eventos: Evento[]) {
    const tr = this.transporter();
    if (!tr) return;
    const destinos = await this.destinos();
    for (const [email, plantas] of destinos) {
      const meus = eventos.filter((e) => plantas === null || plantas.has(e.planta_id));
      if (!meus.length) continue;
      const ab = meus.filter((e) => e.tipo === 'aberto');
      const no = meus.filter((e) => e.tipo === 'normalizado');
      const assunto = ab.length
        ? `🔴 [Sem comunicação] ${ab.length} alarme(s)${no.length ? ` · ✅ ${no.length} normalizado(s)` : ''}`
        : `✅ [Comunicação normalizada] ${no.length} equipamento(s)`;
      const html = `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto">
        <div style="background:#16213e;padding:18px 20px;border-radius:8px 8px 0 0"><h2 style="color:#fff;margin:0">Alarmes de comunicação</h2></div>
        <div style="padding:18px 20px;background:#fff;border:1px solid #eee;border-top:none">
          ${ab.length ? `<h3 style="color:#e53e3e;margin:4px 0">🔴 Sem comunicação</h3>${this.htmlLista(ab, '#e53e3e')}` : ''}
          ${no.length ? `<h3 style="color:#2f855a;margin:18px 0 4px">✅ Normalizados</h3>${this.htmlLista(no, '#2f855a')}` : ''}
          <p style="margin-top:20px;font-size:12px;color:#888">NexON — alarmes de comunicação. Os abertos também aparecem em Alarmes ativos e no resumo diário.</p>
        </div></div>`;
      try {
        await tr.sendMail({ from: `"NexON Alarmes" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`, to: email, subject: assunto, html });
      } catch (e: any) {
        this.logger.error(`E-mail de alarme para ${email} falhou: ${e?.message}`);
      }
    }
  }

  /** Alarmes de comunicação abertos + equipamentos marcados como "ignorar" (tela de config). */
  async listarAbertos() {
    const abertos = await this.prisma.$queryRaw<any[]>`
      SELECT TRIM(l.id) AS id, TRIM(l.equipamento_id) AS equipamento_id, l.mensagem, l.severidade, l.created_at,
             l.dados_snapshot->>'detalhe' AS detalhe, (l.dados_snapshot->>'oscilacoes')::int AS oscilacoes,
             TRIM(p.nome) AS planta, TRIM(u.nome) AS unidade, lm.limiar_min
      FROM logs_mqtt l
      JOIN equipamentos e ON e.id = l.equipamento_id
      JOIN unidades u ON u.id = e.unidade_id
      JOIN plantas p ON p.id = u.planta_id
      LEFT JOIN alarme_comunicacao_limiar lm ON lm.equipamento_id = l.equipamento_id
      WHERE l.tipo = 'alerta' AND l.resolvido_em IS NULL AND (l.dados_snapshot->>'origem') = 'comunicacao'
      ORDER BY p.nome, l.created_at`;
    const ignorados = await this.prisma.$queryRaw<any[]>`
      SELECT TRIM(lm.equipamento_id) AS equipamento_id, TRIM(e.nome) AS nome, TRIM(p.nome) AS planta
      FROM alarme_comunicacao_limiar lm
      JOIN equipamentos e ON e.id = lm.equipamento_id
      JOIN unidades u ON u.id = e.unidade_id
      JOIN plantas p ON p.id = u.planta_id
      WHERE lm.ignorar = true ORDER BY p.nome, e.nome`;
    return { abertos, ignorados };
  }

  /** Marca/desmarca "ignorar"; ao ignorar, fecha o alarme aberto do equipamento. */
  async ignorar(equipamentoId: string, ignorar: boolean, user?: ScopedUser) {
    const id = String(equipamentoId).trim();
    const atual = await this.prisma.$queryRaw<Array<{ limiar_min: number | null }>>`
      SELECT limiar_min FROM alarme_comunicacao_limiar WHERE equipamento_id = ${id}::bpchar`;
    await this.definirLimiar(id, atual[0]?.limiar_min ?? null, ignorar);
    if (ignorar) {
      await this.prisma.$executeRaw`
        UPDATE logs_mqtt SET resolvido_em = now(), resolvido_por = ${user?.id?.trim() || null}
        WHERE equipamento_id = ${id}::bpchar AND tipo = 'alerta' AND resolvido_em IS NULL
          AND (dados_snapshot->>'origem') = 'comunicacao'`;
    }
    return this.listarAbertos();
  }

  // ---------------------------------------------------------------- resumo
  /** Texto do resumo diário (WhatsApp) — o que segue sem comunicação + normalizados nas 24 h. */
  /**
   * Fechamento do dia (enviado no horário `resumo_hora`, padrão 18:00):
   *  🔴 caiu hoje e continua fora · 🟡 caiu e voltou hoje · ⚫ fora há mais de 1 dia (compacto).
   * Durações contam do último dado/heartbeat (`desde`), não da abertura do alarme.
   */
  /** Seção do boletim das 21:05 (grupo). null = não incluir (desligado ou erro). */
  async secaoBoletim(): Promise<string | null> {
    const cfg = await this.getConfig();
    if (!cfg.incluir_no_boletim) return null;
    try {
      return (await this.montarResumo()).texto;
    } catch (e: any) {
      this.logger.error(`Resumo de comunicação p/ boletim falhou: ${e?.message}`);
      return null;   // boletim de geração sai mesmo assim
    }
  }

  async montarResumo(): Promise<{ texto: string; abertos: number; normalizados: number; html: string }> {
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT TRIM(l.equipamento_id) AS equipamento_id, l.mensagem, l.created_at, l.resolvido_em, l.dados_snapshot AS s,
             TRIM(p.nome) AS planta, TRIM(u.nome) AS unidade
      FROM logs_mqtt l
      JOIN equipamentos e ON e.id = l.equipamento_id
      JOIN unidades u ON u.id = e.unidade_id
      JOIN plantas p ON p.id = u.planta_id
      WHERE l.tipo = 'alerta' AND (l.dados_snapshot->>'origem') = 'comunicacao'
        AND (l.resolvido_em IS NULL OR l.resolvido_em >= now() - interval '24 hours')
        AND COALESCE(u.status, 'ativo') <> 'inativo'
        AND NOT EXISTS (SELECT 1 FROM alarme_comunicacao_unidade au WHERE au.unidade_id = u.id)
      ORDER BY p.nome, l.created_at`;
    const agora = new Date();
    const b = brt(agora);
    const inicioDia = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) + 3 * 3600_000); // 00:00 BRT
    const hhmmBrt = (d: Date) => { const x = brt(d); return `${String(x.getUTCHours()).padStart(2, '0')}:${String(x.getUTCMinutes()).padStart(2, '0')}`; };
    // "TON" sozinho não identifica qual: acrescenta a unidade.
    const nome = (r: any) => { const n = String(r.mensagem).replace(/ sem comunicação$/, ''); return /^TON\d*$/i.test(n) && r.unidade ? `${n} ${r.unidade}` : n; };
    const afeta = (s: any) => (Array.isArray(s.afetados) && s.afetados.length ? ` (+${s.afetados.length} equip. ligados a ela)` : '');
    const osc = (s: any) => (s.oscilacoes ? ` · oscilou ${s.oscilacoes}×` : '');
    const desdeDe = (r: any): Date => (r.s?.desde ? new Date(r.s.desde) : new Date(new Date(r.created_at).getTime() - Number(r.s?.limiar_min || 0) * 60000));

    const caiuHoje: any[] = [], voltou: any[] = [], antigos: any[] = [];
    for (const r of rows) {
      const desde = desdeDe(r);
      if (r.resolvido_em) {
        // 'silencioso' só calou o e-mail da abertura; no fechamento do dia a volta aparece.
        if (new Date(r.resolvido_em) >= inicioDia && !r.s?.absorvido_pela_ton && !r.s?.unidade_desativada && !r.s?.descartado) voltou.push({ ...r, desde });
      } else if (desde >= inicioDia) caiuHoje.push({ ...r, desde });
      else antigos.push({ ...r, desde });
    }
    const porPlanta = (lista: any[], linha: (r: any) => string) => {
      const out: string[] = []; let planta = '';
      for (const r of lista) {
        if (r.planta !== planta) { planta = r.planta; out.push(`*${planta}*`); }
        out.push(linha(r));
      }
      return out;
    };

    const quando = `${String(b.getUTCDate()).padStart(2, '0')}/${String(b.getUTCMonth() + 1).padStart(2, '0')}`;
    const linhas: string[] = [`📡 *Comunicação — fechamento de ${quando}*`];
    if (!caiuHoje.length && !voltou.length) linhas.push('', '✅ Nenhuma queda de comunicação hoje.');
    if (caiuHoje.length) {
      linhas.push('', `🔴 *Caíram hoje e continuam fora (${caiuHoje.length})*`);
      linhas.push(...porPlanta(caiuHoje, (r) => `• ${nome(r)}${afeta(r.s)} — desde ${hhmmBrt(r.desde)} (${fmtDur((agora.getTime() - r.desde.getTime()) / 60000)})${osc(r.s)}`));
    }
    if (voltou.length) {
      // várias quedas do mesmo equipamento no dia viram UMA linha (vezes + tempo total fora)
      const porEquip = new Map<string, any>();
      for (const r of voltou) {
        const fim = r.s?.volta_em ? new Date(r.s.volta_em) : new Date(r.resolvido_em);
        const g = porEquip.get(r.equipamento_id);
        const min = Math.max(0, (fim.getTime() - r.desde.getTime()) / 60000);
        if (!g) porEquip.set(r.equipamento_id, { ...r, fim, vezes: 1 + Number(r.s?.oscilacoes || 0), totalMin: min });
        else {
          g.vezes += 1 + Number(r.s?.oscilacoes || 0); g.totalMin += min;
          if (r.desde < g.desde) g.desde = r.desde;
          if (fim > g.fim) g.fim = fim;
        }
      }
      const agrupados = [...porEquip.values()].sort((a, b) => a.planta.localeCompare(b.planta) || a.desde - b.desde);
      linhas.push('', `🟡 *Caíram e voltaram (${agrupados.length})*`);
      linhas.push(...porPlanta(agrupados, (g) => g.vezes > 1
        ? `• ${nome(g)} — caiu ${g.vezes}× · ${fmtDur(g.totalMin)} fora no total (${hhmmBrt(g.desde)}–${hhmmBrt(g.fim)})`
        : `• ${nome(g)} — fora ${fmtDur(g.totalMin)} (${hhmmBrt(g.desde)}–${hhmmBrt(g.fim)})`));
    }
    if (antigos.length) {
      linhas.push('', `⚫ *Fora há mais de 1 dia (${antigos.length})*`);
      const grupos = new Map<string, any[]>();
      for (const r of antigos) grupos.set(r.planta, [...(grupos.get(r.planta) ?? []), r]);
      for (const [planta, lista] of grupos) {
        linhas.push(`• ${planta}: ${lista.map((r) => `${nome(r)} (${fmtDur((agora.getTime() - r.desde.getTime()) / 60000)})`).join(', ')}`);
      }
    }
    const texto = linhas.join('\n');
    const html = `<pre style="font-family:Arial,sans-serif;white-space:pre-wrap;font-size:14px">${esc(texto.replace(/\*/g, ''))}</pre>`;
    return { texto, abertos: caiuHoje.length + antigos.length, normalizados: voltou.length, html };
  }

  private async grupoJid(cfg: ConfigAlarmes): Promise<string | null> {
    if (cfg.grupo_jid) return cfg.grupo_jid;
    const r = await this.prisma.$queryRaw<Array<{ grupo_jid: string | null }>>`
      SELECT grupo_jid FROM notificacao_envio_config ORDER BY id LIMIT 1`.catch(() => []);
    return r[0]?.grupo_jid ?? null;
  }

  /** Envia o resumo (WhatsApp no grupo + e-mail aos admins). dryRun só monta. */
  async enviarResumo(dryRun: boolean) {
    const cfg = await this.getConfig();
    const r = await this.montarResumo();
    const out: Record<string, any> = { texto: r.texto, abertos: r.abertos, normalizados: r.normalizados, dryRun };
    if (dryRun) return out;
    if (cfg.resumo_whatsapp) {
      const jid = await this.grupoJid(cfg);
      if (jid) {
        try { await this.whats.enviarParaGrupo(jid, r.texto); out.whatsapp = 'ok'; }
        catch (e: any) { out.whatsapp = `erro: ${e?.message || e}`; this.logger.error(`Resumo WhatsApp falhou: ${e?.message}`); }
      } else out.whatsapp = 'sem grupo configurado';
    }
    if (cfg.resumo_email) {
      const tr = this.transporter();
      const destinos = await this.destinos();
      const admins = [...destinos.entries()].filter(([, p]) => p === null).map(([e]) => e);
      if (tr && admins.length) {
        try {
          await tr.sendMail({
            from: `"NexON Alarmes" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
            to: admins.join(', '),
            subject: r.abertos ? `📡 Resumo: ${r.abertos} sem comunicação` : '📡 Resumo: todos comunicando',
            html: r.html,
          });
          out.email = 'ok';
        } catch (e: any) { out.email = `erro: ${e?.message}`; }
      }
    }
    return out;
  }

  private async talvezResumo(cfg: ConfigAlarmes) {
    if (cfg.incluir_no_boletim) return;   // já vai dentro do boletim das 21:05
    if (!cfg.resumo_whatsapp && !cfg.resumo_email) return;
    const hoje = dataBrt();
    if (cfg.ultimo_resumo_data === hoje) return;
    if (minutosBrt() < hhmm(cfg.resumo_hora)) return;
    await this.prisma.$executeRaw`UPDATE alarme_comunicacao_config SET ultimo_resumo_data = ${hoje}::date WHERE id = 'default'`;
    const r = await this.enviarResumo(false);
    this.logger.log(`Resumo diário enviado: ${r.abertos} aberto(s) · whatsapp=${r.whatsapp ?? '-'} · email=${r.email ?? '-'}`);
  }
}
