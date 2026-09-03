import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '@/core';

/**
 * Checker das regras "sem comunicação" (offline).
 *
 * As regras de VALOR (regras_logs_mqtt normais) são dirigidas por mensagem que
 * chega e não conseguem expressar AUSÊNCIA de dado. Aqui tratamos o tipo especial
 * de regra `operador = 'sem_comunicacao'`, onde `valor` = minutos sem dado.
 *
 * A cada 2 min: pra cada regra ativa desse tipo, marca OFFLINE se a última leitura
 * do equipamento passou de `valor` minutos. Grava em `logs_mqtt` (mesmo store dos
 * alarmes de valor) APENAS na transição online→offline, com estado em memória
 * (semeado no boot sem notificar, pra não spammar ao reiniciar).
 */
@Injectable()
export class RegrasOfflineService implements OnModuleInit {
  private readonly logger = new Logger(RegrasOfflineService.name);

  // regraId (trim) -> offline? (estado atual)
  private estado = new Map<string, boolean>();
  private seeded = false;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    try {
      await this.checar(true); // semeia estado SEM notificar
      const off = [...this.estado.values()].filter(Boolean).length;
      this.logger.log(
        `Checker "sem_comunicacao" iniciado: ${this.estado.size} regra(s), ${off} offline no boot`,
      );
    } catch (e) {
      this.logger.error(`Falha ao semear: ${e.message}`);
    }
    this.seeded = true;
  }

  @Cron('*/2 * * * *') // a cada 2 minutos
  async tick() {
    if (!this.seeded) return;
    try {
      await this.checar(false);
    } catch (e) {
      this.logger.error(`Erro no tick: ${e.message}`);
    }
  }

  private async checar(seed: boolean) {
    const regras = await this.prisma.regras_logs_mqtt.findMany({
      where: { operador: 'sem_comunicacao', ativo: true, deleted_at: null },
    });
    if (regras.length === 0) {
      this.estado.clear();
      return;
    }

    // Última leitura por equipamento que tem regra offline (subquery evita IN dinâmico)
    const rows = await this.prisma.$queryRaw<
      Array<{ equipamento_id: string; ultima: Date | null }>
    >`
      SELECT TRIM(ed.equipamento_id) AS equipamento_id, MAX(ed.timestamp_dados) AS ultima
      FROM equipamentos_dados ed
      WHERE TRIM(ed.equipamento_id) IN (
        SELECT DISTINCT TRIM(equipamento_id) FROM regras_logs_mqtt
        WHERE operador = 'sem_comunicacao' AND ativo = true AND deleted_at IS NULL
      )
      GROUP BY TRIM(ed.equipamento_id)
    `;
    const ultimas = new Map<string, Date | null>();
    for (const r of rows) {
      ultimas.set(r.equipamento_id.trim(), r.ultima ? new Date(r.ultima) : null);
    }

    const now = Date.now();
    const vistas = new Set<string>();
    for (const regra of regras) {
      const rid = regra.id.trim();
      vistas.add(rid);
      const last = ultimas.get(regra.equipamento_id.trim()) ?? null;
      const minutos = last ? (now - last.getTime()) / 60000 : Infinity;
      const limiar = Number(regra.valor) || 10;
      const offline = minutos >= limiar;
      const prev = this.estado.get(rid) ?? false;

      if (offline && !prev && !seed) {
        await this.salvarLog(regra, minutos);
      }
      this.estado.set(rid, offline);
    }
    // Limpa estado de regras que saíram (desativadas/apagadas)
    for (const rid of [...this.estado.keys()]) {
      if (!vistas.has(rid)) this.estado.delete(rid);
    }
  }

  private async salvarLog(regra: any, minutos: number) {
    const min = Number.isFinite(minutos) ? Math.round(minutos) : null;
    await this.prisma.logs_mqtt.create({
      data: {
        regra_id: regra.id,
        equipamento_id: regra.equipamento_id,
        valor_lido: min ?? 0,
        mensagem: regra.mensagem,
        severidade: regra.severidade,
        dados_snapshot: {
          sem_comunicacao: true,
          minutos_sem_dado: min,
          limiar_min: Number(regra.valor),
        },
      },
    });
    this.logger.warn(
      `[OFFLINE] ${regra.mensagem} | eq ${regra.equipamento_id.trim()} | ` +
        `${min ?? '∞'} min sem dado (limiar ${regra.valor} min)`,
    );
  }
}
