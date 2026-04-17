import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { HealthService } from './health.service';

export interface Alert {
  level: 'INFO' | 'WARNING' | 'CRITICAL';
  service: string;
  message: string;
  timestamp: string;
  metadata?: Record<string, any>;
}

@Injectable()
export class AlertService {
  private readonly logger = new Logger(AlertService.name);

  // Cache do último estado para evitar alertas duplicados
  private lastAlertState: {
    mqtt: 'ok' | 'degraded' | 'critical' | null;
    data: 'ok' | 'warning' | 'critical' | null;
    database: 'ok' | 'critical' | null;
  } = {
    mqtt: null,
    data: null,
    database: null,
  };

  // Histórico de alertas (últimas 100 entradas)
  private alertHistory: Alert[] = [];
  private readonly MAX_HISTORY = 100;

  constructor(private readonly healthService: HealthService) {}

  /**
   * Cron job que roda a cada 5 minutos para verificar saúde do sistema
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async checkSystemHealthAndAlert() {
    this.logger.log('🔍 Executando verificação automática de saúde...');

    try {
      const health = await this.healthService.checkHealth();

      // Verificar MQTT
      await this.checkMqttStatus(health);

      // Verificar dados recentes
      await this.checkRecentDataStatus(health);

      // Verificar banco de dados
      await this.checkDatabaseStatus(health);

      this.logger.log(`✅ Verificação completa. Status geral: ${health.status}`);
    } catch (error) {
      this.logger.error('❌ Erro ao executar verificação de saúde:', error);
      await this.sendAlert({
        level: 'CRITICAL',
        service: 'HealthCheck',
        message: `Erro ao executar health check: ${error.message}`,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Verifica status do MQTT e envia alertas se necessário
   */
  private async checkMqttStatus(health: any) {
    const mqttStatus = health.checks.mqtt?.status;
    const currentState = mqttStatus === 'connected' ? 'ok' : 'critical';

    // Se estado mudou, enviar alerta
    if (this.lastAlertState.mqtt !== currentState) {
      if (currentState === 'critical') {
        await this.sendAlert({
          level: 'CRITICAL',
          service: 'MQTT',
          message: '🔴 MQTT DESCONECTADO! Dados não estão sendo recebidos.',
          timestamp: new Date().toISOString(),
          metadata: {
            subscribedTopics: health.checks.mqtt?.subscribedTopics || 0,
            message: health.checks.mqtt?.message,
          },
        });
      } else {
        // MQTT voltou ao normal
        await this.sendAlert({
          level: 'INFO',
          service: 'MQTT',
          message: '✅ MQTT reconectado com sucesso!',
          timestamp: new Date().toISOString(),
          metadata: {
            subscribedTopics: health.checks.mqtt?.subscribedTopics,
          },
        });
      }

      this.lastAlertState.mqtt = currentState;
    }
  }

  /**
   * Verifica status dos dados recentes e envia alertas se necessário
   */
  private async checkRecentDataStatus(health: any) {
    const dataCheck = health.checks.recentData;
    const currentState = dataCheck?.status || 'critical';

    // Se estado mudou, enviar alerta
    if (this.lastAlertState.data !== currentState) {
      if (currentState === 'critical') {
        const horasSemDados = dataCheck?.hoursSinceLastData || 0;
        await this.sendAlert({
          level: 'CRITICAL',
          service: 'DataIngestion',
          message: `🔴 SEM DADOS HÁ ${Math.floor(horasSemDados * 60)} MINUTOS! MQTT pode estar desconectado ou equipamentos offline.`,
          timestamp: new Date().toISOString(),
          metadata: {
            hoursSinceLastData: horasSemDados,
            lastDataTimestamp: dataCheck?.lastDataTimestamp,
          },
        });
      } else if (currentState === 'warning' && this.lastAlertState.data !== 'warning') {
        await this.sendAlert({
          level: 'WARNING',
          service: 'DataIngestion',
          message: `⚠️ Dados atrasados (${dataCheck?.hoursSinceLastData?.toFixed(1)}h desde último dado)`,
          timestamp: new Date().toISOString(),
          metadata: {
            hoursSinceLastData: dataCheck?.hoursSinceLastData,
          },
        });
      } else if (currentState === 'ok' && this.lastAlertState.data !== 'ok') {
        // Dados voltaram ao normal
        await this.sendAlert({
          level: 'INFO',
          service: 'DataIngestion',
          message: '✅ Ingestão de dados normalizada!',
          timestamp: new Date().toISOString(),
        });
      }

      this.lastAlertState.data = currentState;
    }
  }

  /**
   * Verifica status do banco de dados
   */
  private async checkDatabaseStatus(health: any) {
    const dbStatus = health.checks.database?.status;
    const currentState = dbStatus === 'connected' ? 'ok' : 'critical';

    if (this.lastAlertState.database !== currentState) {
      if (currentState === 'critical') {
        await this.sendAlert({
          level: 'CRITICAL',
          service: 'Database',
          message: '🔴 BANCO DE DADOS OFFLINE! Sistema inoperante.',
          timestamp: new Date().toISOString(),
          metadata: {
            message: health.checks.database?.message,
          },
        });
      } else {
        await this.sendAlert({
          level: 'INFO',
          service: 'Database',
          message: '✅ Banco de dados reconectado!',
          timestamp: new Date().toISOString(),
        });
      }

      this.lastAlertState.database = currentState;
    }
  }

  /**
   * Envia um alerta (loga no console e salva no histórico)
   * TODO: Integrar com Slack, Email, SMS, etc
   */
  private async sendAlert(alert: Alert) {
    // Adicionar ao histórico
    this.alertHistory.unshift(alert);
    if (this.alertHistory.length > this.MAX_HISTORY) {
      this.alertHistory = this.alertHistory.slice(0, this.MAX_HISTORY);
    }

    // Logar no console com cores
    const emoji = {
      INFO: 'ℹ️',
      WARNING: '⚠️',
      CRITICAL: '🚨',
    };

    const logMethod = {
      INFO: 'log',
      WARNING: 'warn',
      CRITICAL: 'error',
    };

    this.logger[logMethod[alert.level]](
      `${emoji[alert.level]} [${alert.service}] ${alert.message}`,
      alert.metadata || '',
    );

    // TODO: Integrar com serviços externos
    // await this.sendToSlack(alert);
    // await this.sendEmail(alert);
    // await this.sendSMS(alert);
  }

  /**
   * Retorna histórico de alertas
   */
  getAlertHistory(): Alert[] {
    return this.alertHistory;
  }

  /**
   * Força verificação manual (útil para testes)
   */
  async triggerManualCheck() {
    this.logger.log('🔍 Verificação manual solicitada...');
    await this.checkSystemHealthAndAlert();
  }

  // ==============================
  // MÉTODOS PARA INTEGRAÇÃO FUTURA
  // ==============================

  /**
   * TODO: Enviar alerta para Slack
   */
  // private async sendToSlack(alert: Alert) {
  //   const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  //   if (!webhookUrl) return;

  //   const color = {
  //     INFO: '#36a64f',
  //     WARNING: '#ff9900',
  //     CRITICAL: '#ff0000',
  //   };

  //   await fetch(webhookUrl, {
  //     method: 'POST',
  //     headers: { 'Content-Type': 'application/json' },
  //     body: JSON.stringify({
  //       attachments: [{
  //         color: color[alert.level],
  //         title: `[${alert.level}] ${alert.service}`,
  //         text: alert.message,
  //         fields: alert.metadata ? Object.entries(alert.metadata).map(([key, value]) => ({
  //           title: key,
  //           value: String(value),
  //           short: true,
  //         })) : [],
  //         ts: Math.floor(new Date(alert.timestamp).getTime() / 1000),
  //       }],
  //     }),
  //   });
  // }

  /**
   * TODO: Enviar email
   */
  // private async sendEmail(alert: Alert) {
  //   const nodemailer = require('nodemailer');
  //
  //   const transporter = nodemailer.createTransporter({
  //     host: process.env.SMTP_HOST,
  //     port: process.env.SMTP_PORT,
  //     auth: {
  //       user: process.env.SMTP_USER,
  //       pass: process.env.SMTP_PASS,
  //     },
  //   });
  //
  //   await transporter.sendMail({
  //     from: '"Aupus Alerts" <alerts@aupus.com>',
  //     to: process.env.ALERT_EMAIL_TO,
  //     subject: `[${alert.level}] ${alert.service} - ${alert.message}`,
  //     html: `
  //       <h2>${alert.level}: ${alert.service}</h2>
  //       <p>${alert.message}</p>
  //       <p><strong>Timestamp:</strong> ${alert.timestamp}</p>
  //       ${alert.metadata ? `<pre>${JSON.stringify(alert.metadata, null, 2)}</pre>` : ''}
  //     `,
  //   });
  // }
}
