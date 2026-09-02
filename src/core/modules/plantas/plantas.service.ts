// src/modules/plantas/plantas.service.ts - CORRIGIDO
import { Injectable, NotFoundException, BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Planta, ProprietarioBasico } from './entities/planta.entity';
import { Prisma } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { CreatePlantaDto } from './dto/create-planta.dto';
import { UpdatePlantaDto } from './dto/update-planta.dto';
import { FindAllPlantasDto } from './dto/find-all-plantas.dto';
import { PermissionScopeService, ScopedUser } from '../auth/permission-scope.service';

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

@Injectable()
export class PlantasService {
  constructor(
    private prisma: PrismaService,
    private scopeService: PermissionScopeService,
  ) {}

  async create(createPlantaDto: CreatePlantaDto): Promise<Planta> {
    const { endereco, proprietarioId, cnpj, numero_uc, ...plantaData } = createPlantaDto;

    try {
      // 1. Verificar se o proprietário existe
      const proprietario = await this.prisma.usuarios.findUnique({
        where: {
          id: proprietarioId,
          is_active: true,
          deleted_at: null
        },
        select: {
          id: true,
          nome: true,
          cpf_cnpj: true
        }
      });

      if (!proprietario) {
        throw new NotFoundException(`Proprietário com ID ${proprietarioId} não encontrado ou inativo`);
      }

      // 2. Verificar se CNPJ já existe
      const existingPlanta = await this.prisma.plantas.findUnique({
        where: { cnpj }
      });

      if (existingPlanta) {
        throw new ConflictException(`Já existe uma planta cadastrada com o CNPJ ${cnpj}`);
      }

      // 3. Criar a planta
      const novaPlanta = await this.prisma.plantas.create({
        data: {
          nome: plantaData.nome,
          cnpj,
          localizacao: plantaData.localizacao,
          horario_funcionamento: plantaData.horarioFuncionamento,
          numero_uc: numero_uc || null, // ✅ Adicionar numero_uc
          logradouro: endereco.logradouro,
          bairro: endereco.bairro,
          cidade: endereco.cidade,
          uf: endereco.uf,
          cep: endereco.cep,
          proprietario_id: proprietarioId,
        },
        include: {
          proprietario: {
            select: {
              id: true,
              nome: true,
              cpf_cnpj: true
            }
          }
        }
      });

      return this.formatPlantaResponse(novaPlanta);

    } catch (error) {
      console.error('❌ [PLANTAS SERVICE] Erro ao criar planta:', error);
      
      if (error instanceof NotFoundException || error instanceof ConflictException) {
        throw error;
      }

      if (error instanceof PrismaClientKnownRequestError) {
        if (error.code === 'P2002') {
          throw new ConflictException('CNPJ já cadastrado no sistema');
        }
        if (error.code === 'P2003') {
          throw new BadRequestException('Proprietário inválido ou não encontrado');
        }
      }

      throw new BadRequestException('Erro interno ao cadastrar planta');
    }
  }

  // ✅ CORRIGIDO: Usando tipos genéricos do Prisma
  async findAll(queryDto: FindAllPlantasDto, user?: ScopedUser): Promise<PaginatedResponse<Planta>> {
    const {
      page = 1,
      limit = 10,
      search,
      proprietarioId,
      orderBy = 'nome',
      orderDirection = 'asc'
    } = queryDto;

    try {
      // ✅ CORRIGIDO: Usando tipo genérico any para WHERE
      const whereClause: any = {
        deleted_at: null,
        AND: []
      };

      // Filtro de busca textual
      if (search && search.trim()) {
        const searchTerm = search.trim();
        whereClause.OR = [
          { nome: { contains: searchTerm, mode: 'insensitive' } },
          { cnpj: { contains: searchTerm, mode: 'insensitive' } },
          { localizacao: { contains: searchTerm, mode: 'insensitive' } },
          { cidade: { contains: searchTerm, mode: 'insensitive' } },
          { logradouro: { contains: searchTerm, mode: 'insensitive' } },
          // Quem procura uma planta frequentemente lembra do dono, nao do nome
          // dela. Com o combobox de proprietario fora da tela, esta e a unica
          // forma de chegar la pelo texto.
          { proprietario: { nome: { contains: searchTerm, mode: 'insensitive' } } }
        ];
      }

      // Filtro por proprietário
      if (proprietarioId && proprietarioId !== 'all') {
        whereClause.AND.push({
          proprietario_id: proprietarioId
        });
      }

      // Scope RBAC por planta (operador/proprietario veem apenas plantas vinculadas)
      const scope = await this.scopeService.getScope(user);
      if (this.scopeService.isScoped(scope)) {
        whereClause.AND.push({ id: { in: scope } });
      }

      // ✅ CORRIGIDO: Construir ordenação com tipo genérico
      const orderByClause: any = {};
      
      switch (orderBy) {
        case 'nome':
          orderByClause.nome = orderDirection;
          break;
        case 'cnpj':
          orderByClause.cnpj = orderDirection;
          break;
        case 'localizacao':
          orderByClause.localizacao = orderDirection;
          break;
        case 'cidade':
          orderByClause.cidade = orderDirection;
          break;
        case 'criadoEm':
          orderByClause.created_at = orderDirection;
          break;
        case 'proprietario':
          orderByClause.proprietario = { nome: orderDirection };
          break;
        default:
          orderByClause.nome = 'asc';
      }

      // Calcular paginação
      const skip = (page - 1) * limit;

      // Buscar dados e contagem total em paralelo com retry automático
      const [plantas, total] = await this.prisma.executeWithRetry(async () => {
        return await Promise.all([
          this.prisma.plantas.findMany({
            where: whereClause,
            include: {
              proprietario: {
                select: {
                  id: true,
                  nome: true,
                  cpf_cnpj: true
                }
              }
            },
            // O id desempata. Ordenar so por nome (ou cidade, ou created_at)
            // deixa linhas empatadas, e o Postgres nao promete ordem estavel
            // entre elas: com OFFSET/LIMIT as fatias se sobrepoem e a mesma
            // planta aparece em duas paginas enquanto outra some. Hoje nao ha
            // nomes repetidos em DEV, mas basta um para o bug voltar.
            orderBy: [orderByClause, { id: 'asc' }],
            skip,
            take: limit
          }),
          this.prisma.plantas.count({
            where: whereClause
          })
        ]);
      });

      // Formatar resposta
      const plantasFormatadas = plantas.map(planta => this.formatPlantaResponse(planta));

      const totalPages = Math.ceil(total / limit);

      return {
        data: plantasFormatadas,
        pagination: {
          page,
          limit,
          total,
          totalPages
        }
      };

    } catch (error) {
      console.error('❌ [PLANTAS SERVICE] Erro ao buscar plantas:', error);
      throw new BadRequestException('Erro interno ao buscar plantas');
    }
  }

  async findOne(id: string, user?: ScopedUser): Promise<Planta> {
    try {
      const planta = await this.prisma.plantas.findFirst({
        where: {
          id,
          deleted_at: null
        },
        include: {
          proprietario: {
            select: {
              id: true,
              nome: true,
              cpf_cnpj: true
            }
          }
        }
      });

      if (!planta) {
        throw new NotFoundException(`Planta com ID ${id} não encontrada`);
      }

      // Scope RBAC: 403 se a planta nao esta no escopo do usuario
      await this.scopeService.assertPlantaInScope(planta.id, user);

      return this.formatPlantaResponse(planta);

    } catch (error) {
      console.error('❌ [PLANTAS SERVICE] Erro ao buscar planta:', error);

      if (error instanceof NotFoundException || error instanceof ForbiddenException) {
        throw error;
      }

      throw new BadRequestException('Erro interno ao buscar planta');
    }
  }

  // ✅ CORRIGIDO: Usando tipos genéricos para UPDATE
  async update(id: string, updatePlantaDto: UpdatePlantaDto): Promise<Planta> {
    const { endereco, proprietarioId, cnpj, numero_uc, ...plantaData } = updatePlantaDto;

    try {
      // 1. Verificar se a planta existe
      const plantaExistente = await this.prisma.plantas.findFirst({
        where: {
          id,
          deleted_at: null
        }
      });

      if (!plantaExistente) {
        throw new NotFoundException(`Planta com ID ${id} não encontrada`);
      }

      // 2. Se há mudança de proprietário, verificar se ele existe
      if (proprietarioId && proprietarioId !== plantaExistente.proprietario_id) {
        const proprietario = await this.prisma.usuarios.findUnique({
          where: {
            id: proprietarioId,
            is_active: true,
            deleted_at: null
          }
        });

        if (!proprietario) {
          throw new NotFoundException(`Proprietário com ID ${proprietarioId} não encontrado ou inativo`);
        }
      }

      // 3. Se há mudança de CNPJ, verificar se não existe outro com mesmo CNPJ
      if (cnpj && cnpj !== plantaExistente.cnpj) {
        const outraPlantaComCnpj = await this.prisma.plantas.findFirst({
          where: {
            cnpj,
            id: { not: id },
            deleted_at: null
          }
        });

        if (outraPlantaComCnpj) {
          throw new ConflictException(`Já existe outra planta cadastrada com o CNPJ ${cnpj}`);
        }
      }

      // ✅ CORRIGIDO: Usando tipo genérico any para UPDATE
      const updateData: any = {};

      // Campos básicos
      if (plantaData.nome !== undefined) updateData.nome = plantaData.nome;
      if (cnpj !== undefined) updateData.cnpj = cnpj;
      if (plantaData.localizacao !== undefined) updateData.localizacao = plantaData.localizacao;
      if (plantaData.horarioFuncionamento !== undefined) {
        updateData.horario_funcionamento = plantaData.horarioFuncionamento;
      }
      if (numero_uc !== undefined) updateData.numero_uc = numero_uc || null; // ✅ Adicionar numero_uc
      if (proprietarioId !== undefined) updateData.proprietario_id = proprietarioId;

      // Campos de endereço
      if (endereco) {
        if (endereco.logradouro !== undefined) updateData.logradouro = endereco.logradouro;
        if (endereco.bairro !== undefined) updateData.bairro = endereco.bairro;
        if (endereco.cidade !== undefined) updateData.cidade = endereco.cidade;
        if (endereco.uf !== undefined) updateData.uf = endereco.uf;
        if (endereco.cep !== undefined) updateData.cep = endereco.cep;
      }

      // 5. Atualizar a planta
      const plantaAtualizada = await this.prisma.plantas.update({
        where: { id },
        data: updateData,
        include: {
          proprietario: {
            select: {
              id: true,
              nome: true,
              cpf_cnpj: true
            }
          }
        }
      });

      return this.formatPlantaResponse(plantaAtualizada);

    } catch (error) {
      console.error('❌ [PLANTAS SERVICE] Erro ao atualizar planta:', error);
      
      if (error instanceof NotFoundException || error instanceof ConflictException) {
        throw error;
      }

      if (error instanceof PrismaClientKnownRequestError) {
        if (error.code === 'P2002') {
          throw new ConflictException('CNPJ já cadastrado no sistema');
        }
        if (error.code === 'P2003') {
          throw new BadRequestException('Proprietário inválido ou não encontrado');
        }
      }

      throw new BadRequestException('Erro interno ao atualizar planta');
    }
  }

  async findProprietarios(comUnidades?: boolean) {
    const where: any = {
      is_active: true,
      deleted_at: null,
      OR: [
        { role: 'proprietario' },
        { role: 'admin' },
        { role: 'gerente' }
      ]
    };

    // Filtrar apenas proprietários que possuem plantas com unidades
    if (comUnidades) {
      where.plantas_proprietario = {
        some: {
          deleted_at: null,
          unidades: {
            some: {
              deleted_at: null,
            }
          }
        }
      };
    }

    const proprietarios = await this.prisma.usuarios.findMany({
      where,
      select: {
        id: true,
        nome: true,
        cpf_cnpj: true
      },
      orderBy: {
        nome: 'asc'
      }
    });

    return proprietarios.map(prop => ({
      id: prop.id,
      nome: prop.nome,
      cpf_cnpj: prop.cpf_cnpj,
      tipo: this.getTipoProprietario(prop.cpf_cnpj)
    }));
  }

  private formatPlantaResponse(plantaDb: any): Planta {
    return {
      id: plantaDb.id?.trim() || plantaDb.id, // ✅ TRIM para remover espaços extras
      nome: plantaDb.nome,
      cnpj: plantaDb.cnpj,
      localizacao: plantaDb.localizacao,
      horarioFuncionamento: plantaDb.horario_funcionamento,
      numeroUc: plantaDb.numero_uc || undefined, // ✅ Número da Unidade Consumidora
      endereco: {
        logradouro: plantaDb.logradouro,
        bairro: plantaDb.bairro || '', // ✅ Garantir string vazia se null
        cidade: plantaDb.cidade,
        uf: plantaDb.uf,
        cep: plantaDb.cep,
      },
      proprietarioId: plantaDb.proprietario_id?.trim() || plantaDb.proprietario_id, // ✅ TRIM
      proprietario: plantaDb.proprietario ? {
        id: plantaDb.proprietario.id?.trim() || plantaDb.proprietario.id, // ✅ TRIM
        nome: plantaDb.proprietario.nome,
        cpf_cnpj: plantaDb.proprietario.cpf_cnpj,
        tipo: this.getTipoProprietario(plantaDb.proprietario.cpf_cnpj),
      } : undefined,
      criadoEm: plantaDb.created_at,
      atualizadoEm: plantaDb.updated_at,
    };
  }

  async findUnidadesByPlanta(
    plantaId: string,
    tipo?: string,
    status?: string,
    proprietarioId?: string | null,
    user?: ScopedUser,
  ) {
    try {
      const whereClausePlanta: any = {
        id: plantaId,
        deleted_at: null
      };

      if (proprietarioId) {
        whereClausePlanta.proprietario_id = proprietarioId;
      }

      const planta = await this.prisma.plantas.findFirst({
        where: whereClausePlanta
      });

      if (!planta) {
        const message = proprietarioId
          ? `Planta com ID ${plantaId} não encontrada ou não pertence a você`
          : `Planta com ID ${plantaId} não encontrada`;
        throw new NotFoundException(message);
      }

      // Scope RBAC: 403 se a planta nao esta no escopo do usuario
      await this.scopeService.assertPlantaInScope(planta.id, user);

      const whereClause: any = {
        planta_id: plantaId,
        deleted_at: null
      };

      if (tipo) whereClause.tipo = tipo;
      if (status) whereClause.status = status;

      const unidades = await this.prisma.unidades.findMany({
        where: whereClause,
        include: {
          _count: {
            select: {
              equipamentos: {
                where: { deleted_at: null }
              }
            }
          }
        },
        orderBy: { nome: 'asc' }
      });

      const resultado = unidades.map((unidade) => ({
        id: unidade.id?.trim() || unidade.id,
        nome: unidade.nome,
        tipo: unidade.tipo,
        estado: unidade.estado,
        cidade: unidade.cidade,
        latitude: unidade.latitude.toString(),
        longitude: unidade.longitude.toString(),
        potencia: unidade.potencia.toString(),
        status: unidade.status,
        totalEquipamentos: unidade._count.equipamentos,
        createdAt: unidade.created_at,
        updatedAt: unidade.updated_at
      }));

      return {
        data: resultado,
        meta: {
          total: resultado.length,
          timestamp: new Date().toISOString()
        }
      };

    } catch (error) {
      console.error('❌ [PLANTAS SERVICE] Erro ao buscar unidades:', error);

      if (error instanceof NotFoundException || error instanceof ForbiddenException) {
        throw error;
      }

      throw new BadRequestException('Erro interno ao buscar unidades da planta');
    }
  }

  async remove(id: string): Promise<{ message: string; deletedUnits?: number; deletedEquipments?: number }> {
    try {
      const plantaId = id.trim(); // TRIM do ID para garantir que não há espaços

      // 1. Verificar se a planta existe
      const planta = await this.prisma.plantas.findFirst({
        where: {
          id: plantaId,
          deleted_at: null
        }
      });

      if (!planta) {
        throw new NotFoundException(`Planta com ID ${id} não encontrada`);
      }

      // 2. Contar unidades e equipamentos que serão deletados
      const unidades = await this.prisma.unidades.findMany({
        where: {
          planta_id: plantaId,
          deleted_at: null
        },
        include: {
          _count: {
            select: {
              equipamentos: {
                where: { deleted_at: null }
              }
            }
          }
        }
      });

      const unidadesCount = unidades.length;
      const equipamentosCount = unidades.reduce((total, unidade) => total + unidade._count.equipamentos, 0);

      // 3. Realizar soft delete em cascata usando transação
      const result = await this.prisma.$transaction(async (prisma) => {
        // Deletar todos os equipamentos das unidades da planta
        if (equipamentosCount > 0) {
          for (const unidade of unidades) {
            await prisma.equipamentos.updateMany({
              where: {
                unidade_id: unidade.id,
                deleted_at: null
              },
              data: {
                deleted_at: new Date()
              }
            });
          }
          console.log(`✅ [PLANTAS SERVICE] ${equipamentosCount} equipamento(s) deletado(s) em cascata`);
        }

        // Deletar todas as unidades da planta
        if (unidadesCount > 0) {
          await prisma.unidades.updateMany({
            where: {
              planta_id: plantaId,
              deleted_at: null
            },
            data: {
              deleted_at: new Date()
            }
          });
          console.log(`✅ [PLANTAS SERVICE] ${unidadesCount} unidade(s) deletada(s) em cascata`);
        }

        // Deletar a planta
        await prisma.plantas.update({
          where: { id: plantaId },
          data: {
            deleted_at: new Date()
          }
        });

        return { unidadesCount, equipamentosCount };
      });

      console.log(`✅ [PLANTAS SERVICE] Planta ${id} deletada com sucesso (soft delete)`);

      let message = 'Planta removida com sucesso';
      if (result.unidadesCount > 0) {
        message += ` junto com ${result.unidadesCount} unidade(s)`;
        if (result.equipamentosCount > 0) {
          message += ` e ${result.equipamentosCount} equipamento(s)`;
        }
      }

      return {
        message,
        deletedUnits: result.unidadesCount,
        deletedEquipments: result.equipamentosCount
      };

    } catch (error) {
      console.error('❌ [PLANTAS SERVICE] Erro ao deletar planta:', error);

      if (error instanceof NotFoundException) {
        throw error;
      }

      throw new BadRequestException('Erro interno ao deletar planta');
    }
  }

  private getTipoProprietario(cpfCnpj: string | null): 'pessoa_fisica' | 'pessoa_juridica' {
    if (!cpfCnpj) return 'pessoa_juridica';

    const digits = cpfCnpj.replace(/\D/g, '');
    return digits.length === 11 ? 'pessoa_fisica' : 'pessoa_juridica';
  }
}