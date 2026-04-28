import { pino } from 'pino';

const isDevelopment = process.env.NODE_ENV !== 'production';

// Configuração do Pino Logger
export const logger = pino({
  level: process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info'),

  // Formatação para desenvolvimento (pretty print)
  ...(isDevelopment && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
        ignore: 'pid,hostname',
        singleLine: false,
        messageFormat: '{levelLabel} - {msg}',
      },
    },
  }),

  // Formatação estruturada para produção (JSON)
  ...(!isDevelopment && {
    formatters: {
      level: (label) => {
        return { level: label };
      },
    },
  }),

  // Timestamp personalizado
  timestamp: pino.stdTimeFunctions.isoTime,

  // Serializers customizados para objetos comuns
  serializers: {
    req: (req) => ({
      id: req.id,
      method: req.method,
      url: req.url,
      headers: {
        host: req.headers?.host,
        'user-agent': req.headers?.['user-agent'],
      },
      remoteAddress: req.remoteAddress,
      remotePort: req.remotePort,
    }),
    res: (res) => ({
      statusCode: res.statusCode,
      headers: res.getHeaders ? res.getHeaders() : {},
    }),
    err: (err) => ({
      type: err.type,
      message: err.message,
      stack: err.stack,
    }),
  },

  // Base fields para todos os logs
  base: {
    env: process.env.NODE_ENV || 'development',
    service: 'aupus-nexon-api',
  },
});

// Helper functions para logging específico
export const loggers = {
  http: logger.child({ context: 'HTTP' }),
  database: logger.child({ context: 'Database' }),
  auth: logger.child({ context: 'Auth' }),
  business: logger.child({ context: 'Business' }),
  error: logger.child({ context: 'Error' }),
};

export default logger;
