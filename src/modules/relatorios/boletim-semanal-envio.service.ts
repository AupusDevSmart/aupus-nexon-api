import { Injectable, Logger } from '@nestjs/common';
import { createHmac, randomBytes } from 'node:crypto';
import { PrismaService } from '@/core';
import { WhatsappService } from '../monitoramento-fv/notificacao/whatsapp.service';

const CFG_ID = 'bolsemdefault0000000000000';

export interface BoletimSemanalConfig {
  ativo: boolean;
  dia_semana: number; // 1=seg ... 7=dom (ISO)
  horario: string; // HH:MM (SP)
  grupo_jid: string | null;
  enviar_grupo: boolean;
  enviar_individual: boolean;
  ultimo_envio: string | null;
}

export interface AlvoSemanal {
  destino: string;
  tipo: 'grupo' | 'numero';
  nome?: string;
  status: 'ok' | 'erro' | 'dry_run' | 'sem_dados';
  texto?: string;
  erro?: string;
}

/**
 * Config + disparo do boletim SEMANAL. Reusa os destinatários do envio diário
 * (`notificacao_destinatarios`) e o `WhatsappService`. O WhatsApp só manda TEXTO,
 * então enviamos o LINK do PDF (endpoint público tokenizado). ⚠️ Envio real só com
 * `ativo=true` (cron) OU dryRun=false explícito.
 */
@Injectable()
export class BoletimSemanalEnvioService {
  private readonly logger = new Logger(BoletimSemanalEnvioService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whats: WhatsappService,
  ) {}

  async getConfig(): Promise<BoletimSemanalConfig> {
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT ativo, dia_semana, horario, grupo_jid, enviar_grupo, enviar_individual,
             to_char(ultimo_envio, 'YYYY-MM-DD') AS ultimo_envio
      FROM boletim_semanal_config WHERE id = ${CFG_ID} LIMIT 1
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

  async updateConfig(patch: Partial<BoletimSemanalConfig>): Promise<BoletimSemanalConfig> {
    const c = { ...(await this.getConfig()), ...patch };
    await this.prisma.$executeRaw`
      UPDATE boletim_semanal_config SET
        ativo = ${c.ativo}, dia_semana = ${c.dia_semana}, horario = ${c.horario},
        grupo_jid = ${c.grupo_jid}, enviar_grupo = ${c.enviar_grupo},
        enviar_individual = ${c.enviar_individual}, updated_at = now()
      WHERE id = ${CFG_ID}
    `;
    return this.getConfig();
  }

  async marcarUltimoEnvio(dateStr: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE boletim_semanal_config SET ultimo_envio = ${dateStr}::date, updated_at = now() WHERE id = ${CFG_ID}
    `;
  }

  // ===== Token do link público do PDF =====
  private secret(): string {
    return process.env.RELATORIO_TOKEN_SECRET || process.env.JWT_SECRET || 'aupus-boletim-semanal';
  }
  private baseUrl(): string {
    return (
      process.env.BOLETIM_PDF_BASE_URL ||
      'https://aupus-nexon-api.aupusenergia.com.br/api/v1/relatorios/semanal/pdf'
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
      `📊 *Boletim Semanal da Operação* — Aupus Energia\n\n` +
      `Segue o relatório da semana ${dono ? 'da(s) sua(s) usina(s)' : 'das usinas'} (PDF):\n\n` +
      `${linhas.join('\n\n')}\n\n_Toque no link para abrir o PDF. Aupus Energia._`
    );
  }

  /** Dispara o boletim semanal. dryRun=true (default) monta os links/texto mas NÃO envia. */
  async disparar(dataRef: string | undefined, opts: { dryRun?: boolean } = {}): Promise<{ dryRun: boolean; ativo: boolean; alvos: AlvoSemanal[] }> {
    const dryRun = opts.dryRun !== false;
    const cfg = await this.getConfig();
    const alvos: AlvoSemanal[] = [];

    if (cfg.enviar_individual) {
      const dests = await this.prisma.$queryRaw<Array<{ telefone: string; nome: string; unidade_ids: string[] }>>`
        SELECT telefone, MIN(nome) AS nome, array_agg(DISTINCT TRIM(unidade_id)) AS unidade_ids
        FROM notificacao_destinatarios
        WHERE ativo = true AND COALESCE(TRIM(unidade_id), '') <> ''
        GROUP BY telefone ORDER BY telefone
      `;
      for (const d of dests) {
        const us = await this.nomesUnidades(d.unidade_ids ?? []);
        if (!us.length) {
          alvos.push({ destino: d.telefone, tipo: 'numero', nome: d.nome, status: 'sem_dados' });
          continue;
        }
        const texto = this.textoBoletim(us, dataRef, true);
        alvos.push(await this.entregar('numero', d.telefone, texto, dryRun, d.nome));
      }
    }

    if (cfg.enviar_grupo && cfg.grupo_jid) {
      const us = await this.prisma.$queryRaw<Array<{ id: string; nome: string }>>`
        SELECT TRIM(c.unidade_id) AS id, TRIM(u.nome) AS nome
        FROM unidade_fv_config c JOIN unidades u ON TRIM(u.id) = TRIM(c.unidade_id) AND u.deleted_at IS NULL
        ORDER BY u.nome
      `;
      if (!us.length) {
        alvos.push({ destino: cfg.grupo_jid, tipo: 'grupo', status: 'sem_dados' });
      } else {
        const texto = this.textoBoletim(us, dataRef, false);
        alvos.push(await this.entregar('grupo', cfg.grupo_jid, texto, dryRun));
      }
    }

    // Auditoria (reusa notificacao_envios, tipo boletim_semanal)
    for (const a of alvos) await this.audit(dataRef, a);
    return { dryRun, ativo: cfg.ativo, alvos };
  }

  private async entregar(tipo: 'numero' | 'grupo', destino: string, texto: string, dryRun: boolean, nome?: string): Promise<AlvoSemanal> {
    if (dryRun) return { destino, tipo, nome, status: 'dry_run', texto };
    try {
      if (tipo === 'grupo') await this.whats.enviarParaGrupo(destino, texto);
      else await this.whats.enviarParaNumero(destino, texto, nome);
      return { destino, tipo, nome, status: 'ok', texto };
    } catch (e: any) {
      return { destino, tipo, nome, status: 'erro', texto, erro: String(e?.message || e) };
    }
  }

  private async audit(dataRef: string | undefined, a: AlvoSemanal): Promise<void> {
    try {
      const id = randomBytes(13).toString('hex');
      await this.prisma.$executeRaw`
        INSERT INTO notificacao_envios (id, tipo_id, destino, tipo_destino, status, texto, erro, ref_data, enviado_em)
        VALUES (${id}, 'boletim_semanal', ${a.destino}, ${a.tipo}, ${a.status}, ${a.texto ?? null}, ${a.erro ?? null}, ${dataRef ? `${dataRef}` : null}::date, now())
      `;
    } catch (e: any) {
      this.logger.warn(`[boletim-semanal] auditoria falhou: ${e?.message || e}`);
    }
  }
}
