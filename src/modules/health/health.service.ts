import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@aupus/api-shared';
import { MqttService } from '../../shared/mqtt/mqtt.service';

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  checks: {
    mqtt?: {
      status: 'connected' | 'disconnected';
      subscribedTopics: number;
      message?: string;
    };
    database?: {
      status: 'connected' | 'disconnected';
      message?: string;
    };
    recentData?: {
      status: 'ok' | 'warning' | 'critical';
      lastDataTimestamp?: string;
      hoursSinceLastData?: number;
      message?: string;
    };
  };
  uptime: number;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private startTime: Date;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mqttService: MqttService,
  ) {
    this.startTime = new Date();
  }

  /**
   * Health check geral do sistema
   */
  async checkHealth(): Promise<HealthStatus> {
    const mqtt = await this.checkMqttHealth();
    const database = await this.checkDatabaseHealth();
    const recentData = await this.checkRecentDataHealth();

    // Determinar status geral
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

    if (
      mqtt.checks.mqtt?.status === 'disconnected' ||
      database.checks.database?.status === 'disconnected' ||
      recentData.checks.recentData?.status === 'critical'
    ) {
      status = 'unhealthy';
    } else if (recentData.checks.recentData?.status === 'warning') {
      status = 'degraded';
    }

    return {
      status,
      timestamp: new Date().toISOString(),
      checks: {
        mqtt: mqtt.checks.mqtt,
        database: database.checks.database,
        recentData: recentData.checks.recentData,
      },
      uptime: Date.now() - this.startTime.getTime(),
    };
  }

  /**
   * Verifica saúde do MQTT
   */
  async checkMqttHealth(): Promise<HealthStatus> {
    try {
      const isConnected = this.mqttService.isConnected();
      const subscribedTopics = this.mqttService.getSubscribedTopicsCount();

      return {
        status: isConnected ? 'healthy' : 'unhealthy',
        timestamp: new Date().toISOString(),
        checks: {
          mqtt: {
            status: isConnected ? 'connected' : 'disconnected',
            subscribedTopics,
            message: isConnected
              ? `Conectado com ${subscribedTopics} tópicos subscritos`
              : 'MQTT desconectado - dados não estão sendo recebidos',
          },
        },
        uptime: Date.now() - this.startTime.getTime(),
      };
    } catch (error) {
      this.logger.error('Erro ao verificar saúde do MQTT:', error);
      return {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        checks: {
          mqtt: {
            status: 'disconnected',
            subscribedTopics: 0,
            message: `Erro ao verificar MQTT: ${error.message}`,
          },
        },
        uptime: Date.now() - this.startTime.getTime(),
      };
    }
  }

  /**
   * Verifica saúde do banco de dados
   */
  async checkDatabaseHealth(): Promise<HealthStatus> {
    try {
      // Tenta fazer uma query simples
      await this.prisma.$queryRaw`SELECT 1`;

      return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        checks: {
          database: {
            status: 'connected',
            message: 'Banco de dados respondendo normalmente',
          },
        },
        uptime: Date.now() - this.startTime.getTime(),
      };
    } catch (error) {
      this.logger.error('Erro ao verificar saúde do banco:', error);
      return {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        checks: {
          database: {
            status: 'disconnected',
            message: `Erro ao conectar no banco: ${error.message}`,
          },
        },
        uptime: Date.now() - this.startTime.getTime(),
      };
    }
  }

  /**
   * Verifica se há dados recentes sendo salvos
   */
  async checkRecentDataHealth(): Promise<HealthStatus> {
    try {
      // Buscar o dado mais recente dentro de uma janela de 15 minutos para evitar full scan
      // (tabela recebe dados a cada minuto via MQTT, então 15min sem dado já é crítico)
      const quinzeMinutosAtras = new Date(Date.now() - 15 * 60 * 1000);
      const ultimoDado = await this.prisma.equipamentos_dados.findFirst({
        where: { created_at: { gte: quinzeMinutosAtras } },
        orderBy: { created_at: 'desc' },
        select: { created_at: true },
      });

      if (!ultimoDado) {
        return {
          status: 'unhealthy',
          timestamp: new Date().toISOString(),
          checks: {
            recentData: {
              status: 'critical',
              message:
                'Nenhum dado nos últimos 15 minutos - MQTT pode não estar salvando dados',
            },
          },
          uptime: Date.now() - this.startTime.getTime(),
        };
      }

      const now = new Date();
      const minutesSinceLastData =
        (now.getTime() - ultimoDado.created_at.getTime()) / (1000 * 60);

      let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
      let dataStatus: 'ok' | 'warning' | 'critical' = 'ok';
      let message = `Último dado recebido há ${minutesSinceLastData.toFixed(1)} minutos`;

      if (minutesSinceLastData > 10) {
        status = 'degraded';
        dataStatus = 'warning';
        message = `⚠️ ATENÇÃO: Último dado há ${minutesSinceLastData.toFixed(1)} minutos - possível problema com MQTT`;
      }

      const hoursSinceLastData = minutesSinceLastData / 60;

      return {
        status,
        timestamp: new Date().toISOString(),
        checks: {
          recentData: {
            status: dataStatus,
            lastDataTimestamp: ultimoDado.created_at.toISOString(),
            hoursSinceLastData: parseFloat(hoursSinceLastData.toFixed(2)),
            message,
          },
        },
        uptime: Date.now() - this.startTime.getTime(),
      };
    } catch (error) {
      this.logger.error('Erro ao verificar dados recentes:', error);
      return {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        checks: {
          recentData: {
            status: 'critical',
            message: `Erro ao verificar dados recentes: ${error.message}`,
          },
        },
        uptime: Date.now() - this.startTime.getTime(),
      };
    }
  }
}
