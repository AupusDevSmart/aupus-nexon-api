import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class EquipamentosDataService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Obtém o dado mais recente de um equipamento
   */
  async obterDadoAtual(equipamentoId: string) {
    // Verificar se o equipamento existe e buscar informações dele
    const equipamento = await this.prisma.equipamentos.findFirst({
      where: { id: equipamentoId, deleted_at: null },
      include: {
        tipo_equipamento_rel: true,
      },
    });

    if (!equipamento) {
      throw new NotFoundException('Equipamento não encontrado');
    }

    // Última leitura (cadência varia: TON ~1s, A966 ~15min). O consumidor decide
    // se está stale via timestamp_dados; o índice (equipamento_id, timestamp_dados desc)
    // resolve a busca sem full scan.
    const ultimoDado = await this.prisma.equipamentos_dados.findFirst({
      where: { equipamento_id: equipamentoId },
      orderBy: { timestamp_dados: 'desc' },
    });

    if (!ultimoDado) {
      // Retornar estrutura com equipamento mas sem dado
      return {
        equipamento: {
          id: equipamento.id,
          nome: equipamento.nome,
          tipo: equipamento.tipo_equipamento_rel?.nome || equipamento.tipo_equipamento,
          mqtt_habilitado: equipamento.mqtt_habilitado,
          topico_mqtt: equipamento.topico_mqtt,
        },
        dado: null,
        message: 'Nenhum dado MQTT disponível para este equipamento',
      };
    }

    return this.formatDadoResponse(equipamento, ultimoDado);
  }

  /**
   * Obtém histórico de dados de um equipamento
   */
  async obterHistorico(
    equipamentoId: string,
    options: {
      inicio?: Date;
      fim?: Date;
      limite?: number;
      intervalo?: 'raw' | '1min' | '5min' | '1hour' | '1day';
    },
  ) {
    const { inicio, fim, limite = 100, intervalo = 'raw' } = options;

    // Verificar se o equipamento existe
    const equipamento = await this.prisma.equipamentos.findFirst({
      where: { id: equipamentoId, deleted_at: null },
    });

    if (!equipamento) {
      throw new NotFoundException('Equipamento não encontrado');
    }

    // Construir filtro de datas
    const whereClause: any = {
      equipamento_id: equipamentoId,
    };

    if (inicio || fim) {
      whereClause.timestamp_dados = {};
      if (inicio) whereClause.timestamp_dados.gte = inicio;
      if (fim) whereClause.timestamp_dados.lte = fim;
    }

    // Buscar dados
    const dados = await this.prisma.equipamentos_dados.findMany({
      where: whereClause,
      orderBy: { timestamp_dados: 'desc' },
      take: limite,
    });

    // TODO: Implementar agrupamento por intervalo
    // Por enquanto retorna raw data
    const dadosFormatados = dados.map((dado) => ({
      id: dado.id,
      timestamp_dados: dado.timestamp_dados,
      dados: dado.dados,
      qualidade: dado.qualidade,
      fonte: dado.fonte,
      created_at: dado.created_at,
    }));

    return {
      data: dadosFormatados,
      pagination: {
        page: 1,
        limit: limite,
        total: dadosFormatados.length,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    };
  }

  /**
   * Formata resposta de um dado
   */
  private formatDadoResponse(equipamento: any, dado: any) {
    return {
      equipamento: {
        id: equipamento.id,
        nome: equipamento.nome,
        tipo: equipamento.tipo_equipamento_rel?.nome || equipamento.tipo_equipamento,
        mqtt_habilitado: equipamento.mqtt_habilitado,
        topico_mqtt: equipamento.topico_mqtt,
      },
      dado: {
        id: dado.id,
        dados: dado.dados,
        fonte: dado.fonte,
        timestamp_dados: dado.timestamp_dados,
        qualidade: dado.qualidade,
        created_at: dado.created_at,
      },
    };
  }
}
