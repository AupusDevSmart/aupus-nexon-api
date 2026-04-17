import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '@aupus/api-shared';
import { getValueByPath, avaliarCondicao } from './regras-logs-mqtt.helpers';

interface RegraCache {
  id: string;
  equipamento_id: string;
  campo_json: string;
  operador: string;
  valor: number;
  mensagem: string;
  severidade: string;
  cooldown_minutos: number;
}

@Injectable()
export class RegrasLogsMqttEngine implements OnModuleInit {
  private readonly logger = new Logger(RegrasLogsMqttEngine.name);

  // Cache: equipamentoId -> regras ativas
  private regrasCache = new Map<string, RegraCache[]>();

  // Cooldown: regraId -> timestamp do ultimo log
  private cooldownCache = new Map<string, Date>();

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.recarregarCache();
  }

  async recarregarCache() {
    try {
      const regras = await this.prisma.regras_logs_mqtt.findMany({
        where: { ativo: true, deleted_at: null },
      });

      this.regrasCache.clear();

      for (const regra of regras) {
        const eqId = regra.equipamento_id.trim();
        const regraCache: RegraCache = {
          id: regra.id.trim(),
          equipamento_id: eqId,
          campo_json: regra.campo_json,
          operador: regra.operador,
          valor: Number(regra.valor),
          mensagem: regra.mensagem,
          severidade: regra.severidade,
          cooldown_minutos: regra.cooldown_minutos,
        };

        if (!this.regrasCache.has(eqId)) {
          this.regrasCache.set(eqId, []);
        }
        this.regrasCache.get(eqId).push(regraCache);
      }

      this.logger.log(
        `Cache carregado: ${regras.length} regras para ${this.regrasCache.size} equipamentos`,
      );
    } catch (error) {
      this.logger.error('Erro ao carregar cache de regras:', error.message);
    }
  }

  /**
   * Verifica todas as regras de um equipamento contra os dados recebidos.
   * Chamado pelo MqttService apos processar cada mensagem.
   */
  async verificar(equipamentoId: string, dadosJson: any) {
    const eqId = equipamentoId.trim();
    const regras = this.regrasCache.get(eqId);
    if (!regras || regras.length === 0) return;

    for (const regra of regras) {
      try {
        const valorLido = getValueByPath(dadosJson, regra.campo_json);

        // Campo nao existe ou nao eh numerico
        if (valorLido === undefined || valorLido === null || typeof valorLido !== 'number') {
          continue;
        }

        const condicaoAtendida = avaliarCondicao(valorLido, regra.operador, regra.valor);
        if (!condicaoAtendida) continue;

        // Checar cooldown
        const ultimoLog = this.cooldownCache.get(regra.id);
        if (ultimoLog) {
          const diffMs = Date.now() - ultimoLog.getTime();
          const cooldownMs = regra.cooldown_minutos * 60 * 1000;
          if (diffMs < cooldownMs) continue;
        }

        // Salvar log
        await this.salvarLog(regra, valorLido, dadosJson);
        this.cooldownCache.set(regra.id, new Date());
      } catch (error) {
        this.logger.error(
          `Erro ao verificar regra ${regra.id}: ${error.message}`,
        );
      }
    }
  }

  private async salvarLog(regra: RegraCache, valorLido: number, dadosJson: any) {
    // Snapshot parcial: campo da regra + timestamp se existir
    const snapshot: any = {};
    snapshot[regra.campo_json] = valorLido;
    if (dadosJson.timestamp) snapshot.timestamp = dadosJson.timestamp;
    if (dadosJson.Resumo?.timestamp) snapshot['Resumo.timestamp'] = dadosJson.Resumo.timestamp;

    await this.prisma.logs_mqtt.create({
      data: {
        regra_id: regra.id,
        equipamento_id: regra.equipamento_id,
        valor_lido: valorLido,
        mensagem: regra.mensagem,
        severidade: regra.severidade,
        dados_snapshot: snapshot,
      },
    });

    this.logger.log(
      `[LOG] ${regra.mensagem} | ${regra.campo_json} ${regra.operador} ${regra.valor} | lido: ${valorLido}`,
    );
  }
}
