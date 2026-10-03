import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService, Prisma } from '@/core';
import { WhatsappService } from './whatsapp.service';

export interface EnvioConfig {
  ativo: boolean;
  horario: string;
  grupo_jid: string | null;
  enviar_grupo: boolean;
  enviar_individual: boolean;
  ultimo_envio_data: string | null;
}

export interface DestinatarioAgrupado {
  telefone: string;
  nome: string;
  unidade_ids: string[];
}

export interface AlvoResult {
  destino: string;
  tipo: 'grupo' | 'numero';
  nome?: string;
  status: 'ok' | 'erro' | 'dry_run' | 'sem_dados';
  texto?: string;
  erro?: string;
}

export interface DispatchResult {
  data: string;
  dryRun: boolean;
  ativo: boolean;
  alvos: AlvoResult[];
}

const CFG_ID = 'cfgdefault0000000000000000';

export type Confianca = 'alta' | 'media' | 'baixa';
export interface LinhaGeracao {
  unidade_id: string;
  nome: string;
  kwh_realizado: number;
  kwh_previsto: number;
  fonte: 'api' | 'ton' | 'manual' | 'bdo';
  confianca: Confianca;
  motivo: string;
}

/**
 * Dispatcher do boletim diário de geração via WhatsApp — migrado do bdo-aupus-api pro NexON.
 * Lê a config de `notificacao_envio_config`, os destinatários de `notificacao_destinatarios`,
 * e os dados JÁ CORRIGIDOS de `geracao_diaria_plantas` (origem manual>bdo>ton>nuvem).
 * Toda tentativa é auditada em `notificacao_envios`.
 *
 * ⚠️ Envio real só quando `config.ativo=true` (cron) OU trigger manual com dryRun=false
 * explícito. dryRun é o default em toda chamada manual.
 */
@Injectable()
export class NotificacaoDispatcherService {
  private readonly logger = new Logger(NotificacaoDispatcherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whats: WhatsappService,
  ) {}

  async getConfig(): Promise<EnvioConfig> {
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT ativo, horario, grupo_jid, enviar_grupo, enviar_individual,
             to_char(ultimo_envio_data, 'YYYY-MM-DD') AS ultimo_envio_data
      FROM notificacao_envio_config WHERE id = ${CFG_ID} LIMIT 1
    `;
    const r = rows[0] ?? {};
    return {
      ativo: !!r.ativo,
      horario: r.horario ?? '21:05',
      grupo_jid: r.grupo_jid ?? null,
      enviar_grupo: r.enviar_grupo !== false,
      enviar_individual: r.enviar_individual !== false,
      ultimo_envio_data: r.ultimo_envio_data ?? null,
    };
  }

  /** Destinatários ativos agrupados por número: cada número recebe UMA mensagem com as
   *  usinas às quais está vinculado (com dados). Usina sem destinatário não é enviada. */
  async destinatariosAtivos(): Promise<DestinatarioAgrupado[]> {
    return this.prisma.$queryRaw<DestinatarioAgrupado[]>`
      SELECT telefone,
             MIN(nome) AS nome,
             array_agg(DISTINCT TRIM(unidade_id)) AS unidade_ids
      FROM notificacao_destinatarios
      WHERE ativo = true AND COALESCE(TRIM(unidade_id), '') <> ''
      GROUP BY telefone
      ORDER BY telefone
    `;
  }

  /**
   * Monta o texto do boletim das usinas informadas (ou todas, se null) para a data.
   * Só usinas com geração > 0. Retorna null se nenhuma tem dados.
   */

  /** Saudacao pelo horario de SP (o boletim sai ~21h, mas envio manual pode ser a qualquer hora). */
  private saudacao(): string {
    const h = Number(
      new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).format(new Date()),
    );
    if (h < 12) return 'Bom dia';
    if (h < 18) return 'Boa tarde';
    return 'Boa noite';
  }

  /**
   * Texto do boletim INDIVIDUAL — vai para o DONO da usina, nao para um grupo tecnico.
   * Por isso tem saudacao, trata "sua usina" e explicita a meta em kWh (no grupo, todo
   * mundo ja' conhece o contexto e a lista e' longa; aqui e' uma pessoa so').
   */
  async montarTextoIndividual(
    data: string,
    unidadeIds: string[] | null,
    nome?: string | null,
  ): Promise<string | null> {
    const rows = await this.linhasGeracao(data, unidadeIds);
    if (!rows.length) return null;

    const dataBR = data.split('-').reverse().join('/');
    // Sem nome na saudacao: o cadastro nem sempre traz o nome do dono (as vezes e' o
    // contato), e errar o nome de cliente e' pior do que nao usar nenhum.
    const ola = `${this.saudacao()}!`;
    const plural = rows.length > 1;

    const linhas = rows.map((r) => {
      const real = Number(r.kwh_realizado) || 0;
      // Meta NAO vai na mensagem: ela e' referencia interna, conferida pelo NexON.
      // Confiança: o dono só vê o aviso quando o número é PARCIAL/duvidoso (baixa).
      const aviso = r.confianca === 'baixa'
        ? `\n   ⚠️ _Valor parcial: houve falha de comunicação com parte da usina neste dia._`
        : '';
      return `☀️ *${r.nome}*\n   Geração: *${this.fmtKwh(real)} kWh*${aviso}`;
    });

    const total = rows.reduce((s, r) => s + (Number(r.kwh_realizado) || 0), 0);
    const rodapeTotal = plural ? `\n\n*Total do dia:* ${this.fmtKwh(total)} kWh` : '';

    return (
      `${ola}\n\n` +
      `Segue a geração ${plural ? 'das suas usinas' : 'da sua usina'} em ${dataBR}:\n\n` +
      `${linhas.join('\n\n')}${rodapeTotal}\n\n` +
      `_Aupus Energia_`
    );
  }

  /**
   * Geração consolidada do dia por usina, COM ou SEM API, e a CONFIANÇA do número.
   *
   * Fontes: (1) `geracao_diaria_plantas` — API do fabricante (origem nuvem), BDO ou manual;
   * (2) o BROKER — leituras das TONs em `equipamentos_dados` (daily_yield de cada inversor).
   * Usinas sem API (só TON) passam a entrar no boletim; com as duas fontes, uma confere a outra.
   *
   * Valor: manual/BDO vence; senão API; API ausente/zerada → valor do broker.
   * Confiança: alta = 2 fontes batem (≤10%) ou conferido à mão; media = 1 fonte completa;
   * baixa = dado incompleto (inversor faltando / leitura parada antes das 17h) ou fontes divergentes.
   * Broker: deduplica por TÓPICO (cadastro duplicado no mesmo tópico contava 2×) e só lê de 04h
   * em diante (evita total de ontem em inversor que zera tarde). Timestamps em UTC naive.
   */
  private async linhasGeracao(data: string, unidadeIds: string[] | null): Promise<LinhaGeracao[]> {
    const ids = unidadeIds && unidadeIds.length ? unidadeIds.map((i) => i.trim()) : null;
    const filtroG = ids ? Prisma.sql`AND TRIM(g.unidade_id) IN (${Prisma.join(ids)})` : Prisma.empty;
    const filtroE = ids ? Prisma.sql`AND TRIM(e.unidade_id) IN (${Prisma.join(ids)})` : Prisma.empty;

    const regs = await this.prisma.$queryRaw<
      Array<{ unidade_id: string; nome: string; kwh: number; previsto: number; origem: string | null }>
    >`
      SELECT TRIM(g.unidade_id) AS unidade_id, TRIM(u.nome) AS nome,
             COALESCE(g.kwh_realizado, 0)::float8 AS kwh,
             COALESCE(g.kwh_previsto, 0)::float8 AS previsto,
             g.origem
      FROM geracao_diaria_plantas g
      JOIN unidades u ON TRIM(u.id) = TRIM(g.unidade_id) AND u.deleted_at IS NULL
      WHERE g.data = ${data}::date ${filtroG}
    `;

    const ton = await this.prisma.$queryRaw<
      Array<{ unidade_id: string; nome: string; inv: number; esperado: number; kwh: number;
              ult_min: Date; dup: boolean; meta: number | null }>
    >`
      WITH leit AS (
        SELECT TRIM(e.unidade_id) AS unidade_id,
               COALESCE(NULLIF(TRIM(e.topico_mqtt), ''), TRIM(e.id)) AS chave,
               e.id AS equip, d.timestamp_dados AS ts,
               CASE WHEN (d.dados->'energy'->>'daily_yield') ~ '^[0-9]+(\.[0-9]+)?$'
                    THEN (d.dados->'energy'->>'daily_yield')::numeric END AS dy
        FROM equipamentos_dados d
        JOIN equipamentos e ON e.id = d.equipamento_id AND e.deleted_at IS NULL
        WHERE d.timestamp_dados >= (${data}::date - interval '6 days' + interval '3 hours')
          AND d.timestamp_dados <  (${data}::date + interval '27 hours')
          AND d.dados->'energy' ? 'daily_yield'
          AND COALESCE(d.qualidade, '') <> 'MOCK'
          ${filtroE}
      ),
      dia AS (
        SELECT unidade_id, chave, COUNT(DISTINCT equip) AS n_equip,
               MAX(LEAST(dy, 20000)) AS dy, MAX(ts) AS ult
        FROM leit
        WHERE ts >= (${data}::date + interval '7 hours')     -- 04:00 BRT
        GROUP BY unidade_id, chave
      ),
      vistos AS (                                            -- inversores vistos em 7 dias
        SELECT unidade_id, COUNT(DISTINCT chave)::int AS n FROM leit GROUP BY unidade_id
      ),
      no_diagrama AS (                                       -- inversores desenhados no IoT
        SELECT TRIM(p.unidade_id) AS unidade_id,
               COUNT(DISTINCT COALESCE(NULLIF(TRIM(c.equipamento_id), ''), c.props->>'equipamento_id', c.id))::int AS n
        FROM iot_componentes c JOIN iot_projetos p ON p.id = c.projeto_id AND p.deleted_at IS NULL
        WHERE c.tipo = 'inversor'
        GROUP BY TRIM(p.unidade_id)
      ),
      esperado AS (                                          -- o maior dos dois (inversor mudo há semanas some dos "vistos")
        SELECT v.unidade_id, GREATEST(v.n, COALESCE(nd.n, 0)) AS n
        FROM vistos v LEFT JOIN no_diagrama nd ON nd.unidade_id = v.unidade_id
      )
      SELECT dia.unidade_id, TRIM(u.nome) AS nome,
             COUNT(*)::int AS inv, MAX(es.n)::int AS esperado,
             COALESCE(SUM(dia.dy), 0)::float8 AS kwh, MIN(dia.ult) AS ult_min,
             BOOL_OR(dia.n_equip > 1) AS dup,
             MAX(c.predicao_diaria_kwh)::float8 AS meta
      FROM dia
      JOIN unidades u ON TRIM(u.id) = dia.unidade_id AND u.deleted_at IS NULL
      LEFT JOIN esperado es ON es.unidade_id = dia.unidade_id
      LEFT JOIN unidade_fv_config c ON TRIM(c.unidade_id) = dia.unidade_id
      GROUP BY dia.unidade_id, u.nome
    `;

    // 17:00 BRT do dia = 20:00 UTC naive
    const fimSol = new Date(`${data}T20:00:00Z`).getTime();
    const hhmm = (d: Date) => {
      const t = new Date(new Date(d).getTime() - 3 * 3600_000);
      return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
    };
    const fmt = (v: number) => this.fmtKwh(v);
    const porUnidade = new Map<string, LinhaGeracao>();
    const tonPor = new Map(ton.map((t) => [t.unidade_id, t]));
    const regPor = new Map(regs.map((r) => [r.unidade_id, r]));
    const unidades = new Set<string>([...regPor.keys(), ...tonPor.keys()]);

    for (const uid of unidades) {
      const r = regPor.get(uid);
      const t = tonPor.get(uid);
      const tonKwh = t ? Number(t.kwh) || 0 : 0;
      const tonOk = tonKwh > 0;
      const faltaInv = t && t.esperado > t.inv ? `${t.inv}/${t.esperado} inversores` : '';
      const parou = t && new Date(t.ult_min).getTime() < fimSol ? `leitura até ${hhmm(t.ult_min)}` : '';
      const parcial = [faltaInv, parou].filter(Boolean).join(', ');
      const tonCompleto = tonOk && !parcial;
      const dup = t?.dup ? ' · ⚠️ inversor cadastrado 2×' : '';
      const nome = r?.nome ?? t?.nome ?? uid;
      const origem = (r?.origem ?? 'nuvem').toLowerCase();
      const apiKwh = r ? Number(r.kwh) || 0 : 0;
      const previsto = r && Number(r.previsto) > 0 ? Number(r.previsto) : Number(t?.meta) || 0;
      let linha: LinhaGeracao | null = null;

      if (r && apiKwh > 0 && (origem === 'manual' || origem === 'bdo')) {
        linha = { unidade_id: uid, nome, kwh_realizado: apiKwh, kwh_previsto: previsto, fonte: origem as any,
          confianca: 'alta', motivo: origem === 'manual' ? 'conferido manualmente' : 'conferido no BDO' };
      } else if (r && apiKwh > 0) {
        if (tonCompleto) {
          const diff = Math.abs(apiKwh - tonKwh) / Math.max(apiKwh, tonKwh);
          const pct = Math.round(diff * 100);
          linha = { unidade_id: uid, nome, kwh_realizado: apiKwh, kwh_previsto: previsto, fonte: 'api',
            confianca: diff <= 0.1 ? 'alta' : diff <= 0.3 ? 'media' : 'baixa',
            motivo: diff <= 0.1 ? 'API e TON batem' : `API ${fmt(apiKwh)} × TON ${fmt(tonKwh)} kWh (${pct}%)` };
        } else {
          linha = { unidade_id: uid, nome, kwh_realizado: apiKwh, kwh_previsto: previsto, fonte: 'api',
            confianca: 'media', motivo: tonOk ? `só API (TON parcial: ${parcial})` : 'só API' };
        }
      } else if (tonOk) {
        const semApi = r ? 'API sem dado' : 'sem API';
        linha = { unidade_id: uid, nome, kwh_realizado: tonKwh, kwh_previsto: previsto, fonte: 'ton',
          confianca: tonCompleto ? 'media' : 'baixa',
          motivo: tonCompleto ? `via TON (${semApi})` : `via TON, parcial: ${parcial} (${semApi})` };
      }
      if (linha) { linha.motivo += dup; porUnidade.set(uid, linha); }
    }
    return [...porUnidade.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  }

  private static readonly ICONE: Record<Confianca, string> = { alta: '🟢', media: '🟡', baixa: '🔴' };

  /** Texto do boletim do GRUPO — lista compacta, publico ja' familiarizado. */
  async montarTexto(data: string, unidadeIds: string[] | null): Promise<string | null> {
    const rows = await this.linhasGeracao(data, unidadeIds);
    if (!rows.length) return null;
    const dataBR = data.split('-').reverse().join('/');
    const linhas = rows.map((r) => {
      const real = Number(r.kwh_realizado) || 0;
      // Grupo (publico interno/tecnico) MOSTRA a meta e a CONFIANÇA. O individual (dono) NAO mostra meta.
      const prev = Number(r.kwh_previsto) || 0;
      const pct = prev > 0 ? Math.round((real / prev) * 100) : null;
      const pctTxt = pct != null ? ` (${pct}% da meta)` : '';
      return `${NotificacaoDispatcherService.ICONE[r.confianca]} *${r.nome}*: ${this.fmtKwh(real)} kWh${pctTxt}\n      _${r.motivo}_`;
    });
    const total = rows.reduce((s, r) => s + (Number(r.kwh_realizado) || 0), 0);
    const legenda = '🟢 2 fontes batem ou conferido · 🟡 1 fonte · 🔴 incompleto ou divergente';
    return `📊 *Boletim de Geração* — ${dataBR}\n\n${linhas.join('\n')}\n\n*Total:* ${this.fmtKwh(total)} kWh\n\n_Confiança do dado: ${legenda}_`;
  }

  private fmtKwh(v: number): string {
    return v.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 1 });
  }

  /** Executa o disparo. dryRun=true (default) monta e audita, mas NÃO envia. */
  async dispatch(
    data: string,
    opts: { dryRun?: boolean; phones?: string[] } = {},
  ): Promise<DispatchResult> {
    const dryRun = opts.dryRun !== false;
    const cfg = await this.getConfig();
    const alvos: AlvoResult[] = [];

    // 1) Grupo (todas as usinas)
    if (cfg.enviar_grupo && cfg.grupo_jid) {
      const texto = await this.montarTexto(data, null);
      if (!texto) {
        alvos.push({ destino: cfg.grupo_jid, tipo: 'grupo', status: 'sem_dados' });
      } else if (dryRun) {
        alvos.push({ destino: cfg.grupo_jid, tipo: 'grupo', status: 'dry_run', texto });
      } else {
        try {
          await this.whats.enviarParaGrupo(cfg.grupo_jid, texto);
          alvos.push({ destino: cfg.grupo_jid, tipo: 'grupo', status: 'ok', texto });
        } catch (e: any) {
          alvos.push({ destino: cfg.grupo_jid, tipo: 'grupo', status: 'erro', texto, erro: String(e?.message || e) });
        }
      }
    }

    // 2) Individuais (por número, só as usinas vinculadas a ele)
    if (cfg.enviar_individual) {
      const dests = await this.destinatariosAtivos();
      for (const d of dests) {
        if (opts.phones && !opts.phones.includes(d.telefone)) continue;
        const texto = await this.montarTextoIndividual(data, d.unidade_ids ?? [], d.nome);
        if (!texto) {
          alvos.push({ destino: d.telefone, tipo: 'numero', nome: d.nome, status: 'sem_dados' });
          continue;
        }
        if (dryRun) {
          alvos.push({ destino: d.telefone, tipo: 'numero', nome: d.nome, status: 'dry_run', texto });
        } else {
          try {
            await this.whats.enviarParaNumero(d.telefone, texto, d.nome);
            alvos.push({ destino: d.telefone, tipo: 'numero', nome: d.nome, status: 'ok', texto });
          } catch (e: any) {
            alvos.push({ destino: d.telefone, tipo: 'numero', nome: d.nome, status: 'erro', texto, erro: String(e?.message || e) });
          }
        }
      }
    }

    // Auditoria (só envios reais e erros; dry_run também registra p/ histórico de preview)
    for (const a of alvos) {
      await this.logEnvio(data, a);
    }
    return { data, dryRun, ativo: cfg.ativo, alvos };
  }

  private async logEnvio(data: string, a: AlvoResult): Promise<void> {
    const id = randomBytes(13).toString('hex');
    await this.prisma.$executeRaw`
      INSERT INTO notificacao_envios
        (id, tipo_id, destino, tipo_destino, status, texto, erro, ref_data, enviado_em)
      VALUES (${id}, 'boletim_diario', ${a.destino}, ${a.tipo}, ${a.status},
              ${a.texto ?? null}, ${a.erro ?? null}, ${data}::date, now())
    `;
  }

  async marcarUltimoEnvio(data: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE notificacao_envio_config SET ultimo_envio_data = ${data}::date, updated_at = now()
      WHERE id = ${CFG_ID}
    `;
  }
}
