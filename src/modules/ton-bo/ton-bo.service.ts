import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '@aupus/api-shared';
import { Prisma } from '@aupus/api-shared';

import {
  CreateTonBoDto,
  UpdateTonBoDto,
  TonBoResponseDto,
  PULSO_MS_DEFAULT,
} from './dto/ton-bo.dto';

/**
 * CRUD do mapeamento BO -> ponto.
 *
 * Invariantes:
 *  - TON precisa existir (deleted_at IS NULL).
 *  - bo_numero eh UNIQUE por ton_id (banco garante). Conflict -> 409.
 *  - equipamento_ponto_id, se fornecido, precisa existir + ser tipo='comando'
 *    + estar ativo. Tipos status/medicao nao se mapeiam a BOs.
 *  - Soft delete via deleted_at — preserva historico de mapeamentos.
 *
 * Pre-populacao automatica:
 *  - GET /equipamentos/:tonId/bos sempre retorna 6 entradas (BO01..BO06):
 *    os existentes em BD + placeholders para os faltantes. Frontend renderiza
 *    o grid completo sem precisar criar BOs vazios antecipadamente.
 */
@Injectable()
export class TonBoService {
  private readonly logger = new Logger(TonBoService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retorna sempre 6 entradas (BO01..BO06) pra alimentar grid do frontend.
   * BOs nao persistidos vem com id=null e valores default — frontend faz
   * POST quando user salvar a primeira config.
   */
  async list(tonId: string): Promise<TonBoResponseDto[]> {
    const tId = tonId.trim();
    await this.assertTonExists(tId);

    const rows = await this.prisma.ton_bo.findMany({
      where: { ton_id: tId, deleted_at: null },
      orderBy: { bo_numero: 'asc' },
      include: {
        equipamento_ponto: {
          include: {
            equipamento: { select: { id: true, nome: true } },
          },
        },
      },
    });

    const byNumero = new Map(rows.map((r) => [r.bo_numero, r]));
    const out: TonBoResponseDto[] = [];
    for (let n = 1; n <= 6; n++) {
      const row = byNumero.get(n);
      if (row) {
        out.push(this.toResponse(row));
      } else {
        out.push(this.placeholder(tId, n));
      }
    }
    return out;
  }

  async create(
    tonId: string,
    dto: CreateTonBoDto,
  ): Promise<TonBoResponseDto> {
    const tId = tonId.trim();
    await this.assertTonExists(tId);

    if (dto.equipamento_ponto_id) {
      await this.assertPontoComando(dto.equipamento_ponto_id.trim());
    }

    try {
      const row = await this.prisma.ton_bo.create({
        data: {
          ton_id: tId,
          bo_numero: dto.bo_numero,
          equipamento_ponto_id: dto.equipamento_ponto_id?.trim() ?? null,
          pulso_ms: dto.pulso_ms ?? PULSO_MS_DEFAULT,
          ativo: dto.ativo ?? true,
        },
        include: {
          equipamento_ponto: {
            include: { equipamento: { select: { id: true, nome: true } } },
          },
        },
      });
      return this.toResponse(row);
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException(
          `BO ${dto.bo_numero} ja existe para essa TON. Use PATCH /bos/:boId.`,
        );
      }
      throw err;
    }
  }

  async update(
    tonId: string,
    boId: string,
    dto: UpdateTonBoDto,
  ): Promise<TonBoResponseDto> {
    const tId = tonId.trim();
    const bId = boId.trim();
    await this.assertBoExists(tId, bId);

    if (dto.equipamento_ponto_id !== undefined && dto.equipamento_ponto_id !== null) {
      await this.assertPontoComando(dto.equipamento_ponto_id.trim());
    }

    const data: Prisma.ton_boUpdateInput = {};
    if (dto.bo_numero !== undefined) data.bo_numero = dto.bo_numero;
    if (dto.pulso_ms !== undefined) data.pulso_ms = dto.pulso_ms;
    if (dto.ativo !== undefined) data.ativo = dto.ativo;
    if (dto.equipamento_ponto_id !== undefined) {
      data.equipamento_ponto = dto.equipamento_ponto_id
        ? { connect: { id: dto.equipamento_ponto_id.trim() } }
        : { disconnect: true };
    }

    try {
      const row = await this.prisma.ton_bo.update({
        where: { id: bId },
        data,
        include: {
          equipamento_ponto: {
            include: { equipamento: { select: { id: true, nome: true } } },
          },
        },
      });
      return this.toResponse(row);
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException(
          `BO ${dto.bo_numero} ja existe para essa TON`,
        );
      }
      throw err;
    }
  }

  async remove(tonId: string, boId: string): Promise<void> {
    const tId = tonId.trim();
    const bId = boId.trim();
    await this.assertBoExists(tId, bId);

    await this.prisma.ton_bo.update({
      where: { id: bId },
      data: { deleted_at: new Date() },
    });
  }

  // ============================================================================
  // Validacoes
  // ============================================================================

  private async assertTonExists(tonId: string) {
    const ton = await this.prisma.equipamentos.findFirst({
      where: { id: tonId, deleted_at: null },
      select: { id: true },
    });
    if (!ton) {
      throw new NotFoundException(`TON ${tonId} nao encontrada`);
    }
    return ton;
  }

  private async assertBoExists(tonId: string, boId: string) {
    const bo = await this.prisma.ton_bo.findFirst({
      where: { id: boId, ton_id: tonId, deleted_at: null },
      select: { id: true },
    });
    if (!bo) {
      throw new NotFoundException(`BO ${boId} nao encontrado na TON ${tonId}`);
    }
  }

  private async assertPontoComando(pontoId: string) {
    const ponto = await this.prisma.equipamento_pontos.findFirst({
      where: { id: pontoId, deleted_at: null },
      select: { id: true, tipo: true, ativo: true },
    });
    if (!ponto) {
      throw new BadRequestException(
        `Ponto ${pontoId} nao encontrado ou foi deletado`,
      );
    }
    if (ponto.tipo !== 'comando') {
      throw new BadRequestException(
        `Ponto ${pontoId} eh do tipo "${ponto.tipo}" — BOs so aceitam tipo "comando".`,
      );
    }
    if (!ponto.ativo) {
      throw new BadRequestException(
        `Ponto ${pontoId} esta inativo. Ative antes de mapear em BO.`,
      );
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
    );
  }

  // ============================================================================
  // Shape helpers
  // ============================================================================

  private toResponse = (
    row: {
      id: string;
      ton_id: string;
      bo_numero: number;
      equipamento_ponto_id: string | null;
      pulso_ms: number;
      ativo: boolean;
      created_at: Date;
      updated_at: Date;
    } & {
      equipamento_ponto:
        | ({
            id: string;
            tipo: string;
            nome: string;
            equipamento_id: string;
            equipamento: { id: string; nome: string };
          } | null)
        | undefined;
    },
  ): TonBoResponseDto => ({
    id: row.id,
    ton_id: row.ton_id,
    bo_numero: row.bo_numero,
    equipamento_ponto_id: row.equipamento_ponto_id,
    pulso_ms: row.pulso_ms,
    ativo: row.ativo,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ponto: row.equipamento_ponto
      ? {
          id: row.equipamento_ponto.id,
          tipo: row.equipamento_ponto.tipo,
          nome: row.equipamento_ponto.nome,
          equipamento_id: row.equipamento_ponto.equipamento_id,
          equipamento_nome: row.equipamento_ponto.equipamento.nome,
        }
      : null,
  });

  /** Placeholder pra BO ainda nao salvo — id null sinaliza ao frontend pra POST em vez de PATCH. */
  private placeholder(tonId: string, boNumero: number): TonBoResponseDto {
    return {
      id: '' as unknown as string, // sentinel — frontend trata "" como "criar"
      ton_id: tonId,
      bo_numero: boNumero,
      equipamento_ponto_id: null,
      pulso_ms: PULSO_MS_DEFAULT,
      ativo: true,
      created_at: new Date(0),
      updated_at: new Date(0),
      ponto: null,
    };
  }
}
