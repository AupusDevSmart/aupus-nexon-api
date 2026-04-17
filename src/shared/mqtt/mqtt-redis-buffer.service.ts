import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { PrismaService } from '@aupus/api-shared';

/**
 * Serviço de Buffer MQTT com Redis
 *
 * ✅ Vantagens do Redis:
 * - Persistência automática em disco (RDB + AOF)
 * - Performance extremamente alta (operações em memória)
 * - Suporta listas ordenadas (FIFO/FILO)
 * - Retry automático de conexão
 * - Suporta múltiplas instâncias do backend (escalável)
 * - TTL automático para dados antigos
 * - Atomic operations (sem race conditions)
 *
 * 📊 Capacidade:
 * - Milhões de dados por segundo
 * - Sem bloqueio (non-blocking)
 * - Suporta cluster para alta disponibilidade
 */

interface BufferedData {
  id: string;
  equipamentoId: string;
  timestamp: string; // ISO string para serialização
  dados: any;
  tentativas: number;
  ultimaTentativa: string;
  criadoEm: string;
}

@Injectable()
export class MqttRedisBufferService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttRedisBufferService.name);
  private redis: Redis;
  private retryTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;

  // Configurações
  private readonly QUEUE_KEY = 'mqtt:buffer:queue'; // Lista FIFO
  private readonly PROCESSING_KEY = 'mqtt:buffer:processing'; // Set de dados em processamento
  private readonly FAILED_KEY = 'mqtt:buffer:failed'; // Hash de dados que falharam muito
  private readonly STATS_KEY = 'mqtt:buffer:stats'; // Hash de estatísticas
  private readonly MAX_TENTATIVAS = 10;
  private readonly RETRY_INTERVAL = 30000; // 30 segundos
  private readonly BATCH_SIZE = 100; // Processar 100 por vez

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    this.logger.log('🚀 Inicializando Redis Buffer Service...');

    // Configurar Redis com retry automático
    this.redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD,
      db: parseInt(process.env.REDIS_DB || '0'),
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        this.logger.warn(
          `🔄 Redis desconectado, tentando reconectar em ${delay}ms (tentativa ${times})`,
        );
        return delay;
      },
      maxRetriesPerRequest: null, // Nunca desistir
      enableReadyCheck: true,
      enableOfflineQueue: true, // Enfileirar comandos quando offline
    });

    // Event listeners
    this.redis.on('connect', () => {
      this.logger.log('✅ Redis conectado!');
    });

    this.redis.on('ready', () => {
      this.logger.log('🟢 Redis pronto para uso!');
      // Processar dados pendentes quando reconectar
      this.processarDadosPendentes();
    });

    this.redis.on('error', (error) => {
      this.logger.error('❌ Redis erro:', error.message);
    });

    this.redis.on('reconnecting', () => {
      this.logger.warn('🔄 Redis reconectando...');
    });

    // Iniciar processamento automático
    this.iniciarRetryAutomatico();

    // Processar dados pendentes ao iniciar
    setTimeout(() => this.processarDadosPendentes(), 2000);
  }

  async onModuleDestroy() {
    this.logger.log('🛑 Encerrando Redis Buffer Service...');

    if (this.retryTimer) {
      clearInterval(this.retryTimer);
    }

    // Última tentativa de processar pendentes
    await this.processarDadosPendentes();

    // Fechar conexão Redis
    await this.redis.quit();
  }

  /**
   * Salva dados no buffer Redis quando banco falha
   */
  async salvarNoBuffer(
    equipamentoId: string,
    timestamp: Date,
    dados: any,
  ): Promise<void> {
    try {
      const bufferedData: BufferedData = {
        id: `${equipamentoId}_${timestamp.getTime()}_${Date.now()}`,
        equipamentoId,
        timestamp: timestamp.toISOString(),
        dados,
        tentativas: 0,
        ultimaTentativa: new Date().toISOString(),
        criadoEm: new Date().toISOString(),
      };

      // Adicionar à fila (RPUSH = adiciona ao final)
      await this.redis.rpush(
        this.QUEUE_KEY,
        JSON.stringify(bufferedData),
      );

      // Incrementar contador de estatísticas
      await this.redis.hincrby(this.STATS_KEY, 'total_buffered', 1);

      const queueSize = await this.redis.llen(this.QUEUE_KEY);

      this.logger.warn(
        `💾 [REDIS BUFFER] Dados salvos: ${equipamentoId} @ ${timestamp.toISOString()} (Fila: ${queueSize})`,
      );
    } catch (error) {
      this.logger.error(
        `❌ [REDIS BUFFER] Erro ao salvar no Redis:`,
        error,
      );

      // FALLBACK: Se Redis falhar, salvar em arquivo local
      await this.salvarFallbackEmDisco(equipamentoId, timestamp, dados);
    }
  }

  /**
   * Fallback: salvar em disco se Redis falhar
   */
  private async salvarFallbackEmDisco(
    equipamentoId: string,
    timestamp: Date,
    dados: any,
  ): Promise<void> {
    try {
      const fs = require('fs');
      const path = require('path');

      const fallbackDir = path.join(process.cwd(), 'mqtt-buffer-fallback');
      if (!fs.existsSync(fallbackDir)) {
        fs.mkdirSync(fallbackDir, { recursive: true });
      }

      const fallbackFile = path.join(
        fallbackDir,
        `${equipamentoId}_${Date.now()}.json`,
      );

      fs.writeFileSync(
        fallbackFile,
        JSON.stringify(
          {
            equipamentoId,
            timestamp: timestamp.toISOString(),
            dados,
            criadoEm: new Date().toISOString(),
          },
          null,
          2,
        ),
      );

      this.logger.error(
        `🚨 [FALLBACK] Dados salvos em disco: ${fallbackFile}`,
      );
    } catch (err) {
      this.logger.error(
        `💀 [FALHA CRÍTICA] Não foi possível salvar dados nem em fallback!`,
        err,
      );
    }
  }

  /**
   * Processa dados pendentes do Redis em lote
   */
  async processarDadosPendentes(): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    try {
      const queueSize = await this.redis.llen(this.QUEUE_KEY);

      if (queueSize === 0) {
        return;
      }

      this.logger.log(
        `🔄 [REDIS BUFFER] Processando ${Math.min(queueSize, this.BATCH_SIZE)} de ${queueSize} dados pendentes...`,
      );

      let sucessos = 0;
      let falhas = 0;

      // Processar em lotes
      for (let i = 0; i < this.BATCH_SIZE; i++) {
        // LPOP = remove do início (FIFO)
        const dadoJson = await this.redis.lpop(this.QUEUE_KEY);

        if (!dadoJson) {
          break; // Fila vazia
        }

        try {
          const dado: BufferedData = JSON.parse(dadoJson as string);

          // Verificar se já existe no banco
          const existe = await this.prisma.equipamentos_dados.findFirst({
            where: {
              equipamento_id: dado.equipamentoId,
              timestamp_dados: new Date(dado.timestamp),
            },
            select: { id: true },
          });

          if (existe) {
            sucessos++;
            await this.redis.hincrby(this.STATS_KEY, 'total_skipped', 1);
            continue;
          }

          // Tentar salvar no banco
          await this.salvarNoBanco(dado);

          sucessos++;
          await this.redis.hincrby(this.STATS_KEY, 'total_saved', 1);

          this.logger.debug(
            `✅ [REDIS BUFFER] Processado: ${dado.equipamentoId} @ ${dado.timestamp}`,
          );
        } catch (error) {
          falhas++;
          const dado: BufferedData = JSON.parse(dadoJson as string);

          dado.tentativas++;
          dado.ultimaTentativa = new Date().toISOString();

          if (dado.tentativas < this.MAX_TENTATIVAS) {
            // Recolocar na fila (ao final)
            await this.redis.rpush(this.QUEUE_KEY, JSON.stringify(dado));

            this.logger.warn(
              `⚠️ [REDIS BUFFER] Falha ao processar (tentativa ${dado.tentativas}/${this.MAX_TENTATIVAS}): ${dado.id}`,
            );
          } else {
            // Mover para failed
            await this.redis.hset(this.FAILED_KEY, dado.id, JSON.stringify(dado));
            await this.redis.hincrby(this.STATS_KEY, 'total_failed', 1);

            this.logger.error(
              `❌ [REDIS BUFFER] Dado movido para failed após ${this.MAX_TENTATIVAS} tentativas: ${dado.id}`,
            );
          }
        }
      }

      const queueSizeAtual = await this.redis.llen(this.QUEUE_KEY);

      this.logger.log(
        `📊 [REDIS BUFFER] Lote processado: ${sucessos} sucessos, ${falhas} falhas, ${queueSizeAtual} pendentes`,
      );
    } catch (error) {
      this.logger.error(
        `❌ [REDIS BUFFER] Erro ao processar dados pendentes:`,
        error,
      );
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Salva dado no banco
   */
  private async salvarNoBanco(dado: BufferedData): Promise<void> {
    const timestamp = new Date(dado.timestamp);
    const dadosJSON: any = dado.dados;
    const resumo = dadosJSON?.Resumo || dadosJSON;

    const consumoPHF = resumo?.consumo_phf || 0;
    const potenciaW = resumo?.Pt || 0;
    const potenciaKw = potenciaW / 1000;

    // Determinar qualidade
    const temTensao = resumo?.Va > 0 || resumo?.Vb > 0 || resumo?.Vc > 0;
    const temCorrente = resumo?.Ia > 0 || resumo?.Ib > 0 || resumo?.Ic > 0;
    const temPotencia = potenciaW > 0;

    let qualidade = 'ruim';
    if (temTensao) {
      qualidade = temCorrente && temPotencia ? 'boa' : 'parcial';
    }

    await this.prisma.equipamentos_dados.upsert({
      where: {
        uk_equipamento_timestamp: {
          equipamento_id: dado.equipamentoId,
          timestamp_dados: timestamp,
        },
      },
      update: {
        dados: dadosJSON,
        fonte: 'MQTT_REDIS_BUFFER',
        qualidade,
        potencia_ativa_kw: potenciaKw,
        energia_kwh: consumoPHF,
      },
      create: {
        equipamento_id: dado.equipamentoId,
        timestamp_dados: timestamp,
        dados: dadosJSON,
        fonte: 'MQTT_REDIS_BUFFER',
        qualidade,
        potencia_ativa_kw: potenciaKw,
        energia_kwh: consumoPHF,
      },
    });
  }

  /**
   * Inicia retry automático
   */
  private iniciarRetryAutomatico(): void {
    this.retryTimer = setInterval(async () => {
      const queueSize = await this.redis.llen(this.QUEUE_KEY).catch(() => 0);

      if (queueSize > 0) {
        this.logger.debug(
          `🔄 [REDIS BUFFER] Retry automático: ${queueSize} pendentes`,
        );
        await this.processarDadosPendentes();
      }
    }, this.RETRY_INTERVAL);

    this.logger.log(
      `⏰ [REDIS BUFFER] Retry automático ativado (${this.RETRY_INTERVAL / 1000}s)`,
    );
  }

  /**
   * Obtém estatísticas do buffer
   */
  async obterEstatisticas(): Promise<{
    pendentes: number;
    falhados: number;
    totalBuffered: number;
    totalSaved: number;
    totalFailed: number;
    totalSkipped: number;
  }> {
    try {
      const [
        pendentes,
        falhados,
        stats,
      ] = await Promise.all([
        this.redis.llen(this.QUEUE_KEY),
        this.redis.hlen(this.FAILED_KEY),
        this.redis.hgetall(this.STATS_KEY),
      ]);

      return {
        pendentes,
        falhados,
        totalBuffered: parseInt(stats.total_buffered || '0'),
        totalSaved: parseInt(stats.total_saved || '0'),
        totalFailed: parseInt(stats.total_failed || '0'),
        totalSkipped: parseInt(stats.total_skipped || '0'),
      };
    } catch (error) {
      this.logger.error(
        `❌ [REDIS BUFFER] Erro ao obter estatísticas:`,
        error,
      );
      return {
        pendentes: 0,
        falhados: 0,
        totalBuffered: 0,
        totalSaved: 0,
        totalFailed: 0,
        totalSkipped: 0,
      };
    }
  }

  /**
   * Força processamento imediato
   */
  async forcarProcessamento(): Promise<{
    processados: number;
    pendentes: number;
  }> {
    this.logger.log('🚀 [REDIS BUFFER] Forçando processamento imediato...');

    const antes = await this.redis.llen(this.QUEUE_KEY);

    // Processar múltiplos lotes até esvaziar
    while ((await this.redis.llen(this.QUEUE_KEY)) > 0) {
      await this.processarDadosPendentes();
      await new Promise((resolve) => setTimeout(resolve, 100)); // Pequena pausa
    }

    const depois = await this.redis.llen(this.QUEUE_KEY);

    return {
      processados: antes - depois,
      pendentes: depois,
    };
  }

  /**
   * Limpa dados falhados antigos (manutenção)
   */
  async limparDadosFalhados(diasAntigos: number = 30): Promise<number> {
    try {
      const failed = await this.redis.hgetall(this.FAILED_KEY);
      const limitDate = new Date();
      limitDate.setDate(limitDate.getDate() - diasAntigos);

      let removidos = 0;

      for (const [id, dadoJson] of Object.entries(failed)) {
        const dado: BufferedData = JSON.parse(dadoJson);
        const criadoEm = new Date(dado.criadoEm);

        if (criadoEm < limitDate) {
          await this.redis.hdel(this.FAILED_KEY, id);
          removidos++;
        }
      }

      this.logger.log(
        `🧹 [REDIS BUFFER] ${removidos} dados falhados antigos removidos`,
      );

      return removidos;
    } catch (error) {
      this.logger.error(
        `❌ [REDIS BUFFER] Erro ao limpar dados falhados:`,
        error,
      );
      return 0;
    }
  }

  /**
   * Verifica saúde do Redis
   */
  async verificarSaude(): Promise<{
    redis: 'online' | 'offline';
    pendentes: number;
    processando: boolean;
  }> {
    try {
      await this.redis.ping();
      const pendentes = await this.redis.llen(this.QUEUE_KEY);

      return {
        redis: 'online',
        pendentes,
        processando: this.isProcessing,
      };
    } catch (error) {
      return {
        redis: 'offline',
        pendentes: 0,
        processando: false,
      };
    }
  }
}
