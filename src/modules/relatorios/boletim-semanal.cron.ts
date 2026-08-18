import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BoletimSemanalEnvioService } from './boletim-semanal-envio.service';

/**
 * Cron do boletim SEMANAL. Roda a cada minuto e dispara UMA vez no dia_semana +
 * horário configurados (SP), guardado por `ultimo_envio`. Só envia com `ativo=true`
 * (nasce false). Enquanto false, é no-op.
 */
@Injectable()
export class BoletimSemanalCron {
  private readonly logger = new Logger(BoletimSemanalCron.name);

  constructor(private readonly envio: BoletimSemanalEnvioService) {}

  @Cron('0 * * * * *', { timeZone: 'America/Sao_Paulo' })
  async tick(): Promise<void> {
    let cfg;
    try {
      cfg = await this.envio.getConfig();
    } catch {
      return;
    }
    if (!cfg.ativo) return;

    const { hhmm, hoje, isodow } = this.agoraSP();
    if (cfg.horario !== hhmm) return;
    if (isodow !== cfg.dia_semana) return;
    if (cfg.ultimo_envio === hoje) return;

    await this.envio.marcarUltimoEnvio(hoje); // marca ANTES (evita duplo-disparo)
    this.logger.log(`[boletim-semanal-cron] ${hoje} ${hhmm} (dia ISO ${isodow}) — disparando envio real`);
    try {
      const r = await this.envio.disparar(undefined, { dryRun: false });
      const ok = r.alvos.filter((a) => a.status === 'ok').length;
      const err = r.alvos.filter((a) => a.status === 'erro').length;
      this.logger.log(`[boletim-semanal-cron] concluído: ok=${ok} erro=${err} total=${r.alvos.length}`);
    } catch (e: any) {
      this.logger.error(`[boletim-semanal-cron] fatal: ${e?.stack || e?.message}`);
    }
  }

  private agoraSP(): { hhmm: string; hoje: string; isodow: number } {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
    const hh = g('hour') === '24' ? '00' : g('hour');
    const hoje = `${g('year')}-${g('month')}-${g('day')}`;
    const [y, m, d] = hoje.split('-').map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=dom..6=sáb
    const isodow = dow === 0 ? 7 : dow; // ISO: 1=seg..7=dom
    return { hhmm: `${hh}:${g('minute')}`, hoje, isodow };
  }
}
