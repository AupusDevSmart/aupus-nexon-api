import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService, PermissionScopeService, ScopedUser } from '@aupus/api-shared';
import { tonAiCount } from '../../shared/util/ton-caps';
import { Prisma } from '@aupus/api-shared';
import { customAlphabet } from 'nanoid';

import { CreateTonAiDto, UpdateTonAiDto, TonAiResponseDto } from './dto/ton-ai.dto';

/**
 * CRUD do mapeamento AI (Analog Input) -> ponto (tipo medicao) + escala mV->%.
 *
 * Espelha ton_bi/ton_bo. Acesso via raw SQL (ton_ai nao esta no client Prisma
 * tipado — schema vive no pacote git api-shared; ver
 * db/manual-migrations/2026-08-20_ai_inputs.sql). `prisma migrate deploy` nao
 * dropa tabelas fora do schema, entao a tabela e segura.
 *
 * Invariantes:
 *  - TON precisa existir (deleted_at IS NULL).
 *  - ai_numero eh UNIQUE por ton_id. Conflito -> 409.
 *  - equipamento_ponto_id, se fornecido, precisa existir + ser tipo='medicao' + ativo.
 *  - Soft delete via deleted_at.
 *
 * Pre-populacao: GET /equipamentos/:tonId/ais retorna sempre N entradas
 * (AI01..AI0N): existentes + placeholders (id="") pros faltantes.
 */
@Injectable()
export class TonAiService {
  private readonly logger = new Logger(TonAiService.name);

  private static readonly _head = customAlphabet('abcdefghijklmnopqrstuvwxyz', 1);
  private static readonly _rest = customAlphabet(
    'abcdefghijklmnopqrstuvwxyz0123456789',
    24,
  );
  private genId(): string {
    return TonAiService._head() + TonAiService._rest();
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly scopeService: PermissionScopeService,
  ) {}

  // ============================================================================
  // Leitura
  // ============================================================================

  /** AIs conforme o modelo (2 canais AN1/AN2) pra alimentar grid do frontend. */
  async list(tonId: string, user?: ScopedUser): Promise<TonAiResponseDto[]> {
    const tId = tonId.trim();
    const ton = await this.assertTonExists(tId);
    if (user) await this.scopeService.assertEntityInScope('equipamento', tId, user);

    const rows = await this.queryAis(
      Prisma.sql`a.ton_id = ${tId} AND a.deleted_at IS NULL`,
    );
    const byNumero = new Map(rows.map((r) => [Number(r.ai_numero), r]));

    const out: TonAiResponseDto[] = [];
    const aiCount = tonAiCount(ton.tipo_equipamento);
    for (let n = 1; n <= aiCount; n++) {
      const row = byNumero.get(n);
      out.push(row ? this.toResponse(row) : this.placeholder(tId, n));
    }
    return out;
  }

  // ============================================================================
  // Escrita
  // ============================================================================

  async create(
    tonId: string,
    dto: CreateTonAiDto,
    user?: ScopedUser,
  ): Promise<TonAiResponseDto> {
    const tId = tonId.trim();
    const ton = await this.assertTonExists(tId);
    if (user) await this.scopeService.assertEntityInScope('equipamento', tId, user);

    const aiCount = tonAiCount(ton.tipo_equipamento);
    if (dto.ai_numero > aiCount) {
      throw new BadRequestException(
        `AI ${dto.ai_numero} invalido: modelo ${ton.tipo_equipamento ?? 'TON'} tem ${aiCount} canais analogicos`,
      );
    }

    if (dto.equipamento_ponto_id) {
      await this.assertPontoMedicao(dto.equipamento_ponto_id.trim());
    }
    const { mv0, mv100 } = this.normalizeEscala(dto.mv_0, dto.mv_100);

    const dup = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM ton_ai
      WHERE ton_id = ${tId} AND ai_numero = ${dto.ai_numero} AND deleted_at IS NULL
      LIMIT 1
    `;
    if (dup.length > 0) {
      throw new ConflictException(
        `AI ${dto.ai_numero} ja existe para essa TON. Use PATCH /ais/:aiId.`,
      );
    }

    const id = this.genId();
    const pontoId = dto.equipamento_ponto_id?.trim() ?? null;
    const ativo = dto.ativo ?? true;

    try {
      await this.prisma.$executeRaw`
        INSERT INTO ton_ai
          (id, ton_id, ai_numero, equipamento_ponto_id, mv_0, mv_100, ativo, created_at, updated_at)
        VALUES
          (${id}, ${tId}, ${dto.ai_numero}, ${pontoId}, ${mv0}, ${mv100}, ${ativo}, now(), now())
      `;
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException(
          `AI ${dto.ai_numero} ja existe para essa TON. Use PATCH /ais/:aiId.`,
        );
      }
      throw err;
    }
    return this.getById(tId, id);
  }

  async update(
    tonId: string,
    aiId: string,
    dto: UpdateTonAiDto,
    user?: ScopedUser,
  ): Promise<TonAiResponseDto> {
    const tId = tonId.trim();
    const aId = aiId.trim();
    await this.assertAiExists(tId, aId);
    if (user) await this.scopeService.assertEntityInScope('equipamento', tId, user);

    if (dto.equipamento_ponto_id !== undefined && dto.equipamento_ponto_id !== null) {
      await this.assertPontoMedicao(dto.equipamento_ponto_id.trim());
    }

    const sets: Prisma.Sql[] = [];
    if (dto.ai_numero !== undefined) sets.push(Prisma.sql`ai_numero = ${dto.ai_numero}`);
    if (dto.mv_0 !== undefined) sets.push(Prisma.sql`mv_0 = ${Math.trunc(dto.mv_0)}`);
    if (dto.mv_100 !== undefined) sets.push(Prisma.sql`mv_100 = ${Math.trunc(dto.mv_100)}`);
    if (dto.ativo !== undefined) sets.push(Prisma.sql`ativo = ${dto.ativo}`);
    if (dto.equipamento_ponto_id !== undefined) {
      const pontoId = dto.equipamento_ponto_id ? dto.equipamento_ponto_id.trim() : null;
      sets.push(Prisma.sql`equipamento_ponto_id = ${pontoId}`);
    }
    sets.push(Prisma.sql`updated_at = now()`);

    try {
      await this.prisma.$executeRaw`
        UPDATE ton_ai SET ${Prisma.join(sets, ', ')}
        WHERE id = ${aId} AND ton_id = ${tId} AND deleted_at IS NULL
      `;
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException(`AI ${dto.ai_numero} ja existe para essa TON`);
      }
      throw err;
    }
    return this.getById(tId, aId);
  }

  async remove(tonId: string, aiId: string, user?: ScopedUser): Promise<void> {
    const tId = tonId.trim();
    const aId = aiId.trim();
    await this.assertAiExists(tId, aId);
    if (user) await this.scopeService.assertEntityInScope('equipamento', tId, user);

    await this.prisma.$executeRaw`
      UPDATE ton_ai SET deleted_at = now()
      WHERE id = ${aId} AND ton_id = ${tId} AND deleted_at IS NULL
    `;
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private normalizeEscala(mv0?: number, mv100?: number): { mv0: number; mv100: number } {
    const a = Math.trunc(Number.isFinite(mv0 as number) ? (mv0 as number) : 0);
    const b = Math.trunc(Number.isFinite(mv100 as number) ? (mv100 as number) : 3000);
    if (b <= a) {
      throw new BadRequestException(
        `Escala invalida: mv_100 (${b}) deve ser maior que mv_0 (${a}).`,
      );
    }
    return { mv0: a, mv100: b };
  }

  private queryAis(where: Prisma.Sql): Promise<RawAiRow[]> {
    return this.prisma.$queryRaw<RawAiRow[]>`
      SELECT a.id, a.ton_id, a.ai_numero, a.equipamento_ponto_id, a.mv_0, a.mv_100,
             a.ativo, a.created_at, a.updated_at,
             p.id AS p_id, p.tipo AS p_tipo, p.nome AS p_nome,
             p.equipamento_id AS p_equip_id, eq.nome AS p_equip_nome
      FROM ton_ai a
      LEFT JOIN equipamento_pontos p
        ON p.id = a.equipamento_ponto_id AND p.deleted_at IS NULL
      LEFT JOIN equipamentos eq ON eq.id = p.equipamento_id
      WHERE ${where}
      ORDER BY a.ai_numero ASC
    `;
  }

  private async getById(tonId: string, aiId: string): Promise<TonAiResponseDto> {
    const rows = await this.queryAis(
      Prisma.sql`a.id = ${aiId} AND a.ton_id = ${tonId} AND a.deleted_at IS NULL`,
    );
    if (rows.length === 0) {
      throw new NotFoundException(`AI ${aiId} nao encontrado na TON ${tonId}`);
    }
    return this.toResponse(rows[0]);
  }

  private async assertTonExists(tonId: string) {
    const ton = await this.prisma.equipamentos.findFirst({
      where: { id: tonId, deleted_at: null },
      select: { id: true, tipo_equipamento: true },
    });
    if (!ton) {
      throw new NotFoundException(`TON ${tonId} nao encontrada`);
    }
    return ton;
  }

  private async assertAiExists(tonId: string, aiId: string) {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM ton_ai
      WHERE id = ${aiId} AND ton_id = ${tonId} AND deleted_at IS NULL
      LIMIT 1
    `;
    if (rows.length === 0) {
      throw new NotFoundException(`AI ${aiId} nao encontrado na TON ${tonId}`);
    }
  }

  private async assertPontoMedicao(pontoId: string) {
    const ponto = await this.prisma.equipamento_pontos.findFirst({
      where: { id: pontoId, deleted_at: null },
      select: { id: true, tipo: true, ativo: true },
    });
    if (!ponto) {
      throw new BadRequestException(`Ponto ${pontoId} nao encontrado ou foi deletado`);
    }
    if (ponto.tipo !== 'medicao') {
      throw new BadRequestException(
        `Ponto ${pontoId} eh do tipo "${ponto.tipo}" — AIs so aceitam tipo "medicao".`,
      );
    }
    if (!ponto.ativo) {
      throw new BadRequestException(
        `Ponto ${pontoId} esta inativo. Ative antes de mapear em AI.`,
      );
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2002') return true;
      const meta = err.meta as { code?: unknown } | undefined;
      if (meta && String(meta.code) === '23505') return true;
    }
    return false;
  }

  private toResponse(row: RawAiRow): TonAiResponseDto {
    return {
      id: row.id,
      ton_id: row.ton_id,
      ai_numero: Number(row.ai_numero),
      equipamento_ponto_id: row.equipamento_ponto_id,
      mv_0: Number(row.mv_0),
      mv_100: Number(row.mv_100),
      ativo: !!row.ativo,
      created_at: row.created_at,
      updated_at: row.updated_at,
      ponto: row.p_id
        ? {
            id: row.p_id,
            tipo: row.p_tipo!,
            nome: row.p_nome!,
            equipamento_id: row.p_equip_id!,
            equipamento_nome: row.p_equip_nome!,
          }
        : null,
    };
  }

  private placeholder(tonId: string, aiNumero: number): TonAiResponseDto {
    return {
      id: '',
      ton_id: tonId,
      ai_numero: aiNumero,
      equipamento_ponto_id: null,
      mv_0: 0,
      mv_100: 3000,
      ativo: true,
      created_at: new Date(0),
      updated_at: new Date(0),
      ponto: null,
    };
  }
}

// ============================================================================
// Tipo da linha crua ($queryRaw)
// ============================================================================

interface RawAiRow {
  id: string;
  ton_id: string;
  ai_numero: number | bigint;
  equipamento_ponto_id: string | null;
  mv_0: number | bigint;
  mv_100: number | bigint;
  ativo: boolean;
  created_at: Date;
  updated_at: Date;
  p_id: string | null;
  p_tipo: string | null;
  p_nome: string | null;
  p_equip_id: string | null;
  p_equip_nome: string | null;
}
