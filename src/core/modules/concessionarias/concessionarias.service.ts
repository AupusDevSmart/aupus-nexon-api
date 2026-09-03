import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateConcessionariaDto } from './dto/create-concessionaria.dto';
import { UpdateConcessionariaDto } from './dto/update-concessionaria.dto';
import { ConcessionariaQueryDto } from './dto/concessionaria-query.dto';

@Injectable()
export class ConcessionariasService {
  constructor(private prisma: PrismaService) {}

  async create(createDto: CreateConcessionariaDto) {
    // Validar datas
    const dataInicio = new Date(createDto.data_inicio);
    const dataValidade = new Date(createDto.data_validade);

    if (dataInicio >= dataValidade) {
      throw new BadRequestException('Data de início deve ser anterior à data de validade');
    }

    // Extrair tarifas dos objetos aninhados
    const data: any = {
      nome: createDto.nome,
      estado: createDto.estado.toUpperCase(),
      numero_reh: createDto.numero_reh || null,
      data_inicio: dataInicio,
      data_validade: dataValidade,
    };

    // Adicionar tarifas A4 Verde se fornecidas
    if (createDto.a4_verde) {
      data.a4_verde_tusd_d = createDto.a4_verde.tusd_d;
      data.a4_verde_tusd_p = createDto.a4_verde.tusd_p;
      data.a4_verde_tusd_fp = createDto.a4_verde.tusd_fp;
      data.a4_verde_te_d = createDto.a4_verde.te_d;
      data.a4_verde_te_p = createDto.a4_verde.te_p;
      data.a4_verde_te_fp = createDto.a4_verde.te_fp;
    }

    // Adicionar tarifas A3a Verde se fornecidas
    if (createDto.a3a_verde) {
      data.a3a_verde_tusd_d = createDto.a3a_verde.tusd_d;
      data.a3a_verde_tusd_p = createDto.a3a_verde.tusd_p;
      data.a3a_verde_tusd_fp = createDto.a3a_verde.tusd_fp;
      data.a3a_verde_te_d = createDto.a3a_verde.te_d;
      data.a3a_verde_te_p = createDto.a3a_verde.te_p;
      data.a3a_verde_te_fp = createDto.a3a_verde.te_fp;
    }

    // Adicionar tarifas Grupo B se fornecidas
    if (createDto.b) {
      data.b_tusd_valor = createDto.b.tusd_valor;
      data.b_te_valor = createDto.b.te_valor;
    }

    // Adicionar horarios dos postos tarifarios se fornecidos
    if (createDto.hora_inicio_ponta !== undefined) data.hora_inicio_ponta = createDto.hora_inicio_ponta;
    if (createDto.hora_fim_ponta !== undefined) data.hora_fim_ponta = createDto.hora_fim_ponta;
    if (createDto.hora_inicio_reservado !== undefined)
      data.hora_inicio_reservado = createDto.hora_inicio_reservado;
    if (createDto.hora_fim_reservado !== undefined) data.hora_fim_reservado = createDto.hora_fim_reservado;

    const concessionaria = await this.prisma.concessionarias_energia.create({
      data,
      include: {
        anexos: {
          where: { deleted_at: null },
          orderBy: { created_at: 'desc' },
        },
      },
    });

    return this.formatConcessionariaResponse(concessionaria);
  }

  async findAll(query: ConcessionariaQueryDto) {
    const {
      page = 1,
      limit = 10,
      search,
      estado,
      orderBy = 'created_at',
      orderDirection = 'desc',
    } = query;

    const skip = (page - 1) * limit;

    // Construir filtros
    const where: any = {
      deleted_at: null,
    };

    if (search) {
      where.nome = { contains: search, mode: 'insensitive' };
    }

    if (estado) {
      where.estado = estado.toUpperCase();
    }

    const [data, total] = await Promise.all([
      this.prisma.concessionarias_energia.findMany({
        where,
        skip,
        take: limit,
        // O id desempata; ver comentario em plantas.service.
        orderBy: [{ [orderBy]: orderDirection }, { id: 'asc' }],
        include: {
          anexos: {
            where: { deleted_at: null },
            select: {
              id: true,
              nome_original: true,
              tamanho: true,
              created_at: true,
            },
          },
        },
      }),
      this.prisma.concessionarias_energia.count({ where }),
    ]);

    return {
      data: data.map((c) => this.formatConcessionariaResponse(c)),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(id: string) {
    const concessionaria = await this.prisma.concessionarias_energia.findFirst({
      where: { id, deleted_at: null },
      include: {
        anexos: {
          where: { deleted_at: null },
          orderBy: { created_at: 'desc' },
        },
      },
    });

    if (!concessionaria) {
      throw new NotFoundException('Concessionária não encontrada');
    }

    return this.formatConcessionariaResponse(concessionaria);
  }

  async update(id: string, updateDto: UpdateConcessionariaDto) {
    const concessionariaExists = await this.prisma.concessionarias_energia.findFirst({
      where: { id, deleted_at: null },
    });

    if (!concessionariaExists) {
      throw new NotFoundException('Concessionária não encontrada');
    }

    // Validar datas se fornecidas
    if (updateDto.data_inicio && updateDto.data_validade) {
      const dataInicio = new Date(updateDto.data_inicio);
      const dataValidade = new Date(updateDto.data_validade);

      if (dataInicio >= dataValidade) {
        throw new BadRequestException('Data de início deve ser anterior à data de validade');
      }
    }

    const data: any = {};

    // Atualizar campos básicos
    if (updateDto.nome !== undefined) data.nome = updateDto.nome;
    if (updateDto.estado !== undefined) data.estado = updateDto.estado.toUpperCase();
    if (updateDto.numero_reh !== undefined) data.numero_reh = updateDto.numero_reh || null;
    if (updateDto.data_inicio !== undefined) data.data_inicio = new Date(updateDto.data_inicio);
    if (updateDto.data_validade !== undefined)
      data.data_validade = new Date(updateDto.data_validade);

    // Atualizar tarifas A4 Verde se fornecidas
    if (updateDto.a4_verde) {
      data.a4_verde_tusd_d = updateDto.a4_verde.tusd_d;
      data.a4_verde_tusd_p = updateDto.a4_verde.tusd_p;
      data.a4_verde_tusd_fp = updateDto.a4_verde.tusd_fp;
      data.a4_verde_te_d = updateDto.a4_verde.te_d;
      data.a4_verde_te_p = updateDto.a4_verde.te_p;
      data.a4_verde_te_fp = updateDto.a4_verde.te_fp;
    }

    // Atualizar tarifas A3a Verde se fornecidas
    if (updateDto.a3a_verde) {
      data.a3a_verde_tusd_d = updateDto.a3a_verde.tusd_d;
      data.a3a_verde_tusd_p = updateDto.a3a_verde.tusd_p;
      data.a3a_verde_tusd_fp = updateDto.a3a_verde.tusd_fp;
      data.a3a_verde_te_d = updateDto.a3a_verde.te_d;
      data.a3a_verde_te_p = updateDto.a3a_verde.te_p;
      data.a3a_verde_te_fp = updateDto.a3a_verde.te_fp;
    }

    // Atualizar tarifas Grupo B se fornecidas
    if (updateDto.b) {
      data.b_tusd_valor = updateDto.b.tusd_valor;
      data.b_te_valor = updateDto.b.te_valor;
    }

    // Atualizar horarios dos postos tarifarios se fornecidos
    if (updateDto.hora_inicio_ponta !== undefined) data.hora_inicio_ponta = updateDto.hora_inicio_ponta;
    if (updateDto.hora_fim_ponta !== undefined) data.hora_fim_ponta = updateDto.hora_fim_ponta;
    if (updateDto.hora_inicio_reservado !== undefined)
      data.hora_inicio_reservado = updateDto.hora_inicio_reservado;
    if (updateDto.hora_fim_reservado !== undefined) data.hora_fim_reservado = updateDto.hora_fim_reservado;

    const concessionaria = await this.prisma.concessionarias_energia.update({
      where: { id },
      data,
      include: {
        anexos: {
          where: { deleted_at: null },
          orderBy: { created_at: 'desc' },
        },
      },
    });

    return this.formatConcessionariaResponse(concessionaria);
  }

  async remove(id: string) {
    const concessionaria = await this.prisma.concessionarias_energia.findFirst({
      where: { id, deleted_at: null },
    });

    if (!concessionaria) {
      throw new NotFoundException('Concessionária não encontrada');
    }

    // Soft delete
    await this.prisma.concessionarias_energia.update({
      where: { id },
      data: { deleted_at: new Date() },
    });

    return { message: 'Concessionária removida com sucesso' };
  }

  // Método auxiliar para formatar a resposta
  private formatConcessionariaResponse(concessionaria: any) {
    return {
      id: concessionaria.id,
      nome: concessionaria.nome,
      estado: concessionaria.estado,
      numero_reh: concessionaria.numero_reh || null,
      data_inicio: concessionaria.data_inicio,
      data_validade: concessionaria.data_validade,
      a4_verde: {
        tusd_d: concessionaria.a4_verde_tusd_d,
        tusd_p: concessionaria.a4_verde_tusd_p,
        tusd_fp: concessionaria.a4_verde_tusd_fp,
        te_d: concessionaria.a4_verde_te_d,
        te_p: concessionaria.a4_verde_te_p,
        te_fp: concessionaria.a4_verde_te_fp,
      },
      a3a_verde: {
        tusd_d: concessionaria.a3a_verde_tusd_d,
        tusd_p: concessionaria.a3a_verde_tusd_p,
        tusd_fp: concessionaria.a3a_verde_tusd_fp,
        te_d: concessionaria.a3a_verde_te_d,
        te_p: concessionaria.a3a_verde_te_p,
        te_fp: concessionaria.a3a_verde_te_fp,
      },
      b: {
        tusd_valor: concessionaria.b_tusd_valor,
        te_valor: concessionaria.b_te_valor,
      },
      // Horarios dos postos tarifarios (definidos pela concessionaria).
      // Todos decimais — frontend converte HH:MM antes de exibir.
      hora_inicio_ponta: concessionaria.hora_inicio_ponta,
      hora_fim_ponta: concessionaria.hora_fim_ponta,
      hora_inicio_reservado: concessionaria.hora_inicio_reservado,
      hora_fim_reservado: concessionaria.hora_fim_reservado,
      anexos: concessionaria.anexos || [],
      created_at: concessionaria.created_at,
      updated_at: concessionaria.updated_at,
    };
  }

  // Métodos auxiliares para cálculos de tarifas (para uso futuro)
  async calcularTarifaA4Verde(concessionariaId: string, consumo: {
    demanda_d?: number;
    demanda_p?: number;
    consumo_d?: number;
    consumo_p?: number;
    consumo_fp?: number;
  }) {
    const concessionaria = await this.findOne(concessionariaId);
    const tarifas = concessionaria.a4_verde;

    let total = 0;

    if (consumo.demanda_d && tarifas.tusd_d) {
      total += Number(consumo.demanda_d) * Number(tarifas.tusd_d);
    }
    if (consumo.demanda_p && tarifas.tusd_p) {
      total += Number(consumo.demanda_p) * Number(tarifas.tusd_p);
    }
    if (consumo.consumo_d && tarifas.te_d) {
      total += Number(consumo.consumo_d) * Number(tarifas.te_d);
    }
    if (consumo.consumo_p && tarifas.te_p) {
      total += Number(consumo.consumo_p) * Number(tarifas.te_p);
    }
    if (consumo.consumo_fp && tarifas.te_fp) {
      total += Number(consumo.consumo_fp) * Number(tarifas.te_fp);
    }

    return {
      total,
      detalhamento: {
        demanda_d: consumo.demanda_d && tarifas.tusd_d ? Number(consumo.demanda_d) * Number(tarifas.tusd_d) : 0,
        demanda_p: consumo.demanda_p && tarifas.tusd_p ? Number(consumo.demanda_p) * Number(tarifas.tusd_p) : 0,
        consumo_d: consumo.consumo_d && tarifas.te_d ? Number(consumo.consumo_d) * Number(tarifas.te_d) : 0,
        consumo_p: consumo.consumo_p && tarifas.te_p ? Number(consumo.consumo_p) * Number(tarifas.te_p) : 0,
        consumo_fp: consumo.consumo_fp && tarifas.te_fp ? Number(consumo.consumo_fp) * Number(tarifas.te_fp) : 0,
      }
    };
  }

  async calcularTarifaA3aVerde(concessionariaId: string, consumo: {
    demanda_d?: number;
    demanda_p?: number;
    consumo_d?: number;
    consumo_p?: number;
    consumo_fp?: number;
  }) {
    const concessionaria = await this.findOne(concessionariaId);
    const tarifas = concessionaria.a3a_verde;

    let total = 0;

    if (consumo.demanda_d && tarifas.tusd_d) {
      total += Number(consumo.demanda_d) * Number(tarifas.tusd_d);
    }
    if (consumo.demanda_p && tarifas.tusd_p) {
      total += Number(consumo.demanda_p) * Number(tarifas.tusd_p);
    }
    if (consumo.consumo_d && tarifas.te_d) {
      total += Number(consumo.consumo_d) * Number(tarifas.te_d);
    }
    if (consumo.consumo_p && tarifas.te_p) {
      total += Number(consumo.consumo_p) * Number(tarifas.te_p);
    }
    if (consumo.consumo_fp && tarifas.te_fp) {
      total += Number(consumo.consumo_fp) * Number(tarifas.te_fp);
    }

    return {
      total,
      detalhamento: {
        demanda_d: consumo.demanda_d && tarifas.tusd_d ? Number(consumo.demanda_d) * Number(tarifas.tusd_d) : 0,
        demanda_p: consumo.demanda_p && tarifas.tusd_p ? Number(consumo.demanda_p) * Number(tarifas.tusd_p) : 0,
        consumo_d: consumo.consumo_d && tarifas.te_d ? Number(consumo.consumo_d) * Number(tarifas.te_d) : 0,
        consumo_p: consumo.consumo_p && tarifas.te_p ? Number(consumo.consumo_p) * Number(tarifas.te_p) : 0,
        consumo_fp: consumo.consumo_fp && tarifas.te_fp ? Number(consumo.consumo_fp) * Number(tarifas.te_fp) : 0,
      }
    };
  }

  async calcularTarifaB(concessionariaId: string, consumo: number) {
    const concessionaria = await this.findOne(concessionariaId);
    const tarifas = concessionaria.b;

    if (!tarifas.tusd_valor || !tarifas.te_valor) {
      throw new BadRequestException('Tarifas do Grupo B não configuradas para esta concessionária');
    }

    const tusd = Number(consumo) * Number(tarifas.tusd_valor);
    const te = Number(consumo) * Number(tarifas.te_valor);
    const total = tusd + te;

    return {
      total,
      detalhamento: {
        tusd,
        te,
        consumo,
      }
    };
  }
}
