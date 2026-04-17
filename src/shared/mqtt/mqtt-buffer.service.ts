import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '@aupus/api-shared';

/**
 * Serviço de Buffer Persistente para dados MQTT
 *
 * Funcionalidades:
 * - Salva dados em disco quando banco de dados falha
 * - Tenta reprocessar dados pendentes automaticamente
 * - Garante que nenhum dado MQTT seja perdido
 */

interface BufferedData {
  id: string;
  equipamentoId: string;
  timestamp: Date;
  dados: any;
  tentativas: number;
  ultimaTentativa: Date;
  criadoEm: Date;
}

@Injectable()
export class MqttBufferService implements OnModuleInit {
  private readonly logger = new Logger(MqttBufferService.name);
  private readonly bufferDir: string;
  private readonly bufferFile: string;
  private readonly maxTentativas = 10;
  private readonly retryInterval = 30000; // 30 segundos
  private retryTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(private readonly prisma: PrismaService) {
    // Diretório para armazenar buffer
    this.bufferDir = path.join(process.cwd(), 'mqtt-buffer');
    this.bufferFile = path.join(this.bufferDir, 'pending-data.json');

    // Criar diretório se não existir
    if (!fs.existsSync(this.bufferDir)) {
      fs.mkdirSync(this.bufferDir, { recursive: true });
      this.logger.log(`📁 Diretório de buffer criado: ${this.bufferDir}`);
    }
  }

  async onModuleInit() {
    this.logger.log('🔄 Iniciando serviço de buffer MQTT...');

    // Tentar processar dados pendentes ao iniciar
    await this.processarDadosPendentes();

    // Iniciar timer de retry automático
    this.iniciarRetryAutomatico();
  }

  /**
   * Salva dados no buffer quando o banco falha
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
        timestamp,
        dados,
        tentativas: 0,
        ultimaTentativa: new Date(),
        criadoEm: new Date(),
      };

      // Ler buffer atual
      const dadosAtuais = this.lerBuffer();

      // Adicionar novo dado
      dadosAtuais.push(bufferedData);

      // Salvar de volta
      this.salvarBuffer(dadosAtuais);

      this.logger.warn(
        `💾 [BUFFER] Dados salvos em disco: ${equipamentoId} @ ${timestamp.toISOString()} (Total no buffer: ${dadosAtuais.length})`,
      );
    } catch (error) {
      this.logger.error(
        `❌ [BUFFER] Erro crítico ao salvar dados no buffer em disco:`,
        error,
      );
      // Em caso extremo, tentar salvar em arquivo separado
      this.salvarBackupEmergencia(equipamentoId, timestamp, dados);
    }
  }

  /**
   * Salva backup de emergência se até o buffer principal falhar
   */
  private salvarBackupEmergencia(
    equipamentoId: string,
    timestamp: Date,
    dados: any,
  ): void {
    try {
      const emergencyFile = path.join(
        this.bufferDir,
        `emergency_${Date.now()}.json`,
      );

      fs.writeFileSync(
        emergencyFile,
        JSON.stringify(
          {
            equipamentoId,
            timestamp,
            dados,
            criadoEm: new Date(),
          },
          null,
          2,
        ),
      );

      this.logger.error(
        `🚨 [BACKUP EMERGÊNCIA] Dados salvos em arquivo separado: ${emergencyFile}`,
      );
    } catch (err) {
      this.logger.error(
        `💀 [FALHA CRÍTICA] Não foi possível salvar dados nem em backup de emergência!`,
        err,
      );
    }
  }

  /**
   * Lê dados do buffer
   */
  private lerBuffer(): BufferedData[] {
    try {
      if (!fs.existsSync(this.bufferFile)) {
        return [];
      }

      const conteudo = fs.readFileSync(this.bufferFile, 'utf-8');

      if (!conteudo.trim()) {
        return [];
      }

      const dados = JSON.parse(conteudo);

      // Converter strings de data de volta para Date
      return dados.map((d: any) => ({
        ...d,
        timestamp: new Date(d.timestamp),
        ultimaTentativa: new Date(d.ultimaTentativa),
        criadoEm: new Date(d.criadoEm),
      }));
    } catch (error) {
      this.logger.error(`❌ [BUFFER] Erro ao ler buffer:`, error);
      // Se o arquivo estiver corrompido, renomear para preservar
      this.preservarBufferCorrompido();
      return [];
    }
  }

  /**
   * Salva dados no buffer
   */
  private salvarBuffer(dados: BufferedData[]): void {
    try {
      fs.writeFileSync(
        this.bufferFile,
        JSON.stringify(dados, null, 2),
        'utf-8',
      );
    } catch (error) {
      this.logger.error(`❌ [BUFFER] Erro ao salvar buffer:`, error);
      throw error;
    }
  }

  /**
   * Preserva buffer corrompido para análise posterior
   */
  private preservarBufferCorrompido(): void {
    try {
      const backupFile = path.join(
        this.bufferDir,
        `corrupted_${Date.now()}.json`,
      );
      fs.copyFileSync(this.bufferFile, backupFile);
      this.logger.warn(
        `⚠️ [BUFFER] Buffer corrompido preservado em: ${backupFile}`,
      );
      // Limpar o arquivo original
      fs.writeFileSync(this.bufferFile, '[]', 'utf-8');
    } catch (error) {
      this.logger.error(
        `❌ [BUFFER] Erro ao preservar buffer corrompido:`,
        error,
      );
    }
  }

  /**
   * Processa dados pendentes do buffer
   */
  async processarDadosPendentes(): Promise<void> {
    // Evitar processamento concorrente
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    try {
      const dadosPendentes = this.lerBuffer();

      if (dadosPendentes.length === 0) {
        return;
      }

      this.logger.log(
        `🔄 [BUFFER] Processando ${dadosPendentes.length} dados pendentes...`,
      );

      const dadosRestantes: BufferedData[] = [];
      let sucessos = 0;
      let falhas = 0;

      for (const dado of dadosPendentes) {
        try {
          // Verificar se já existe no banco (evitar duplicatas)
          const existe = await this.prisma.equipamentos_dados.findFirst({
            where: {
              equipamento_id: dado.equipamentoId,
              timestamp_dados: dado.timestamp,
            },
            select: { id: true },
          });

          if (existe) {
            this.logger.debug(
              `⏭️ [BUFFER] Dado já existe no banco, pulando: ${dado.id}`,
            );
            sucessos++;
            continue;
          }

          // Tentar salvar no banco
          await this.salvarNoBanco(dado);

          sucessos++;
          this.logger.log(
            `✅ [BUFFER] Dado processado com sucesso: ${dado.equipamentoId} @ ${dado.timestamp.toISOString()}`,
          );
        } catch (error) {
          falhas++;
          dado.tentativas++;
          dado.ultimaTentativa = new Date();

          // Se ainda há tentativas restantes, manter no buffer
          if (dado.tentativas < this.maxTentativas) {
            dadosRestantes.push(dado);
            this.logger.warn(
              `⚠️ [BUFFER] Falha ao processar (tentativa ${dado.tentativas}/${this.maxTentativas}): ${dado.id}`,
            );
          } else {
            // Excedeu tentativas - mover para arquivo de dados órfãos
            this.moverParaOrfaos(dado);
            this.logger.error(
              `❌ [BUFFER] Dado descartado após ${this.maxTentativas} tentativas: ${dado.id}`,
            );
          }
        }
      }

      // Salvar dados restantes no buffer
      this.salvarBuffer(dadosRestantes);

      this.logger.log(
        `📊 [BUFFER] Processamento concluído: ${sucessos} sucessos, ${falhas} falhas, ${dadosRestantes.length} pendentes`,
      );
    } catch (error) {
      this.logger.error(
        `❌ [BUFFER] Erro ao processar dados pendentes:`,
        error,
      );
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Salva dado no banco de dados
   */
  private async salvarNoBanco(dado: BufferedData): Promise<void> {
    // Extrair campos necessários
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

    // Salvar usando upsert para evitar duplicatas
    await this.prisma.equipamentos_dados.upsert({
      where: {
        uk_equipamento_timestamp: {
          equipamento_id: dado.equipamentoId,
          timestamp_dados: dado.timestamp,
        },
      },
      update: {
        dados: dadosJSON,
        fonte: 'MQTT_BUFFER',
        qualidade,
        potencia_ativa_kw: potenciaKw,
        energia_kwh: consumoPHF,
      },
      create: {
        equipamento_id: dado.equipamentoId,
        timestamp_dados: dado.timestamp,
        dados: dadosJSON,
        fonte: 'MQTT_BUFFER',
        qualidade,
        potencia_ativa_kw: potenciaKw,
        energia_kwh: consumoPHF,
      },
    });
  }

  /**
   * Move dados órfãos (que falharam muitas vezes) para arquivo separado
   */
  private moverParaOrfaos(dado: BufferedData): void {
    try {
      const orfaosFile = path.join(this.bufferDir, 'orphaned-data.json');

      let orfaos: BufferedData[] = [];

      // Ler órfãos existentes
      if (fs.existsSync(orfaosFile)) {
        const conteudo = fs.readFileSync(orfaosFile, 'utf-8');
        if (conteudo.trim()) {
          orfaos = JSON.parse(conteudo);
        }
      }

      // Adicionar novo órfão
      orfaos.push(dado);

      // Salvar
      fs.writeFileSync(orfaosFile, JSON.stringify(orfaos, null, 2), 'utf-8');

      this.logger.warn(
        `🗂️ [BUFFER] Dado órfão salvo em: ${orfaosFile} (Total: ${orfaos.length})`,
      );
    } catch (error) {
      this.logger.error(`❌ [BUFFER] Erro ao mover dados para órfãos:`, error);
    }
  }

  /**
   * Inicia retry automático em segundo plano
   */
  private iniciarRetryAutomatico(): void {
    this.retryTimer = setInterval(async () => {
      const dadosPendentes = this.lerBuffer();

      if (dadosPendentes.length > 0) {
        this.logger.debug(
          `🔄 [BUFFER] Retry automático: ${dadosPendentes.length} dados pendentes`,
        );
        await this.processarDadosPendentes();
      }
    }, this.retryInterval);

    this.logger.log(
      `⏰ [BUFFER] Retry automático configurado (a cada ${this.retryInterval / 1000}s)`,
    );
  }

  /**
   * Para o serviço de retry
   */
  onModuleDestroy() {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.logger.log('🛑 [BUFFER] Retry automático parado');
    }

    // Tentar processar dados pendentes uma última vez antes de desligar
    this.processarDadosPendentes().catch((error) => {
      this.logger.error(
        `❌ [BUFFER] Erro ao processar dados pendentes no shutdown:`,
        error,
      );
    });
  }

  /**
   * Retorna estatísticas do buffer
   */
  async obterEstatisticas(): Promise<{
    pendentes: number;
    orfaos: number;
    ultimaTentativa: Date | null;
  }> {
    const pendentes = this.lerBuffer();

    let orfaos = 0;
    const orfaosFile = path.join(this.bufferDir, 'orphaned-data.json');
    if (fs.existsSync(orfaosFile)) {
      try {
        const conteudo = fs.readFileSync(orfaosFile, 'utf-8');
        if (conteudo.trim()) {
          orfaos = JSON.parse(conteudo).length;
        }
      } catch (error) {
        this.logger.error(
          `❌ [BUFFER] Erro ao ler estatísticas de órfãos:`,
          error,
        );
      }
    }

    const ultimaTentativa =
      pendentes.length > 0
        ? pendentes.reduce((max, d) =>
            d.ultimaTentativa > max ? d.ultimaTentativa : max,
            pendentes[0].ultimaTentativa,
          )
        : null;

    return {
      pendentes: pendentes.length,
      orfaos,
      ultimaTentativa,
    };
  }

  /**
   * Força processamento imediato dos dados pendentes
   */
  async forcarProcessamento(): Promise<{
    processados: number;
    pendentes: number;
    falhas: number;
  }> {
    this.logger.log('🚀 [BUFFER] Forçando processamento imediato...');

    const dadosAntes = this.lerBuffer().length;
    await this.processarDadosPendentes();
    const dadosDepois = this.lerBuffer().length;

    const processados = dadosAntes - dadosDepois;
    const falhas = dadosDepois;

    return {
      processados,
      pendentes: dadosDepois,
      falhas,
    };
  }
}
