import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@aupus/api-shared';
import { CreateConexaoDto, CreateConexoesBulkDto } from '../dto/create-conexao.dto';

@Injectable()
export class ConexoesDiagramaService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cria uma conexão entre dois equipamentos (V2 - Simplificado)
   * Sem customização visual - tudo usa padrão
   */
  async create(diagramaId: string, dto: CreateConexaoDto) {
    const { origem, destino } = dto;

    // 1. Verificar se o diagrama existe
    const diagrama = await this.prisma.diagramas_unitarios.findFirst({
      where: { id: diagramaId, deleted_at: null },
    });

    if (!diagrama) {
      throw new NotFoundException('Diagrama não encontrado');
    }

    // 2. Verificar se o equipamento de origem existe e está no diagrama
    const equipOrigem = await this.prisma.equipamentos.findFirst({
      where: {
        id: origem.equipamentoId,
        diagrama_id: diagramaId,
        deleted_at: null,
      },
    });

    if (!equipOrigem) {
      throw new BadRequestException(
        'Equipamento de origem não encontrado ou não está no diagrama',
      );
    }

    // 3. Verificar se o equipamento de destino existe e está no diagrama
    const equipDestino = await this.prisma.equipamentos.findFirst({
      where: {
        id: destino.equipamentoId,
        diagrama_id: diagramaId,
        deleted_at: null,
      },
    });

    if (!equipDestino) {
      throw new BadRequestException(
        'Equipamento de destino não encontrado ou não está no diagrama',
      );
    }

    // 4. Validar portas
    const portasValidas = ['top', 'bottom', 'left', 'right'];
    if (!portasValidas.includes(origem.porta)) {
      throw new BadRequestException('Porta de origem inválida');
    }
    if (!portasValidas.includes(destino.porta)) {
      throw new BadRequestException('Porta de destino inválida');
    }

    // 5. Criar conexão (sem campos de customização visual)
    const conexao = await this.prisma.equipamentos_conexoes.create({
      data: {
        diagrama_id: diagramaId,
        equipamento_origem_id: origem.equipamentoId,
        porta_origem: origem.porta,
        equipamento_destino_id: destino.equipamentoId,
        porta_destino: destino.porta,
      },
      include: {
        equipamento_origem: {
          select: { id: true, nome: true, tag: true },
        },
        equipamento_destino: {
          select: { id: true, nome: true, tag: true },
        },
      },
    });

    return this.formatConexaoResponse(conexao);
  }

  /**
   * @deprecated V2 - Não usar mais. Use PUT /diagramas/:id/layout
   * Atualizar conexões individualmente não é eficiente.
   * Use o salvamento atômico completo do layout.
   */
  async update(diagramaId: string, conexaoId: string, _dto: any) {
    throw new BadRequestException(
      'Endpoint descontinuado. Use PUT /diagramas/:id/layout para salvar o layout completo.'
    );
  }

  /**
   * Remove uma conexão
   */
  async remove(diagramaId: string, conexaoId: string) {
    // 1. Verificar se a conexão existe e pertence ao diagrama
    const conexao = await this.prisma.equipamentos_conexoes.findFirst({
      where: {
        id: conexaoId,
        diagrama_id: diagramaId,
        deleted_at: null,
      },
    });

    if (!conexao) {
      throw new NotFoundException(
        'Conexão não encontrada ou não pertence ao diagrama',
      );
    }

    // 2. Soft delete da conexão
    await this.prisma.equipamentos_conexoes.update({
      where: { id: conexaoId },
      data: { deleted_at: new Date() },
    });

    return {
      id: conexaoId,
      message: 'Conexão removida com sucesso',
      deletedAt: new Date(),
    };
  }

  /**
   * Cria múltiplas conexões de uma vez
   */
  async createBulk(diagramaId: string, dto: CreateConexoesBulkDto) {
    const { conexoes } = dto;

    const resultados = {
      criadas: 0,
      erros: 0,
      conexoes: [],
    };

    for (const conexaoDto of conexoes) {
      try {
        const resultado = await this.create(diagramaId, conexaoDto);
        resultados.criadas++;
        resultados.conexoes.push({
          ...resultado,
          status: 'created',
        });
      } catch (error) {
        resultados.erros++;
        resultados.conexoes.push({
          origem: conexaoDto.origem,
          destino: conexaoDto.destino,
          status: 'error',
          error: error.message,
        });
      }
    }

    return resultados;
  }

  /**
   * Remove todas as conexões de um diagrama
   */
  async removeAll(diagramaId: string) {
    const resultado = await this.prisma.equipamentos_conexoes.updateMany({
      where: {
        diagrama_id: diagramaId,
        deleted_at: null,
      },
      data: { deleted_at: new Date() },
    });

    return {
      diagramaId,
      message: 'Todas as conexões foram removidas',
      totalRemovidas: resultado.count,
      deletedAt: new Date(),
    };
  }

  /**
   * Remove conexões duplicadas de um diagrama
   */
  async removeDuplicates(diagramaId: string) {
    const conexoes = await this.prisma.equipamentos_conexoes.findMany({
      where: {
        diagrama_id: diagramaId,
        deleted_at: null,
      },
      orderBy: {
        created_at: 'desc',
      },
    });

    const conexoesUnicas = new Map<string, string>();
    const conexoesDuplicadas: string[] = [];

    for (const conexao of conexoes) {
      const chave = `${conexao.equipamento_origem_id}-${conexao.equipamento_destino_id}`;

      if (conexoesUnicas.has(chave)) {
        conexoesDuplicadas.push(conexao.id);
      } else {
        conexoesUnicas.set(chave, conexao.id);
      }
    }

    if (conexoesDuplicadas.length > 0) {
      await this.prisma.equipamentos_conexoes.updateMany({
        where: {
          id: { in: conexoesDuplicadas },
        },
        data: { deleted_at: new Date() },
      });
    }

    return {
      diagramaId,
      message: 'Conexões duplicadas removidas',
      totalDuplicadas: conexoesDuplicadas.length,
      totalUnicas: conexoesUnicas.size,
      deletedAt: new Date(),
    };
  }

  /**
   * Formata a resposta da conexão (V2 - Simplificado)
   */
  private formatConexaoResponse(conexao: any) {
    return {
      id: conexao.id,
      diagramaId: conexao.diagrama_id,
      origem: {
        equipamentoId: conexao.equipamento_origem_id,
        equipamento: conexao.equipamento_origem,
        porta: conexao.porta_origem,
      },
      destino: {
        equipamentoId: conexao.equipamento_destino_id,
        equipamento: conexao.equipamento_destino,
        porta: conexao.porta_destino,
      },
      createdAt: conexao.created_at,
      updatedAt: conexao.updated_at,
    };
  }
}
