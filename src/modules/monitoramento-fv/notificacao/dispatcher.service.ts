import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService, Prisma } from '@aupus/api-shared';
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
      return `☀️ *${r.nome}*\n   Geração: *${this.fmtKwh(real)} kWh*`;
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

  /** Linhas de geracao (>0) do dia, opcionalmente filtradas por unidade. Base dos dois textos. */
  private async linhasGeracao(data: string, unidadeIds: string[] | null) {
    const filtro =
      unidadeIds && unidadeIds.length
        ? Prisma.sql`AND TRIM(g.unidade_id) IN (${Prisma.join(unidadeIds.map((i) => i.trim()))})`
        : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      Array<{ nome: string; kwh_realizado: number; kwh_previsto: number }>
    >`
      SELECT TRIM(u.nome) AS nome,
             COALESCE(g.kwh_realizado, 0)::float8 AS kwh_realizado,
             COALESCE(g.kwh_previsto, 0)::float8 AS kwh_previsto
      FROM geracao_diaria_plantas g
      JOIN unidades u ON TRIM(u.id) = TRIM(g.unidade_id) AND u.deleted_at IS NULL
      WHERE g.data = ${data}::date
        AND COALESCE(g.kwh_realizado, 0) > 0
        ${filtro}
      ORDER BY u.nome
    `;
    return rows;
  }

  /** Texto do boletim do GRUPO — lista compacta, publico ja' familiarizado. */
  async montarTexto(data: string, unidadeIds: string[] | null): Promise<string | null> {
    const rows = await this.linhasGeracao(data, unidadeIds);
    if (!rows.length) return null;
    const dataBR = data.split('-').reverse().join('/');
    const linhas = rows.map((r) => {
      const real = Number(r.kwh_realizado) || 0;
      // Grupo (publico interno/tecnico) MOSTRA a meta. O individual (dono da usina) NAO.
      const prev = Number(r.kwh_previsto) || 0;
      const pct = prev > 0 ? Math.round((real / prev) * 100) : null;
      const pctTxt = pct != null ? ` (${pct}% da meta)` : '';
      return `☀️ *${r.nome}*: ${this.fmtKwh(real)} kWh${pctTxt}`;
    });
    const total = rows.reduce((s, r) => s + (Number(r.kwh_realizado) || 0), 0);
    return `📊 *Boletim de Geração* — ${dataBR}\n\n${linhas.join('\n')}\n\n*Total:* ${this.fmtKwh(total)} kWh`;
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
