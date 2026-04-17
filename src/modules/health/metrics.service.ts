import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@aupus/api-shared';
import { MqttService } from '../../shared/mqtt/mqtt.service';

export interface MqttMetrics {
  connection: {
    isConnected: boolean;
    uptime: number;
    instanceId: string;
    mode: string;
  };
  topics: {
    total: number;
    list: string[];
  };
  dataIngestion: {
    last24h: {
      totalRecords: number;
      recordsPerHour: number;
      coverage: number; // Percentual de cobertura (ideal: 100%)
    };
    lastHour: {
      totalRecords: number;
      recordsPerMinute: number;
    };
    lastRecord: {
      timestamp: string;
      minutesAgo: number;
    } | null;
  };
  quality: {
    last24h: {
      good: number;
      partial: number;
      bad: number;
      goodPercentage: number;
    };
  };
}

@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  private startTime: Date;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mqttService: MqttService,
  ) {
    this.startTime = new Date();
  }

  /**
   * Retorna métricas completas do MQTT
   */
  async getMqttMetrics(): Promise<MqttMetrics> {
    const [
      connectionMetrics,
      topicsMetrics,
      dataIngestionMetrics,
      qualityMetrics,
    ] = await Promise.all([
      this.getConnectionMetrics(),
      this.getTopicsMetrics(),
      this.getDataIngestionMetrics(),
      this.getQualityMetrics(),
    ]);

    return {
      connection: connectionMetrics,
      topics: topicsMetrics,
      dataIngestion: dataIngestionMetrics,
      quality: qualityMetrics,
    };
  }

  /**
   * Métricas de conexão MQTT
   */
  private getConnectionMetrics() {
    const isConnected = this.mqttService.isConnected();
    const uptime = Date.now() - this.startTime.getTime();
    const instanceId = process.env.INSTANCE_ID || 'unknown';
    const mode = process.env.MQTT_MODE || 'production';

    return {
      isConnected,
      uptime,
      instanceId,
      mode,
    };
  }

  /**
   * Métricas de tópicos MQTT
   */
  private getTopicsMetrics() {
    const total = this.mqttService.getSubscribedTopicsCount();
    const list = this.mqttService.getSubscribedTopics();

    return {
      total,
      list,
    };
  }

  /**
   * Métricas de ingestão de dados
   */
  private async getDataIngestionMetrics() {
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const lastHour = new Date(now.getTime() - 60 * 60 * 1000);

    // Dados das últimas 24h
    const recordsLast24h = await this.prisma.equipamentos_dados.count({
      where: {
        created_at: {
          gte: last24h,
        },
      },
    });

    // Dados da última hora
    const recordsLastHour = await this.prisma.equipamentos_dados.count({
      where: {
        created_at: {
          gte: lastHour,
        },
      },
    });

    // Último registro (janela de 15min para evitar full scan)
    const quinzeMinutosAtras = new Date(now.getTime() - 15 * 60 * 1000);
    const lastRecord = await this.prisma.equipamentos_dados.findFirst({
      where: { created_at: { gte: quinzeMinutosAtras } },
      orderBy: { created_at: 'desc' },
      select: { created_at: true },
    });

    // Calcular métricas
    const recordsPerHour = recordsLast24h / 24;
    const recordsPerMinute = recordsLastHour / 60;

    // Cobertura: assumindo que deveria receber 1 registro/minuto por equipamento
    // TODO: Ajustar baseado no número real de equipamentos
    const expectedRecordsLast24h = 24 * 60; // 1 por minuto
    const coverage = Math.min((recordsLast24h / expectedRecordsLast24h) * 100, 100);

    const lastRecordData = lastRecord
      ? {
          timestamp: lastRecord.created_at.toISOString(),
          minutesAgo: Math.floor(
            (now.getTime() - lastRecord.created_at.getTime()) / (1000 * 60),
          ),
        }
      : null;

    return {
      last24h: {
        totalRecords: recordsLast24h,
        recordsPerHour: Math.round(recordsPerHour * 100) / 100,
        coverage: Math.round(coverage * 100) / 100,
      },
      lastHour: {
        totalRecords: recordsLastHour,
        recordsPerMinute: Math.round(recordsPerMinute * 100) / 100,
      },
      lastRecord: lastRecordData,
    };
  }

  /**
   * Métricas de qualidade dos dados
   */
  private async getQualityMetrics() {
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Contar registros por qualidade
    const qualityStats = await this.prisma.equipamentos_dados.groupBy({
      by: ['qualidade'],
      where: {
        created_at: {
          gte: last24h,
        },
      },
      _count: true,
    });

    const good = qualityStats.find((q) => q.qualidade === 'bom')?._count || 0;
    const partial =
      qualityStats.find((q) => q.qualidade === 'parcial')?._count || 0;
    const bad = qualityStats.find((q) => q.qualidade === 'ruim')?._count || 0;
    const total = good + partial + bad;

    const goodPercentage = total > 0 ? (good / total) * 100 : 0;

    return {
      last24h: {
        good,
        partial,
        bad,
        goodPercentage: Math.round(goodPercentage * 100) / 100,
      },
    };
  }

  /**
   * Retorna métricas simplificadas para exibição rápida
   */
  async getSimpleMetrics() {
    const metrics = await this.getMqttMetrics();

    return {
      status: metrics.connection.isConnected ? 'online' : 'offline',
      mode: metrics.connection.mode,
      lastDataMinutesAgo: metrics.dataIngestion.lastRecord?.minutesAgo || null,
      recordsLast24h: metrics.dataIngestion.last24h.totalRecords,
      qualityGoodPercentage: metrics.quality.last24h.goodPercentage,
    };
  }
}
