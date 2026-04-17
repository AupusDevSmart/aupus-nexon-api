import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@aupus/api-shared';
import { CreateRegraLogDto } from './dto/create-regra-log.dto';
import { UpdateRegraLogDto } from './dto/update-regra-log.dto';
import { QueryRegrasLogsDto } from './dto/query-regras-logs.dto';
import { extrairCamposNumericos } from './regras-logs-mqtt.helpers';
import { RegrasLogsMqttEngine } from './regras-logs-mqtt.engine';

@Injectable()
export class RegrasLogsMqttService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: RegrasLogsMqttEngine,
  ) {}

  async create(dto: CreateRegraLogDto) {
    const equipamentoId = dto.equipamento_id.trim();
    const result = await this.prisma.regras_logs_mqtt.create({
      data: {
        equipamento_id: equipamentoId,
        nome: dto.nome.trim(),
        campo_json: dto.campo_json.trim(),
        operador: dto.operador,
        valor: dto.valor,
        mensagem: dto.mensagem.trim(),
        severidade: dto.severidade || 'MEDIA',
        cooldown_minutos: dto.cooldown_minutos || 5,
      },
      include: { equipamento: { select: { id: true, nome: true } } },
    });
    await this.engine.recarregarCache();
    return result;
  }

  async findAll(query: QueryRegrasLogsDto) {
    const { page, limit, search, equipamentoId, severidade, ativo, orderBy, orderDirection } = query;
    const skip = (page - 1) * limit;

    const where: any = { deleted_at: null };

    if (equipamentoId && equipamentoId !== 'all') {
      where.equipamento_id = equipamentoId.trim();
    }
    if (severidade) {
      where.severidade = severidade;
    }
    if (ativo && ativo !== 'all') {
      where.ativo = ativo === 'true';
    }
    if (search) {
      where.OR = [
        { nome: { contains: search, mode: 'insensitive' } },
        { mensagem: { contains: search, mode: 'insensitive' } },
        { campo_json: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.regras_logs_mqtt.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [orderBy || 'created_at']: orderDirection || 'desc' },
        include: { equipamento: { select: { id: true, nome: true } } },
      }),
      this.prisma.regras_logs_mqtt.count({ where }),
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
    const regra = await this.prisma.regras_logs_mqtt.findFirst({
      where: { id: id.trim(), deleted_at: null },
      include: { equipamento: { select: { id: true, nome: true } } },
    });
    if (!regra) throw new NotFoundException('Regra não encontrada');
    return regra;
  }

  async update(id: string, dto: UpdateRegraLogDto) {
    await this.findOne(id);
    const data: any = { ...dto };
    if (data.equipamento_id) data.equipamento_id = data.equipamento_id.trim();
    if (data.nome) data.nome = data.nome.trim();
    if (data.campo_json) data.campo_json = data.campo_json.trim();
    if (data.mensagem) data.mensagem = data.mensagem.trim();

    const result = await this.prisma.regras_logs_mqtt.update({
      where: { id: id.trim() },
      data,
      include: { equipamento: { select: { id: true, nome: true } } },
    });
    await this.engine.recarregarCache();
    return result;
  }

  async remove(id: string) {
    await this.findOne(id);
    const result = await this.prisma.regras_logs_mqtt.update({
      where: { id: id.trim() },
      data: { deleted_at: new Date() },
    });
    await this.engine.recarregarCache();
    return result;
  }

  async getCamposEquipamento(equipamentoId: string) {
    const ultimoDado = await this.prisma.equipamentos_dados.findFirst({
      where: { equipamento_id: equipamentoId.trim() },
      orderBy: { created_at: 'desc' },
      select: { dados: true },
    });

    if (!ultimoDado?.dados) {
      return [];
    }

    return extrairCamposNumericos(ultimoDado.dados);
  }

  /**
   * Retorna todas as regras ativas agrupadas por equipamento_id.
   * Usado pelo engine para carregar o cache.
   */
  async findAllAtivas() {
    return this.prisma.regras_logs_mqtt.findMany({
      where: { ativo: true, deleted_at: null },
    });
  }
}
