import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

export function initializeSentry() {
  const sentryDsn = process.env.SENTRY_DSN;
  const environment = process.env.NODE_ENV || 'development';

  if (!sentryDsn) {
    console.warn('⚠️  SENTRY_DSN não configurado. Monitoramento desabilitado.');
    return;
  }

  Sentry.init({
    dsn: sentryDsn,
    environment,

    // Configuração de performance monitoring
    tracesSampleRate: environment === 'production' ? 0.1 : 1.0, // 10% em produção, 100% em dev

    // Configuração de profiling
    profilesSampleRate: environment === 'production' ? 0.1 : 1.0,

    integrations: [
      // Profiling de CPU
      nodeProfilingIntegration(),

      // HTTP instrumentation
      Sentry.httpIntegration(),

      // Express instrumentation (será usado pelo NestJS)
      Sentry.expressIntegration(),
    ],

    // Filtrar informações sensíveis
    beforeSend(event) {
      // Remover informações sensíveis dos headers
      if (event.request?.headers) {
        delete event.request.headers.authorization;
        delete event.request.headers.cookie;
      }

      // Remover informações sensíveis do corpo da requisição
      if (event.request?.data) {
        const sensitiveFields = ['password', 'senha', 'token', 'secret'];
        sensitiveFields.forEach(field => {
          if (event.request.data && typeof event.request.data === 'object') {
            delete event.request.data[field];
          }
        });
      }

      return event;
    },

    // Ignorar erros conhecidos e não críticos
    ignoreErrors: [
      'ECONNRESET',
      'ENOTFOUND',
      'ETIMEDOUT',
      'Socket hang up',
    ],
  });

  console.log(`✅ Sentry inicializado - Ambiente: ${environment}`);
}

export { Sentry };
