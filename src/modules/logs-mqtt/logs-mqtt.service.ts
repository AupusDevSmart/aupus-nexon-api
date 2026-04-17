import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@aupus/api-shared';
import { QueryLogsMqttDto } from './dto/query-logs-mqtt.dto';

@Injectable()
export class LogsMqttService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: QueryLogsMqttDto) {
    const {
      page,
      limit,
      search,
      equipamentoId,
      regraId,
      severidade,
      dataInicial,
      dataFinal,
      orderBy,
      orderDirection,
    } = query;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (equipamentoId && equipamentoId !== 'all') {
      where.equipamento_id = equipamentoId.trim();
    }
    if (regraId) {
      where.regra_id = regraId.trim();
    }
    if (severidade) {
      where.severidade = severidade;
    }
    if (search) {
      where.mensagem = { contains: search, mode: 'insensitive' };
    }
    if (dataInicial || dataFinal) {
      where.created_at = {};
      if (dataInicial) where.created_at.gte = new Date(dataInicial);
      if (dataFinal) where.created_at.lte = new Date(dataFinal);
    }

    const [data, total] = await Promise.all([
      this.prisma.logs_mqtt.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [orderBy || 'created_at']: orderDirection || 'desc' },
        include: {
          regra: {
            select: {
              id: true,
              nome: true,
              campo_json: true,
              operador: true,
              valor: true,
            },
          },
          equipamento: {
            select: { id: true, nome: true },
          },
        },
      }),
      this.prisma.logs_mqtt.count({ where }),
    ]);

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(id: string) {
    const log = await this.prisma.logs_mqtt.findUnique({
      where: { id: id.trim() },
      include: {
        regra: {
          select: {
            id: true,
            nome: true,
            campo_json: true,
            operador: true,
            valor: true,
            severidade: true,
            cooldown_minutos: true,
          },
        },
        equipamento: {
          select: { id: true, nome: true },
        },
      },
    });
    if (!log) throw new NotFoundException('Log não encontrado');
    return log;
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.logs_mqtt.delete({ where: { id: id.trim() } });
  }
}
