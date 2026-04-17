import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '@aupus/api-shared';
import { CreateDiagramaDto } from '../dto/create-diagrama.dto';
import { UpdateDiagramaDto } from '../dto/update-diagrama.dto';
import { SaveLayoutDto } from '../dto/save-layout.dto';

@Injectable()
export class DiagramasService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cria um novo diagrama para uma unidade
   */
  async create(createDiagramaDto: CreateDiagramaDto) {
    const { unidadeId, nome, descricao, ativo, configuracoes } = createDiagramaDto;

    // Verificar se a unidade existe
    const unidade = await this.prisma.unidades.findUnique({
      where: { id: unidadeId, deleted_at: null },
    });

    if (!unidade) {
      throw new NotFoundException('Unidade não encontrada');
    }

    // Configurações padrão se não fornecidas
    const configPadrao = {
      zoom: 1.0,
      grid: {
        enabled: true,
        size: 20,
        snapToGrid: true,
      },
      canvas: {
        width: 2000,
        height: 1500,
        backgroundColor: '#f5f5f5',
      },
      viewport: {
        x: 0,
        y: 0,
        scale: 1.0,
      },
      ...configuracoes,
    };

    // Criar diagrama
    const diagrama = await this.prisma.diagramas_unitarios.create({
      data: {
        unidade_id: unidadeId,
        nome,
        descricao,
        versao: '1.0',
        ativo: ativo !== undefined ? ativo : true,
        configuracoes: configPadrao as any,
      },
    });

    return this.formatDiagramaResponse(diagrama);
  }

  /**
   * Busca todos os diagramas de uma unidade
   */
  async findByUnidade(unidadeId: string, proprietarioId?: string | null) {
    // Verificar se a unidade existe e pertence ao proprietário (se fornecido)
    const whereUnidade: any = {
      id: unidadeId,
      deleted_at: null,
    };

    // Se proprietarioId fornecido, adicionar filtro
    if (proprietarioId) {
      whereUnidade.planta = {
        proprietario_id: proprietarioId,
      };
    }

    const unidade = await this.prisma.unidades.findFirst({
      where: whereUnidade,
    });

    if (!unidade) {
      const message = proprietarioId
        ? 'Unidade não encontrada ou você não tem permissão para acessá-la'
        : 'Unidade não encontrada';
      throw new NotFoundException(message);
    }

    // Buscar diagramas da unidade
    const diagramas = await this.prisma.diagramas_unitarios.findMany({
      where: {
        unidade_id: unidadeId,
        deleted_at: null,
      },
      orderBy: {
        created_at: 'desc',
      },
    });

    // Buscar contagem de equipamentos e conexões para cada diagrama
    const diagramasComEstatisticas = await Promise.all(
      diagramas.map(async (diagrama) => {
        const [totalEquipamentos, totalConexoes] = await Promise.all([
          this.prisma.equipamentos.count({
            where: {
              diagrama_id: diagrama.id,
              deleted_at: null,
            },
          }),
          this.prisma.equipamentos_conexoes.count({
            where: {
              diagrama_id: diagrama.id,
              deleted_at: null,
            },
          }),
        ]);

        return {
          id: diagrama.id,
          nome: diagrama.nome,
          descricao: diagrama.descricao,
          versao: diagrama.versao,
          ativo: diagrama.ativo,
          unidadeId: diagrama.unidade_id,
          configuracoes: diagrama.configuracoes,
          thumbnailUrl: diagrama.thumbnail_url,
          estatisticas: {
            totalEquipamentos,
            totalConexoes,
          },
          createdAt: diagrama.created_at,
          updatedAt: diagrama.updated_at,
        };
      })
    );

    return diagramasComEstatisticas;
  }

  /**
   * Busca um diagrama por ID com opção de incluir dados em tempo real
   */
  async findOne(id: string, includeData = false, proprietarioId?: string | null) {
    const diagrama = await this.prisma.diagramas_unitarios.findFirst({
      where: {
        id,
        deleted_at: null,
      },
    });

    if (!diagrama) {
      throw new NotFoundException('Diagrama não encontrado');
    }

    // Buscar unidade com planta e proprietário
    const unidade = await this.prisma.unidades.findUnique({
      where: { id: diagrama.unidade_id },
      select: {
        id: true,
        nome: true,
        tipo: true,
        potencia: true,
        planta: {
          select: {
            proprietario_id: true,
          },
        },
      },
    });

    // Se proprietarioId foi fornecido, validar que o diagrama pertence ao usuário
    if (proprietarioId && unidade?.planta?.proprietario_id !== proprietarioId) {
      throw new NotFoundException('Diagrama não encontrado ou você não tem permissão para acessá-lo');
    }

    // ⚡ OTIMIZAÇÃO: Buscar equipamentos COM tipos em uma única query (JOIN)
    const equipamentos = await this.prisma.equipamentos.findMany({
      where: {
        diagrama_id: id,
        deleted_at: null,
      },
      // ⚡ Fazer JOIN com tipo e categoria em uma única query
      include: {
        tipo_equipamento_rel: {
          include: {
            categoria: true,
          },
        },
      },
    });

    // ⚡ Formatar equipamentos (tipo já vem do JOIN)
    const equipamentosFormatados = equipamentos.map((eq) => {
      const tipoRel = eq.tipo_equipamento_rel;
      const tipoFormatado = tipoRel ? {
        id: tipoRel.id,
        codigo: tipoRel.codigo,
        nome: tipoRel.nome,
        categoria: tipoRel.categoria,
        larguraPadrao: tipoRel.largura_padrao,
        alturaPadrao: tipoRel.altura_padrao,
        iconeSvg: tipoRel.icone_svg,
      } : null;

      return {
        id: eq.id,
        nome: eq.nome,
        tag: eq.tag,
        classificacao: eq.classificacao,
        tipo_equipamento: eq.tipo_equipamento,
        // ✅ Retornar em AMBOS os formatos para compatibilidade
        tipo: tipoFormatado,
        tipoEquipamento: tipoFormatado,
        tipo_equipamento_rel: tipoFormatado,
        // ✅ CORRIGIDO: Retornar posições no nível raiz (não aninhado)
        posicao_x: eq.posicao_x,
        posicao_y: eq.posicao_y,
        rotacao: eq.rotacao || 0,
        label_position: eq.label_position,
        label_offset_x: eq.label_offset_x,
        label_offset_y: eq.label_offset_y,
        dimensoes: {
          largura: tipoRel?.largura_padrao || 64,
          altura: tipoRel?.altura_padrao || 64,
        },
        status: eq.status,
        // Campos MQTT para integração com dados em tempo real
        mqtt_habilitado: eq.mqtt_habilitado,
        topico_mqtt: eq.topico_mqtt,
        fabricante: eq.fabricante,
        modelo: eq.modelo,
        // Se includeData=true, buscar dados em tempo real (implementar depois com MQTT)
        dadosTempoReal: includeData ? null : undefined,
      };
    });

    // ⚡ OTIMIZAÇÃO: Buscar conexões COM equipamentos em uma única query (JOIN)
    const conexoes = await this.prisma.equipamentos_conexoes.findMany({
      where: {
        diagrama_id: id,
        deleted_at: null,
      },
      // ⚡ Fazer JOIN com equipamentos de origem e destino
      include: {
        equipamento_origem: true,
        equipamento_destino: true,
      },
    });

    // ⚡ Formatar conexões (equipamentos já vêm do JOIN)
    // ✅ Suporte a junction points
    const conexoesFormatadas = conexoes.map((conn) => ({
      id: conn.id,
      diagramaId: conn.diagrama_id,
      origem: {
        tipo: (conn as any).origem_tipo || 'equipamento',
        equipamentoId: conn.equipamento_origem_id,
        equipamento: conn.equipamento_origem,
        gridPoint: (conn as any).origem_tipo === 'junction'
          ? { x: (conn as any).origem_grid_x, y: (conn as any).origem_grid_y }
          : null,
        porta: conn.porta_origem,
      },
      destino: {
        tipo: (conn as any).destino_tipo || 'equipamento',
        equipamentoId: conn.equipamento_destino_id,
        equipamento: conn.equipamento_destino,
        gridPoint: (conn as any).destino_tipo === 'junction'
          ? { x: (conn as any).destino_grid_x, y: (conn as any).destino_grid_y }
          : null,
        porta: conn.porta_destino,
      },
      createdAt: conn.created_at,
      updatedAt: conn.updated_at,
    }));

    // Estatísticas
    const estatisticas = {
      totalEquipamentos: equipamentos.length,
      equipamentosPorStatus: this.contarPorStatus(equipamentos),
      totalConexoes: conexoesFormatadas.length,
    };

    console.log('📤 [FIND ONE] Configurações do diagrama sendo retornadas:', JSON.stringify(diagrama.configuracoes, null, 2));
    const configs = diagrama.configuracoes as any;
    if (configs?.labelPositions) {
      console.log('✅ [FIND ONE] labelPositions encontrado com', Object.keys(configs.labelPositions).length, 'entradas');
    } else {
      console.log('⚠️ [FIND ONE] labelPositions NÃO encontrado nas configurações');
    }

    return {
      id: diagrama.id,
      nome: diagrama.nome,
      descricao: diagrama.descricao,
      versao: diagrama.versao,
      ativo: diagrama.ativo,
      unidadeId: diagrama.unidade_id,
      unidade,
      configuracoes: diagrama.configuracoes,
      thumbnailUrl: diagrama.thumbnail_url,
      equipamentos: equipamentosFormatados,
      conexoes: conexoesFormatadas,
      estatisticas,
      createdAt: diagrama.created_at,
      updatedAt: diagrama.updated_at,
    };
  }

  /**
   * Atualiza um diagrama
   */
  async update(id: string, updateDiagramaDto: UpdateDiagramaDto) {
    // Verificar se o diagrama existe
    const diagramaExistente = await this.prisma.diagramas_unitarios.findFirst({
      where: { id, deleted_at: null },
    });

    if (!diagramaExistente) {
      throw new NotFoundException('Diagrama não encontrado');
    }

    const { unidadeId, nome, descricao, configuracoes, ativo } = updateDiagramaDto;

    // Se mudou de unidade, verificar se a nova existe
    if (unidadeId && unidadeId !== diagramaExistente.unidade_id) {
      const unidade = await this.prisma.unidades.findUnique({
        where: { id: unidadeId, deleted_at: null },
      });

      if (!unidade) {
        throw new NotFoundException('Unidade não encontrada');
      }
    }

    // Mesclar configurações existentes com as novas
    const configExistente = diagramaExistente.configuracoes as any || {};
    console.log('🔍 [UPDATE DIAGRAMA] Configurações existentes:', JSON.stringify(configExistente, null, 2));
    console.log('🔍 [UPDATE DIAGRAMA] Novas configurações recebidas:', JSON.stringify(configuracoes, null, 2));

    const novasConfiguracoes = configuracoes
      ? { ...configExistente, ...configuracoes }
      : diagramaExistente.configuracoes;

    console.log('✅ [UPDATE DIAGRAMA] Configurações após merge:', JSON.stringify(novasConfiguracoes, null, 2));

    // Incrementar versão
    const versaoAtual = diagramaExistente.versao.split('.');
    const versaoNova = `${versaoAtual[0]}.${parseInt(versaoAtual[1]) + 1}`;

    // Atualizar diagrama
    const diagramaAtualizado = await this.prisma.diagramas_unitarios.update({
      where: { id },
      data: {
        unidade_id: unidadeId,
        nome,
        descricao,
        configuracoes: novasConfiguracoes as any,
        ativo,
        versao: versaoNova,
      },
    });

    return this.formatDiagramaResponse(diagramaAtualizado);
  }

  /**
   * Remove um diagrama (soft delete)
   */
  async remove(id: string) {
    // Verificar se o diagrama existe
    const diagrama = await this.prisma.diagramas_unitarios.findFirst({
      where: { id, deleted_at: null },
    });

    if (!diagrama) {
      throw new NotFoundException('Diagrama não encontrado');
    }

    // Soft delete em uma transação
    await this.prisma.$transaction(async (tx) => {
      // 1. Soft delete das conexões
      await tx.equipamentos_conexoes.updateMany({
        where: { diagrama_id: id },
        data: { deleted_at: new Date() },
      });

      // 2. Limpar diagrama_id, posicao_x, posicao_y dos equipamentos
      await tx.equipamentos.updateMany({
        where: { diagrama_id: id },
        data: {
          diagrama_id: null,
          posicao_x: null,
          posicao_y: null,
          rotacao: null,
        },
      });

      // 3. Soft delete do diagrama
      await tx.diagramas_unitarios.update({
        where: { id },
        data: { deleted_at: new Date() },
      });
    });

    return {
      id,
      message: 'Diagrama removido com sucesso',
      deletedAt: new Date(),
    };
  }

  /**
   * Formata a resposta do diagrama
   */
  private formatDiagramaResponse(diagrama: any) {
    console.log('📤 [FORMAT RESPONSE] Configurações sendo retornadas:', JSON.stringify(diagrama.configuracoes, null, 2));
    return {
      id: diagrama.id,
      nome: diagrama.nome,
      descricao: diagrama.descricao,
      versao: diagrama.versao,
      ativo: diagrama.ativo,
      unidadeId: diagrama.unidade_id,
      configuracoes: diagrama.configuracoes,
      thumbnailUrl: diagrama.thumbnail_url,
      createdAt: diagrama.created_at,
      updatedAt: diagrama.updated_at,
    };
  }

  /**
   * Conta equipamentos por status
   */
  private contarPorStatus(equipamentos: any[]) {
    return equipamentos.reduce((acc, eq) => {
      const status = eq.status || 'DESCONHECIDO';
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {});
  }

  /**
   * V2 - Salvar layout completo do diagrama (atômico)
   * Estratégia: DELETE ALL + INSERT ALL em uma única transação
   * ~10x mais rápido que múltiplas requisições PATCH
   */
  async saveLayout(diagramaId: string, dto: SaveLayoutDto) {
    // Verificar se o diagrama existe
    const diagrama = await this.prisma.diagramas_unitarios.findFirst({
      where: { id: diagramaId, deleted_at: null },
    });

    if (!diagrama) {
      throw new NotFoundException('Diagrama não encontrado');
    }

    // Validar que todos os equipamentos existem e pertencem à mesma unidade
    const equipamentoIds = dto.equipamentos.map(eq => eq.equipamentoId);
    if (equipamentoIds.length > 0) {
      const equipamentos = await this.prisma.equipamentos.findMany({
        where: {
          id: { in: equipamentoIds },
          unidade_id: diagrama.unidade_id,
          deleted_at: null,
        },
        select: { id: true },
      });

      if (equipamentos.length !== equipamentoIds.length) {
        throw new BadRequestException('Um ou mais equipamentos não existem ou não pertencem à unidade do diagrama');
      }
    }

    // Validar conexões - apenas verificar equipamentos quando tipo = 'equipamento'
    // Junction points não precisam de validação
    const conexoesComEquipamentos = dto.conexoes.filter(
      conn => conn.origem.tipo === 'equipamento' || conn.destino.tipo === 'equipamento'
    );

    if (conexoesComEquipamentos.length > 0) {
      const equipamentoIdsEmConexoes = new Set<string>();
      conexoesComEquipamentos.forEach(conn => {
        if (conn.origem.tipo === 'equipamento' && conn.origem.equipamentoId) {
          equipamentoIdsEmConexoes.add(conn.origem.equipamentoId);
        }
        if (conn.destino.tipo === 'equipamento' && conn.destino.equipamentoId) {
          equipamentoIdsEmConexoes.add(conn.destino.equipamentoId);
        }
      });

      // Verificar que equipamentos referenciados existem
      const equipamentosValidos = await this.prisma.equipamentos.findMany({
        where: {
          id: { in: Array.from(equipamentoIdsEmConexoes) },
          deleted_at: null,
        },
        select: { id: true },
      });

      if (equipamentosValidos.length !== equipamentoIdsEmConexoes.size) {
        throw new BadRequestException('Um ou mais equipamentos referenciados nas conexões não existem');
      }
    }

    // Executar em transação atômica
    const resultado = await this.prisma.$transaction(async (tx) => {
      // 1. DELETE ALL - Remover todas as conexões existentes (hard delete para performance)
      await tx.equipamentos_conexoes.deleteMany({
        where: { diagrama_id: diagramaId },
      });

      // 2. UPDATE - Limpar posições de todos os equipamentos do diagrama
      await tx.equipamentos.updateMany({
        where: { diagrama_id: diagramaId },
        data: {
          diagrama_id: null,
          posicao_x: null,
          posicao_y: null,
          rotacao: null,
          label_position: null,
        },
      });

      // 3. UPDATE - Atualizar posições dos equipamentos do novo layout
      let equipamentosAtualizados = 0;
      if (dto.equipamentos.length > 0) {
        // Fazer bulk update com Promise.all para performance
        await Promise.all(
          dto.equipamentos.map(eq =>
            tx.equipamentos.update({
              where: { id: eq.equipamentoId },
              data: {
                diagrama_id: diagramaId,
                posicao_x: eq.posicaoX,
                posicao_y: eq.posicaoY,
                rotacao: eq.rotacao || 0,
                label_position: eq.labelPosition || 'top',
                label_offset_x: eq.labelOffsetX,
                label_offset_y: eq.labelOffsetY,
              },
            })
          )
        );
        equipamentosAtualizados = dto.equipamentos.length;
      }

      // 4. INSERT ALL - Criar todas as novas conexões (bulk insert para performance)
      // Agora suporta junction points (origem/destino podem ser grid points)
      let conexoesCriadas = 0;
      if (dto.conexoes.length > 0) {
        const conexoesData = dto.conexoes.map(conn => ({
          diagrama_id: diagramaId,

          // Origem (equipamento OU junction point)
          equipamento_origem_id: conn.origem.tipo === 'equipamento' ? conn.origem.equipamentoId : null,
          porta_origem: conn.origem.porta,
          origem_tipo: conn.origem.tipo,
          origem_grid_x: conn.origem.tipo === 'junction' ? conn.origem.gridPoint?.x : null,
          origem_grid_y: conn.origem.tipo === 'junction' ? conn.origem.gridPoint?.y : null,

          // Destino (equipamento OU junction point)
          equipamento_destino_id: conn.destino.tipo === 'equipamento' ? conn.destino.equipamentoId : null,
          porta_destino: conn.destino.porta,
          destino_tipo: conn.destino.tipo,
          destino_grid_x: conn.destino.tipo === 'junction' ? conn.destino.gridPoint?.x : null,
          destino_grid_y: conn.destino.tipo === 'junction' ? conn.destino.gridPoint?.y : null,
        }));

        await tx.equipamentos_conexoes.createMany({
          data: conexoesData,
        });
        conexoesCriadas = dto.conexoes.length;
      }

      return {
        equipamentosAtualizados,
        conexoesCriadas,
      };
    });

    return resultado;
  }
}
