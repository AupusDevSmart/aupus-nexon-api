import { Sentry } from '../../config/sentry.config';
import { loggers } from '../../config/logger.config';

/**
 * Helper para facilitar o uso do sistema de monitoramento
 */

export class MonitoringHelper {
  /**
   * Executa uma operação com monitoramento automático
   * Captura erros e loga performance
   */
  static async withMonitoring<T>(
    operationName: string,
    operation: () => Promise<T>,
    context?: Record<string, any>,
  ): Promise<T> {
    const startTime = Date.now();

    loggers.business.debug(
      {
        operation: operationName,
        context,
      },
      `Iniciando operação: ${operationName}`,
    );

    try {
      const result = await operation();
      const duration = Date.now() - startTime;

      loggers.business.info(
        {
          operation: operationName,
          duration,
          context,
        },
        `Operação concluída: ${operationName} (${duration}ms)`,
      );

      // Alertar se operação demorou muito
      if (duration > 5000) {
        loggers.business.warn(
          {
            operation: operationName,
            duration,
            context,
          },
          `Operação lenta: ${operationName} (${duration}ms)`,
        );

        if (process.env.NODE_ENV === 'production') {
          Sentry.captureMessage(`Operação lenta: ${operationName}`, {
            level: 'warning',
            extra: {
              operation: operationName,
              duration,
              context,
            },
            tags: {
              component: 'business',
              operation_type: 'slow',
            },
          });
        }
      }

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;

      loggers.error.error(
        {
          operation: operationName,
          duration,
          error: {
            message: error.message,
            stack: error.stack,
          },
          context,
        },
        `Erro na operação: ${operationName}`,
      );

      Sentry.withScope((scope) => {
        scope.setContext('operation', {
          name: operationName,
          duration,
          context,
        });
        scope.setTag('operation', operationName);
        Sentry.captureException(error);
      });

      throw error;
    }
  }

  /**
   * Log de evento de negócio importante
   */
  static logBusinessEvent(
    eventName: string,
    data: Record<string, any>,
    level: 'info' | 'warn' = 'info',
  ): void {
    loggers.business[level](
      {
        event: eventName,
        data,
        timestamp: new Date().toISOString(),
      },
      `Evento: ${eventName}`,
    );

    // Em produção, também envia eventos críticos ao Sentry
    if (process.env.NODE_ENV === 'production' && level === 'warn') {
      Sentry.captureMessage(`Evento crítico: ${eventName}`, {
        level: 'warning',
        extra: { event: eventName, data },
        tags: { component: 'business', event_type: 'critical' },
      });
    }
  }

  /**
   * Rastrear métrica customizada
   */
  static trackMetric(
    metricName: string,
    value: number,
    unit?: string,
    tags?: Record<string, string>,
  ): void {
    loggers.business.info(
      {
        metric: metricName,
        value,
        unit,
        tags,
        timestamp: new Date().toISOString(),
      },
      `Métrica: ${metricName} = ${value}${unit ? ` ${unit}` : ''}`,
    );
  }

  /**
   * Log de acesso a recurso protegido
   */
  static logAccess(
    userId: string,
    resource: string,
    action: string,
    granted: boolean,
  ): void {
    const level = granted ? 'info' : 'warn';

    loggers.auth[level](
      {
        userId,
        resource,
        action,
        granted,
        timestamp: new Date().toISOString(),
      },
      `Acesso ${granted ? 'permitido' : 'negado'}: ${userId} -> ${action} em ${resource}`,
    );

    // Log de acessos negados no Sentry
    if (!granted && process.env.NODE_ENV === 'production') {
      Sentry.captureMessage(`Acesso negado: ${resource}`, {
        level: 'warning',
        extra: { userId, resource, action },
        tags: { component: 'security', access: 'denied' },
      });
    }
  }
}
