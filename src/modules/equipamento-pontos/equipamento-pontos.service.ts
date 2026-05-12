import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '@aupus/api-shared';
import { Prisma } from '@aupus/api-shared';

import {
  CreateEquipamentoPontoDto,
  UpdateEquipamentoPontoDto,
  EquipamentoPontoResponseDto,
  PONTO_TIPOS,
} from './dto/equipamento-ponto.dto';

/**
 * CRUD de pontos logicos por equipamento.
 *
 * Regras:
 *  - Equipamento precisa existir (deleted_at IS NULL).
 *  - Equipamento precisa estar com automacao=true para receber pontos. Se nao,
 *    409 com mensagem orientativa — frontend marca o check antes de adicionar.
 *  - nome eh UNIQUE por equipamento (banco garante via @@unique). Conflict
 *    eh mapeado pra 409.
 *  - Soft delete via deleted_at.
 *  - Listagem filtra deleted_at IS NULL por padrao; equipamento alvo pode estar
 *    soft-deletado, mas a maioria dos consumidores nao se importa.
 */
@Injectable()
export class EquipamentoPontosService {
  private readonly logger = new Logger(EquipamentoPontosService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(equipamentoId: string): Promise<EquipamentoPontoResponseDto[]> {
    const eqId = equipamentoId.trim();
    await this.assertEquipamentoExists(eqId);

    const rows = await this.prisma.equipamento_pontos.findMany({
      where: { equipamento_id: eqId, deleted_at: null },
      orderBy: [{ ordem: 'asc' }, { tipo: 'asc' }, { nome: 'asc' }],
    });
    return rows.map(this.toResponse);
  }

  async create(
    equipamentoId: string,
    dto: CreateEquipamentoPontoDto,
  ): Promise<EquipamentoPontoResponseDto> {
    const eqId = equipamentoId.trim();
    await this.assertEquipamentoAutomatizado(eqId);

    if (!PONTO_TIPOS.includes(dto.tipo)) {
      throw new BadRequestException(
        `tipo invalido (${dto.tipo}); aceito: ${PONTO_TIPOS.join(', ')}`,
      );
    }

    try {
      const row = await this.prisma.equipamento_pontos.create({
        data: {
          equipamento_id: eqId,
          tipo: dto.tipo,
          nome: dto.nome.trim(),
          unidade: dto.unidade?.trim() ?? null,
          ordem: dto.ordem ?? 0,
          ativo: dto.ativo ?? true,
        },
      });
      return this.toResponse(row);
    } catch (err: unknown) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException(
          `Ja existe ponto com nome "${dto.nome}" para esse equipamento`,
        );
      }
      throw err;
    }
  }

  async update(
    equipamentoId: string,
    pontoId: string,
    dto: UpdateEquipamentoPontoDto,
  ): Promise<EquipamentoPontoResponseDto> {
    const eqId = equipamentoId.trim();
    const pId = pontoId.trim();
    await this.assertPontoExists(eqId, pId);

    if (dto.tipo !== undefined && !PONTO_TIPOS.includes(dto.tipo)) {
      throw new BadRequestException(
        `tipo invalido (${dto.tipo}); aceito: ${PONTO_TIPOS.join(', ')}`,
      );
    }

    const data: Prisma.equipamento_pontosUpdateInput = {};
    if (dto.tipo !== undefined) data.tipo = dto.tipo;
    if (dto.nome !== undefined) data.nome = dto.nome.trim();
    if (dto.unidade !== undefined)
      data.unidade = dto.unidade?.trim() ?? null;
    if (dto.ordem !== undefined) data.ordem = dto.ordem;
    if (dto.ativo !== undefined) data.ativo = dto.ativo;

    try {
      const row = await this.prisma.equipamento_pontos.update({
        where: { id: pId },
        data,
      });
      return this.toResponse(row);
    } catch (err: unknown) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException(
          `Ja existe ponto com nome "${dto.nome}" para esse equipamento`,
        );
      }
      throw err;
    }
  }

  async remove(equipamentoId: string, pontoId: string): Promise<void> {
    const eqId = equipamentoId.trim();
    const pId = pontoId.trim();
    await this.assertPontoExists(eqId, pId);

    await this.prisma.equipamento_pontos.update({
      where: { id: pId },
      data: { deleted_at: new Date() },
    });
  }

  private async assertEquipamentoExists(equipamentoId: string) {
    const eq = await this.prisma.equipamentos.findFirst({
      where: { id: equipamentoId, deleted_at: null },
      select: { id: true, automacao: true },
    });
    if (!eq) {
      throw new NotFoundException(
        `Equipamento ${equipamentoId} nao encontrado`,
      );
    }
    return eq;
  }

  private async assertEquipamentoAutomatizado(equipamentoId: string) {
    const eq = await this.assertEquipamentoExists(equipamentoId);
    if (!eq.automacao) {
      throw new ConflictException(
        'Equipamento esta com automacao=false. Marque o check de automacao no cadastro antes de adicionar pontos.',
      );
    }
  }

  private async assertPontoExists(equipamentoId: string, pontoId: string) {
    const ponto = await this.prisma.equipamento_pontos.findFirst({
      where: { id: pontoId, equipamento_id: equipamentoId, deleted_at: null },
      select: { id: true },
    });
    if (!ponto) {
      throw new NotFoundException(
        `Ponto ${pontoId} nao encontrado no equipamento ${equipamentoId}`,
      );
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
    );
  }

  private toResponse = (row: {
    id: string;
    equipamento_id: string;
    tipo: string;
    nome: string;
    unidade: string | null;
    ordem: number;
    ativo: boolean;
    created_at: Date;
    updated_at: Date;
  }): EquipamentoPontoResponseDto => ({
    id: row.id,
    equipamento_id: row.equipamento_id,
    tipo: row.tipo as EquipamentoPontoResponseDto['tipo'],
    nome: row.nome,
    unidade: row.unidade,
    ordem: row.ordem,
    ativo: row.ativo,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}
