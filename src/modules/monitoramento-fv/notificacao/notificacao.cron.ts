import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NotificacaoDispatcherService } from './dispatcher.service';

/**
 * Cron do boletim diário no NexON (substitui o RelatorioCron do bdo-aupus-api).
 * Roda a cada minuto e dispara UMA vez no `horario` configurado (HH:MM SP), guardado
 * por `ultimo_envio_data` pra não repetir. Só envia com `config.ativo=true`.
 *
 * O horário é configurável na UI (aba Envio) — por isso o check por minuto em vez de
 * um @Cron fixo. Enquanto `ativo=false`, é no-op (o cron do BDO segue como está até o corte).
 */
@Injectable()
export class NotificacaoCron {
  private readonly logger = new Logger(NotificacaoCron.name);

  constructor(private readonly dispatcher: NotificacaoDispatcherService) {}

  @Cron('0 * * * * *', { timeZone: 'America/Sao_Paulo' })
  async tick(): Promise<void> {
    let cfg;
    try {
      cfg = await this.dispatcher.getConfig();
    } catch {
      return;
    }
    if (!cfg.ativo) return;

    const { hhmm, hoje } = this.agoraSP();
    if (cfg.horario !== hhmm) return;
    if (cfg.ultimo_envio_data === hoje) return; // já enviou hoje

    // Marca ANTES de disparar pra evitar duplo-disparo se o envio demorar > 1min.
    await this.dispatcher.marcarUltimoEnvio(hoje);
    this.logger.log(`[boletim-cron] horário ${hhmm} — disparando envio real de ${hoje}`);
    try {
      const r = await this.dispatcher.dispatch(hoje, { dryRun: false });
      const ok = r.alvos.filter((a) => a.status === 'ok').length;
      const err = r.alvos.filter((a) => a.status === 'erro').length;
      this.logger.log(`[boletim-cron] concluído: ok=${ok} erro=${err} total=${r.alvos.length}`);
    } catch (e: any) {
      this.logger.error(`[boletim-cron] fatal: ${e?.stack || e?.message}`);
    }
  }

  private agoraSP(): { hhmm: string; hoje: string } {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
    const hh = g('hour') === '24' ? '00' : g('hour');
    return { hhmm: `${hh}:${g('minute')}`, hoje: `${g('year')}-${g('month')}-${g('day')}` };
  }
}
