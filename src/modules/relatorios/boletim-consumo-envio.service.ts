import { Injectable, Logger } from '@nestjs/common';
import { createHmac, randomBytes } from 'node:crypto';
import { PrismaService } from '@aupus/api-shared';
import { WhatsappService } from '../monitoramento-fv/notificacao/whatsapp.service';
import { BoletimConsumoService } from './boletim-consumo.service';

const CFG_ID = 'bolconsdefault000000000000';

export interface BoletimConsumoConfig {
  ativo: boolean;
  dia_semana: number; // 1=seg ... 7=dom (ISO)
  horario: string; // HH:MM (SP)
  grupo_jid: string | null;
  enviar_grupo: boolean;
  enviar_individual: boolean;
  ultimo_envio: string | null;
}

export interface AlvoConsumo {
  destino: string;
  tipo: 'grupo' | 'numero';
  nome?: string;
  status: 'ok' | 'erro' | 'dry_run' | 'sem_dados';
  texto?: string;
  erro?: string;
}

/**
 * Config + disparo do Relatório de Gestão de Energia (CONSUMO). MESMO esquema do boletim
 * de geração ([[boletim-semanal-envio.service]]): reusa `notificacao_destinatarios` +
 * `WhatsappService`, envia o LINK do PDF (endpoint público tokenizado). Diferença: só
 * unidades MEDIDAS (têm medidor). ⚠️ Envio real só com `ativo=true` (cron) OU dryRun=false.
 */
@Injectable()
export class BoletimConsumoEnvioService {
  private readonly logger = new Logger(BoletimConsumoEnvioService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whats: WhatsappService,
    private readonly consumo: BoletimConsumoService,
  ) {}

  async getConfig(): Promise<BoletimConsumoConfig> {
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT ativo, dia_semana, horario, grupo_jid, enviar_grupo, enviar_individual,
             to_char(ultimo_envio, 'YYYY-MM-DD') AS ultimo_envio
      FROM boletim_consumo_config WHERE id = ${CFG_ID} LIMIT 1
    `;
    const r = rows[0] ?? {};
    return {
      ativo: !!r.ativo,
      dia_semana: Number(r.dia_semana) || 1,
      horario: r.horario ?? '07:00',
      grupo_jid: r.grupo_jid ?? null,
      enviar_grupo: !!r.enviar_grupo,
      enviar_individual: r.enviar_individual !== false,
      ultimo_envio: r.ultimo_envio ?? null,
    };
  }

  async updateConfig(patch: Partial<BoletimConsumoConfig>): Promise<BoletimConsumoConfig> {
    const c = { ...(await this.getConfig()), ...patch };
    await this.prisma.$executeRaw`
      UPDATE boletim_consumo_config SET
        ativo = ${c.ativo}, dia_semana = ${c.dia_semana}, horario = ${c.horario},
        grupo_jid = ${c.grupo_jid}, enviar_grupo = ${c.enviar_grupo},
        enviar_individual = ${c.enviar_individual}, updated_at = now()
      WHERE id = ${CFG_ID}
    `;
    return this.getConfig();
  }

  async marcarUltimoEnvio(dateStr: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE boletim_consumo_config SET ultimo_envio = ${dateStr}::date, updated_at = now() WHERE id = ${CFG_ID}
    `;
  }

  // ===== Token do link público do PDF =====
  private secret(): string {
    return process.env.RELATORIO_TOKEN_SECRET || process.env.JWT_SECRET || 'aupus-boletim-consumo';
  }
  private baseUrl(): string {
    return (
      process.env.BOLETIM_CONSUMO_PDF_BASE_URL ||
      'https://aupus-nexon-api.aupusenergia.com.br/api/v1/relatorios/consumo/pdf'
    );
  }
  signToken(unidadeId: string, dataRef?: string): string {
    const exp = Date.now() + 45 * 24 * 60 * 60 * 1000; // 45 dias
    const payload = Buffer.from(JSON.stringify({ u: unidadeId, d: dataRef || null, e: exp })).toString('base64url');
    const sig = createHmac('sha256', this.secret()).update(payload).digest('base64url');
    return `${payload}.${sig}`;
  }
  verifyToken(token: string): { u: string; d: string | null } | null {
    if (!token || !token.includes('.')) return null;
    const [payload, sig] = token.split('.');
    const expected = createHmac('sha256', this.secret()).update(payload).digest('base64url');
    if (sig !== expected) return null;
    try {
      const o = JSON.parse(Buffer.from(payload, 'base64url').toString());
      if (o.e && Date.now() > o.e) return null;
      return { u: o.u, d: o.d ?? null };
    } catch {
      return null;
    }
  }
  private link(unidadeId: string, dataRef?: string): string {
    return `${this.baseUrl()}?token=${this.signToken(unidadeId, dataRef)}`;
  }

  private async idsMedidas(): Promise<Set<string>> {
    const us = await this.consumo.listarUnidadesElegiveis();
    return new Set(us.map((u) => u.id.trim()));
  }

  private async nomesUnidades(ids: string[]): Promise<Array<{ id: string; nome: string }>> {
    if (!ids.length) return [];
    return this.prisma.$queryRaw<Array<{ id: string; nome: string }>>`
      SELECT TRIM(id) AS id, TRIM(nome) AS nome FROM unidades
      WHERE TRIM(id) = ANY(${ids}) AND deleted_at IS NULL ORDER BY nome
    `;
  }

  private textoBoletim(unidades: Array<{ id: string; nome: string }>, dataRef?: string, dono = true): string {
    const linhas = unidades.map((u) => `📄 *${u.nome}*\n${this.link(u.id, dataRef)}`);
    return (
      `⚡ *Relatório de Gestão de Energia* — Aupus Energia\n\n` +
      `Segue o relatório de consumo da semana ${dono ? 'da(s) sua(s) unidade(s)' : 'das unidades'} (PDF):\n\n` +
      `${linhas.join('\n\n')}\n\n_Toque no link para abrir o PDF. Aupus Energia._`
    );
  }

  /** Dispara o relatório de consumo. dryRun=true (default) monta os links/texto mas NÃO envia. */
  async disparar(dataRef: string | undefined, opts: { dryRun?: boolean } = {}): Promise<{ dryRun: boolean; ativo: boolean; alvos: AlvoConsumo[] }> {
    const dryRun = opts.dryRun !== false;
    const cfg = await this.getConfig();
    const medidas = await this.idsMedidas();
    const alvos: AlvoConsumo[] = [];

    if (cfg.enviar_individual) {
      const dests = await this.prisma.$queryRaw<Array<{ telefone: string; nome: string; unidade_ids: string[] }>>`
        SELECT telefone, MIN(nome) AS nome, array_agg(DISTINCT TRIM(unidade_id)) AS unidade_ids
        FROM notificacao_destinatarios
        WHERE ativo = true AND COALESCE(TRIM(unidade_id), '') <> ''
        GROUP BY telefone ORDER BY telefone
      `;
      for (const d of dests) {
        const ids = (d.unidade_ids ?? []).map((x) => (x ?? '').trim()).filter((x) => medidas.has(x));
        if (!ids.length) {
          alvos.push({ destino: d.telefone, tipo: 'numero', nome: d.nome, status: 'sem_dados' });
          continue;
        }
        const us = await this.nomesUnidades(ids);
        const texto = this.textoBoletim(us, dataRef, true);
        alvos.push(await this.entregar('numero', d.telefone, texto, dryRun, d.nome));
      }
    }

    if (cfg.enviar_grupo && cfg.grupo_jid) {
      const us = (await this.consumo.listarUnidadesElegiveis()).map((u) => ({ id: u.id, nome: u.nome }));
      if (!us.length) {
        alvos.push({ destino: cfg.grupo_jid, tipo: 'grupo', status: 'sem_dados' });
      } else {
        const texto = this.textoBoletim(us, dataRef, false);
        alvos.push(await this.entregar('grupo', cfg.grupo_jid, texto, dryRun));
      }
    }

    for (const a of alvos) await this.audit(dataRef, a);
    return { dryRun, ativo: cfg.ativo, alvos };
  }

  private async entregar(tipo: 'numero' | 'grupo', destino: string, texto: string, dryRun: boolean, nome?: string): Promise<AlvoConsumo> {
    if (dryRun) return { destino, tipo, nome, status: 'dry_run', texto };
    try {
      if (tipo === 'grupo') await this.whats.enviarParaGrupo(destino, texto);
      else await this.whats.enviarParaNumero(destino, texto, nome);
      return { destino, tipo, nome, status: 'ok', texto };
    } catch (e: any) {
      return { destino, tipo, nome, status: 'erro', texto, erro: String(e?.message || e) };
    }
  }

  private async audit(dataRef: string | undefined, a: AlvoConsumo): Promise<void> {
    try {
      const id = randomBytes(13).toString('hex');
      await this.prisma.$executeRaw`
        INSERT INTO notificacao_envios (id, tipo_id, destino, tipo_destino, status, texto, erro, ref_data, enviado_em)
        VALUES (${id}, 'boletim_consumo', ${a.destino}, ${a.tipo}, ${a.status}, ${a.texto ?? null}, ${a.erro ?? null}, ${dataRef ? `${dataRef}` : null}::date, now())
      `;
    } catch (e: any) {
      this.logger.warn(`[boletim-consumo] auditoria falhou: ${e?.message || e}`);
    }
  }
}
