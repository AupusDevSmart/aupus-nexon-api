import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService, PermissionScopeService, ScopedUser } from '@/core';
import { tonBiCount } from '../../shared/util/ton-caps';
import { Prisma } from '@/core';
import { customAlphabet } from 'nanoid';

import {
  CreateTonBiDto,
  UpdateTonBiDto,
  TonBiResponseDto,
  TonBiEstadoDto,
} from './dto/ton-bi.dto';

/**
 * CRUD do mapeamento BI (Boolean Input) -> ponto + leitura do estado atual.
 *
 * Acesso via raw SQL (ton_bi / equipamento_io_estado nao estao no client Prisma
 * tipado — schema vive no pacote git api-shared, hardlinkado ao store pnpm;
 * ver db/manual-migrations/2026-06-18_bi_inputs.sql). `prisma migrate deploy`
 * nao dropa tabelas fora do schema, entao as tabelas sao seguras.
 *
 * Invariantes (espelham ton_bo):
 *  - TON precisa existir (deleted_at IS NULL).
 *  - bi_numero eh UNIQUE por ton_id (banco garante). Conflito -> 409.
 *  - equipamento_ponto_id, se fornecido, precisa existir + ser tipo='status'
 *    + estar ativo. BI representa estado/indicacao, nao comando.
 *  - Soft delete via deleted_at — preserva historico.
 *
 * Pre-populacao: GET /equipamentos/:tonId/bis retorna sempre 6 entradas
 * (BI01..BI06): existentes + placeholders (id="") pros faltantes.
 */
@Injectable()
export class TonBiService {
  private readonly logger = new Logger(TonBiService.name);

  // cuid-like: 25 chars, [a-z0-9], comeca com letra (compativel com char(26)).
  private static readonly _head = customAlphabet('abcdefghijklmnopqrstuvwxyz', 1);
  private static readonly _rest = customAlphabet(
    'abcdefghijklmnopqrstuvwxyz0123456789',
    24,
  );
  private genId(): string {
    return TonBiService._head() + TonBiService._rest();
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly scopeService: PermissionScopeService,
  ) {}

  // ============================================================================
  // Leitura
  // ============================================================================

  /** BIs conforme o modelo (v1=6, TON-V2=8) pra alimentar grid do frontend. */
  async list(tonId: string, user?: ScopedUser): Promise<TonBiResponseDto[]> {
    const tId = tonId.trim();
    const ton = await this.assertTonExists(tId);
    if (user) await this.scopeService.assertEntityInScope('equipamento', tId, user);

    const rows = await this.queryBis(Prisma.sql`b.ton_id = ${tId} AND b.deleted_at IS NULL`);
    const byNumero = new Map(rows.map((r) => [Number(r.bi_numero), r]));

    const out: TonBiResponseDto[] = [];
    const biCount = tonBiCount(ton.tipo_equipamento);
    for (let n = 1; n <= biCount; n++) {
      const row = byNumero.get(n);
      out.push(row ? this.toResponse(row) : this.placeholder(tId, n));
    }
    return out;
  }

  /**
   * Estado atual dos BIs ativos da TON: junta o mapeamento com o ultimo
   * {d1..d6} lido (equipamento_io_estado.inputs), aplicando inversao (NF).
   */
  async getEstados(tonId: string, user?: ScopedUser): Promise<TonBiEstadoDto[]> {
    const tId = tonId.trim();
    await this.assertTonExists(tId);
    if (user) await this.scopeService.assertEntityInScope('equipamento', tId, user);

    const rows = await this.prisma.$queryRaw<RawEstadoRow[]>`
      SELECT b.bi_numero,
             b.invertido,
             b.ativo,
             b.equipamento_ponto_id,
             p.nome AS ponto_nome,
             (io.inputs ->> ('d' || b.bi_numero))::int AS valor_raw,
             io.updated_at
      FROM ton_bi b
      LEFT JOIN equipamento_pontos p
        ON p.id = b.equipamento_ponto_id AND p.deleted_at IS NULL
      LEFT JOIN equipamento_io_estado io
        ON io.equipamento_id = b.ton_id
      WHERE b.ton_id = ${tId} AND b.deleted_at IS NULL AND b.ativo = true
      ORDER BY b.bi_numero ASC
    `;

    return rows.map((r) => {
      const raw =
        r.valor_raw === null || r.valor_raw === undefined ? null : Number(r.valor_raw);
      const valor = raw === null ? null : r.invertido ? (raw ? 0 : 1) : raw;
      return {
        bi_numero: Number(r.bi_numero),
        valor,
        valor_raw: raw,
        invertido: !!r.invertido,
        ativo: !!r.ativo,
        nome: r.ponto_nome ?? null,
        equipamento_ponto_id: r.equipamento_ponto_id ?? null,
        updated_at: r.updated_at ?? null,
      };
    });
  }

  // ============================================================================
  // Escrita
  // ============================================================================

  async create(
    tonId: string,
    dto: CreateTonBiDto,
    user?: ScopedUser,
  ): Promise<TonBiResponseDto> {
    const tId = tonId.trim();
    const ton = await this.assertTonExists(tId);
    if (user) await this.scopeService.assertEntityInScope('equipamento', tId, user);

    const biCount = tonBiCount(ton.tipo_equipamento);
    if (dto.bi_numero > biCount) {
      throw new BadRequestException(
        `BI ${dto.bi_numero} invalido: modelo ${ton.tipo_equipamento ?? 'TON'} tem ${biCount} entradas`,
      );
    }

    if (dto.equipamento_ponto_id) {
      await this.assertPontoStatus(dto.equipamento_ponto_id.trim());
    }

    // Pre-check (constraint UNIQUE eh o backstop).
    const dup = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM ton_bi
      WHERE ton_id = ${tId} AND bi_numero = ${dto.bi_numero} AND deleted_at IS NULL
      LIMIT 1
    `;
    if (dup.length > 0) {
      throw new ConflictException(
        `BI ${dto.bi_numero} ja existe para essa TON. Use PATCH /bis/:biId.`,
      );
    }

    const id = this.genId();
    const pontoId = dto.equipamento_ponto_id?.trim() ?? null;
    const invertido = dto.invertido ?? false;
    const ativo = dto.ativo ?? true;

    try {
      await this.prisma.$executeRaw`
        INSERT INTO ton_bi
          (id, ton_id, bi_numero, equipamento_ponto_id, invertido, ativo, created_at, updated_at)
        VALUES
          (${id}, ${tId}, ${dto.bi_numero}, ${pontoId}, ${invertido}, ${ativo}, now(), now())
      `;
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException(
          `BI ${dto.bi_numero} ja existe para essa TON. Use PATCH /bis/:biId.`,
        );
      }
      throw err;
    }
    return this.getById(tId, id);
  }

  async update(
    tonId: string,
    biId: string,
    dto: UpdateTonBiDto,
    user?: ScopedUser,
  ): Promise<TonBiResponseDto> {
    const tId = tonId.trim();
    const bId = biId.trim();
    await this.assertBiExists(tId, bId);
    if (user) await this.scopeService.assertEntityInScope('equipamento', tId, user);

    if (dto.equipamento_ponto_id !== undefined && dto.equipamento_ponto_id !== null) {
      await this.assertPontoStatus(dto.equipamento_ponto_id.trim());
    }

    const sets: Prisma.Sql[] = [];
    if (dto.bi_numero !== undefined) sets.push(Prisma.sql`bi_numero = ${dto.bi_numero}`);
    if (dto.invertido !== undefined) sets.push(Prisma.sql`invertido = ${dto.invertido}`);
    if (dto.ativo !== undefined) sets.push(Prisma.sql`ativo = ${dto.ativo}`);
    if (dto.equipamento_ponto_id !== undefined) {
      const pontoId = dto.equipamento_ponto_id ? dto.equipamento_ponto_id.trim() : null;
      sets.push(Prisma.sql`equipamento_ponto_id = ${pontoId}`);
    }
    sets.push(Prisma.sql`updated_at = now()`);

    try {
      await this.prisma.$executeRaw`
        UPDATE ton_bi SET ${Prisma.join(sets, ', ')}
        WHERE id = ${bId} AND ton_id = ${tId} AND deleted_at IS NULL
      `;
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException(`BI ${dto.bi_numero} ja existe para essa TON`);
      }
      throw err;
    }
    return this.getById(tId, bId);
  }

  async remove(tonId: string, biId: string, user?: ScopedUser): Promise<void> {
    const tId = tonId.trim();
    const bId = biId.trim();
    await this.assertBiExists(tId, bId);
    if (user) await this.scopeService.assertEntityInScope('equipamento', tId, user);

    await this.prisma.$executeRaw`
      UPDATE ton_bi SET deleted_at = now()
      WHERE id = ${bId} AND ton_id = ${tId} AND deleted_at IS NULL
    `;
  }

  // ============================================================================
  // Helpers de query
  // ============================================================================

  private queryBis(where: Prisma.Sql): Promise<RawBiRow[]> {
    return this.prisma.$queryRaw<RawBiRow[]>`
      SELECT b.id, b.ton_id, b.bi_numero, b.equipamento_ponto_id, b.invertido,
             b.ativo, b.created_at, b.updated_at,
             p.id AS p_id, p.tipo AS p_tipo, p.nome AS p_nome,
             p.equipamento_id AS p_equip_id, eq.nome AS p_equip_nome
      FROM ton_bi b
      LEFT JOIN equipamento_pontos p
        ON p.id = b.equipamento_ponto_id AND p.deleted_at IS NULL
      LEFT JOIN equipamentos eq ON eq.id = p.equipamento_id
      WHERE ${where}
      ORDER BY b.bi_numero ASC
    `;
  }

  private async getById(tonId: string, biId: string): Promise<TonBiResponseDto> {
    const rows = await this.queryBis(
      Prisma.sql`b.id = ${biId} AND b.ton_id = ${tonId} AND b.deleted_at IS NULL`,
    );
    if (rows.length === 0) {
      throw new NotFoundException(`BI ${biId} nao encontrado na TON ${tonId}`);
    }
    return this.toResponse(rows[0]);
  }

  // ============================================================================
  // Validacoes
  // ============================================================================

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

  private async assertBiExists(tonId: string, biId: string) {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM ton_bi
      WHERE id = ${biId} AND ton_id = ${tonId} AND deleted_at IS NULL
      LIMIT 1
    `;
    if (rows.length === 0) {
      throw new NotFoundException(`BI ${biId} nao encontrado na TON ${tonId}`);
    }
  }

  private async assertPontoStatus(pontoId: string) {
    const ponto = await this.prisma.equipamento_pontos.findFirst({
      where: { id: pontoId, deleted_at: null },
      select: { id: true, tipo: true, ativo: true },
    });
    if (!ponto) {
      throw new BadRequestException(`Ponto ${pontoId} nao encontrado ou foi deletado`);
    }
    if (ponto.tipo !== 'status') {
      throw new BadRequestException(
        `Ponto ${pontoId} eh do tipo "${ponto.tipo}" — BIs so aceitam tipo "status".`,
      );
    }
    if (!ponto.ativo) {
      throw new BadRequestException(
        `Ponto ${pontoId} esta inativo. Ative antes de mapear em BI.`,
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

  // ============================================================================
  // Shape helpers
  // ============================================================================

  private toResponse(row: RawBiRow): TonBiResponseDto {
    return {
      id: row.id,
      ton_id: row.ton_id,
      bi_numero: Number(row.bi_numero),
      equipamento_ponto_id: row.equipamento_ponto_id,
      invertido: !!row.invertido,
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

  /** Placeholder pra BI ainda nao salvo — id "" sinaliza ao frontend pra POST. */
  private placeholder(tonId: string, biNumero: number): TonBiResponseDto {
    return {
      id: '',
      ton_id: tonId,
      bi_numero: biNumero,
      equipamento_ponto_id: null,
      invertido: false,
      ativo: true,
      created_at: new Date(0),
      updated_at: new Date(0),
      ponto: null,
    };
  }
}

// ============================================================================
// Tipos das linhas cruas ($queryRaw)
// ============================================================================

interface RawBiRow {
  id: string;
  ton_id: string;
  bi_numero: number | bigint;
  equipamento_ponto_id: string | null;
  invertido: boolean;
  ativo: boolean;
  created_at: Date;
  updated_at: Date;
  p_id: string | null;
  p_tipo: string | null;
  p_nome: string | null;
  p_equip_id: string | null;
  p_equip_nome: string | null;
}

interface RawEstadoRow {
  bi_numero: number | bigint;
  invertido: boolean;
  ativo: boolean;
  equipamento_ponto_id: string | null;
  ponto_nome: string | null;
  valor_raw: number | null;
  updated_at: Date | null;
}
