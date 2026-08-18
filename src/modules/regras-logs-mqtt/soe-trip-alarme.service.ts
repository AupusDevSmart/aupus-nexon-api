import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '@aupus/api-shared';

/**
 * SOE → alarme de TRIP.
 *
 * Lê o buffer de eventos dos relés (`rele_eventos`) e, a cada novo "General Trip"
 * (estado=on), levanta um alarme em `logs_mqtt` (tipo='alerta', severidade CRITICA,
 * dados_snapshot.kind='trip'). O alarme fica ATIVO (reconhecido_em NULL) até um
 * operador reconhecer — é isso que representa "ainda tripado". Não há correlação
 * com reset elétrico: um trip novo = um alarme; some quando o operador marca visto.
 *
 * Dedup: processa eventos com `created_at` > último processado; semeia no boot com o
 * MAX atual (não re-levanta trips antigos ao reiniciar).
 */
@Injectable()
export class SoeTripAlarmeService implements OnModuleInit {
  private readonly logger = new Logger(SoeTripAlarmeService.name);
  private ultimoProcessado: Date | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    try {
      const r = await this.prisma.$queryRaw<Array<{ max: Date | null }>>`
        SELECT MAX(created_at) AS max FROM rele_eventos
      `;
      this.ultimoProcessado = r?.[0]?.max ? new Date(r[0].max) : new Date();
      this.logger.log(
        `SOE trip-alarme iniciado (não re-levanta trips até ${this.ultimoProcessado?.toISOString()})`,
      );
    } catch (e) {
      this.ultimoProcessado = new Date();
      this.logger.error(`Falha no seed: ${e.message}`);
    }
  }

  @Cron('*/1 * * * *') // a cada 1 minuto
  async tick() {
    if (!this.ultimoProcessado) return;
    try {
      const desde = this.ultimoProcessado;
      const eventos = await this.prisma.$queryRaw<
        Array<{
          id: string;
          equipamento_id: string;
          evento: string | null;
          ts_fonte: Date | null;
          created_at: Date;
          fun: number | null;
          inf: number | null;
        }>
      >`
        SELECT TRIM(id) AS id, TRIM(equipamento_id) AS equipamento_id,
               evento, ts_fonte, created_at, fun, inf
        FROM rele_eventos
        WHERE created_at > ${desde}
          AND lower(estado) = 'on'
          AND (inf = 68 OR evento ILIKE '%General Trip%')
        ORDER BY created_at ASC
      `;

      let maxCreated = desde;
      for (const ev of eventos) {
        await this.levantarAlarme(ev);
        const c = new Date(ev.created_at);
        if (c > maxCreated) maxCreated = c;
      }
      this.ultimoProcessado = maxCreated;
      if (eventos.length) this.logger.warn(`SOE: ${eventos.length} trip(s) levantado(s)`);
    } catch (e) {
      this.logger.error(`Erro no tick: ${e.message}`);
    }
  }

  private async levantarAlarme(ev: {
    id: string;
    equipamento_id: string;
    evento: string | null;
    ts_fonte: Date | null;
    created_at: Date;
    fun: number | null;
    inf: number | null;
  }) {
    const quando = ev.ts_fonte ? new Date(ev.ts_fonte) : new Date(ev.created_at);
    await this.prisma.logs_mqtt.create({
      data: {
        regra_id: null,
        equipamento_id: ev.equipamento_id,
        tipo: 'alerta',
        severidade: 'CRITICA',
        mensagem: `TRIP — ${ev.evento || 'General Trip'}`,
        valor_lido: null,
        dados_snapshot: {
          kind: 'trip',
          origem: 'SOE',
          evento: ev.evento,
          fun: ev.fun,
          inf: ev.inf,
          ts_fonte: quando.toISOString(),
          rele_evento_id: ev.id,
        },
      },
    });
    this.logger.warn(
      `[TRIP] eq ${ev.equipamento_id} | ${ev.evento || 'General Trip'} @ ${quando.toISOString()}`,
    );
  }
}
