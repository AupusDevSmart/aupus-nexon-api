import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  // Metricas de queries
  private queryMetrics = {
    totalQueries: 0,
    slowQueries: 0,
    errorCount: 0,
  };

  constructor() {
    super({
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'warn' },
      ],
      errorFormat: 'pretty',
      datasources: {
        db: {
          url: process.env.DATABASE_URL,
        },
      },
    });

    const slowQueryThreshold = parseInt(process.env.SLOW_QUERY_THRESHOLD || '1000');

    this.$on('query' as never, (e: any) => {
      this.queryMetrics.totalQueries++;
      if (e.duration > slowQueryThreshold) {
        this.queryMetrics.slowQueries++;
        this.logger.warn(`Query lenta detectada (${e.duration}ms): ${e.query}`);
      }
    });

    this.$on('error' as never, (e: any) => {
      this.queryMetrics.errorCount++;
      this.logger.error(`Erro no Prisma: ${e.message || JSON.stringify(e)}`);
    });

    this.$on('warn' as never, (e: any) => {
      this.logger.warn(`Aviso do Prisma: ${e.message || JSON.stringify(e)}`);
    });
  }

  async onModuleInit() {
    let retries = 5;
    while (retries > 0) {
      try {
        await this.$connect();
        this.logger.log('Conectado ao banco de dados com sucesso');
        await this.$executeRaw`SELECT 1`;
        return;
      } catch (error) {
        retries--;
        this.logger.warn(`Falha ao conectar ao banco. Tentativas restantes: ${retries}`);
        if (retries === 0) {
          this.logger.error('Nao foi possivel conectar ao banco de dados', error);
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  async onModuleDestroy() {
    this.logger.log(`Metricas finais: ${JSON.stringify(this.queryMetrics)}`);
    await this.$disconnect();
  }

  getQueryMetrics() {
    return { ...this.queryMetrics, timestamp: new Date().toISOString() };
  }

  async executeWithRetry<T>(operation: () => Promise<T>, maxRetries = 3): Promise<T> {
    let lastError: Error;
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await operation();
      } catch (error: any) {
        lastError = error;
        if (error.code === 'P2037') {
          this.logger.warn(`Pool esgotado (P2037). Aguardando ${(i + 1) * 2}s... (${i + 1}/${maxRetries})`);
          await new Promise((resolve) => setTimeout(resolve, 2000 * (i + 1)));
          continue;
        }
        const reconnectionErrors = ['P1001', 'P1002', 'P1008', 'P1017'];
        if (reconnectionErrors.includes(error.code)) {
          this.logger.warn(`Erro de conexao (${error.code}). Tentativa ${i + 1}/${maxRetries}`);
          try {
            await this.$disconnect();
            await this.$connect();
          } catch (reconnectError) {
            this.logger.error('Erro ao reconectar:', reconnectError);
          }
          await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
          continue;
        }
        throw error;
      }
    }
    throw lastError!;
  }
}
