import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService, PermissionScopeService, ScopedUser } from '@aupus/api-shared';
import { QueryLogsMqttDto } from './dto/query-logs-mqtt.dto';

@Injectable()
export class LogsMqttService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopeService: PermissionScopeService,
  ) {}

  async findAll(query: QueryLogsMqttDto, user?: ScopedUser) {
    const {
      page,
      limit,
      search,
      equipamentoId,
      unidadeId,
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
    if (unidadeId && unidadeId !== 'all') {
      // Filtra pelos logs de equipamentos pertencentes a unidade
      where.equipamento = { unidade_id: unidadeId.trim() };
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

    // Scope RBAC: filtrar logs pela planta_id do equipamento (via unidade)
    const scope = await this.scopeService.getScope(user);
    if (this.scopeService.isScoped(scope)) {
      where.AND = scope.length === 0
        ? [{ id: '__NEVER__' }]
        : [{ equipamento: { unidade: { planta_id: { in: scope } } } }];
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

  async findOne(id: string, user?: ScopedUser) {
    if (user) await this.scopeService.assertEntityInScope('log_mqtt', id.trim(), user);
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

  async remove(id: string, user?: ScopedUser) {
    await this.findOne(id, user);
    return this.prisma.logs_mqtt.delete({ where: { id: id.trim() } });
  }

  /**
   * Reconhecer (ack) um alarme: marca reconhecido_em/por. Usado pro modelo
   * "alarme fica ativo até o operador marcar como visto" (ex.: trip do relé).
   * findOne valida existência + escopo (tenant isolation). Colunas de ack não
   * estão no model Prisma → gravadas por raw (idempotente: só marca se NULL).
   */
  async reconhecer(id: string, user?: ScopedUser) {
    await this.findOne(id, user);
    const u: any = user || {};
    const quem = String(u.nome || u.email || u.id || 'operador').slice(0, 64);
    await this.prisma.$executeRaw`
      UPDATE logs_mqtt SET reconhecido_em = now(), reconhecido_por = ${quem}
      WHERE TRIM(id) = ${id.trim()} AND reconhecido_em IS NULL
    `;
    return { ok: true, reconhecido_por: quem };
  }
}
