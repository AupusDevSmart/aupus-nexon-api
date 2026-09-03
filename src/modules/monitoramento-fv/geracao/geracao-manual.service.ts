import { ForbiddenException, Injectable, BadRequestException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService, Prisma, ScopedUser } from '@/core';

/**
 * Entrada/correção MANUAL da geração diária (igual ao fluxo de xlsx do BDO). Analistas e
 * administradores lançam ou corrigem `geracao_diaria_plantas` com `origem='manual'`. Essa
 * origem tem PRECEDÊNCIA: o cron de nuvem NÃO sobrescreve linha manual (guard no
 * sync.service.upsert: `WHERE origem IS DISTINCT FROM 'manual'`).
 *
 * RBAC: só papéis de administrador (super_admin/admin) editam — são os que têm a permissão
 * `Monitoramento` (mesmo gate do menu). Proprietário (cliente privilegiado), operador (campo)
 * e consultor (técnico de equipamento) NÃO editam geração. Ajustar aqui se criarem um papel
 * "analista" dedicado.
 */
const PAPEIS_EDITORES = ['super_admin', 'admin', 'analista'];

export interface LinhaManual {
  unidadeId?: string;
  nome?: string; // alternativa ao id (import Excel usa nome)
  data: string; // YYYY-MM-DD
  kwhRealizado: number;
  kwhPrevisto?: number | null;
}

@Injectable()
export class GeracaoManualService {
  constructor(private readonly prisma: PrismaService) {}

  assertEditor(user?: ScopedUser): void {
    if (!user?.role || !PAPEIS_EDITORES.includes(user.role)) {
      throw new ForbiddenException('Apenas analistas e administradores podem editar a geração.');
    }
  }

  /** Unidades FV elegíveis (cloud-tracked ou com histórico) — popula dropdown + template. */
  async listarUnidades(): Promise<Array<{ unidade_id: string; nome: string; provedor: string | null; predicao: number | null }>> {
    return this.prisma.$queryRaw`
      SELECT TRIM(u.id) AS unidade_id, TRIM(u.nome) AS nome, c.provedor_monitoramento AS provedor,
             u.predicao_diaria_kwh::float8 AS predicao
      FROM unidades u
      LEFT JOIN unidade_fv_config c ON TRIM(c.unidade_id) = TRIM(u.id)
      WHERE u.deleted_at IS NULL
        AND (c.unidade_id IS NOT NULL
             OR EXISTS (SELECT 1 FROM geracao_diaria_plantas g WHERE TRIM(g.unidade_id) = TRIM(u.id)))
      ORDER BY nome
    `;
  }

  /**
   * Meta da usina (kWh/dia) — propriedade da INSTALACAO. Fonte unica: unidades.predicao_diaria_kwh.
   * O cron e as telas leem daqui; editar aqui vale para toda usina (inclusive as manuais, que
   * nao tem config de sync). null limpa a meta.
   */
  async salvarMeta(unidadeId: string, predicao: number | null): Promise<void> {
    const id = (unidadeId ?? '').trim();
    if (!id) throw new Error('unidadeId obrigatório');
    if (predicao != null && (!Number.isFinite(predicao) || predicao < 0)) throw new Error('meta inválida');
    await this.prisma.$executeRaw(
      Prisma.sql`UPDATE unidades SET predicao_diaria_kwh = ${predicao}, updated_at = now() WHERE TRIM(id) = ${id} AND deleted_at IS NULL`,
    );
  }

  /** Linhas de geração p/ a tabela editável (janela de datas, opcionalmente 1 unidade). */
  async listar(filtro: { unidadeId?: string; de?: string; ate?: string }): Promise<
    Array<{ unidade_id: string; nome: string; data: string; kwh_realizado: number; kwh_previsto: number; origem: string }>
  > {
    const de = filtro.de && /^\d{4}-\d{2}-\d{2}$/.test(filtro.de) ? filtro.de : null;
    const ate = filtro.ate && /^\d{4}-\d{2}-\d{2}$/.test(filtro.ate) ? filtro.ate : null;
    const uid = filtro.unidadeId?.trim() || null;
    return this.prisma.$queryRaw(Prisma.sql`
      SELECT TRIM(g.unidade_id) AS unidade_id, TRIM(u.nome) AS nome,
             to_char(g.data, 'YYYY-MM-DD') AS data,
             g.kwh_realizado::float8 AS kwh_realizado,
             g.kwh_previsto::float8  AS kwh_previsto,
             g.origem
      FROM geracao_diaria_plantas g
      JOIN unidades u ON TRIM(u.id) = TRIM(g.unidade_id) AND u.deleted_at IS NULL
      WHERE 1=1
        ${uid ? Prisma.sql`AND TRIM(g.unidade_id) = ${uid}` : Prisma.empty}
        ${de ? Prisma.sql`AND g.data >= ${de}::date` : Prisma.empty}
        ${ate ? Prisma.sql`AND g.data <= ${ate}::date` : Prisma.empty}
      ORDER BY g.data DESC, nome
      LIMIT 2000
    `);
  }

  /** Resolve unidade por id (preferido) ou por nome (trim, case-insensitive) — p/ o Excel. */
  private async resolverUnidadeId(l: LinhaManual): Promise<string> {
    const uid = l.unidadeId?.trim();
    if (uid) {
      const ok = await this.prisma.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT TRIM(id) AS id FROM unidades WHERE TRIM(id) = ${uid} AND deleted_at IS NULL LIMIT 1`,
      );
      if (ok.length === 0) throw new Error(`unidade_id não encontrada: ${uid}`);
      return ok[0].id;
    }
    const nome = l.nome?.trim();
    if (!nome) throw new Error('linha sem unidadeId nem nome');
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT TRIM(id) AS id FROM unidades WHERE deleted_at IS NULL AND lower(TRIM(nome)) = lower(${nome}) LIMIT 2`,
    );
    if (rows.length === 0) throw new Error(`usina não encontrada pelo nome: "${nome}"`);
    if (rows.length > 1) throw new Error(`nome ambíguo (2+ unidades): "${nome}" — use o unidadeId`);
    return rows[0].id;
  }

  private validarLinha(l: LinhaManual): void {
    if (!l?.data || !/^\d{4}-\d{2}-\d{2}$/.test(String(l.data))) throw new Error(`data inválida: ${l?.data}`);
    const r = Number(l.kwhRealizado);
    if (!Number.isFinite(r) || r < 0) throw new Error(`kwhRealizado inválido: ${l?.kwhRealizado}`);
    if (l.kwhPrevisto != null) {
      const p = Number(l.kwhPrevisto);
      if (!Number.isFinite(p) || p < 0) throw new Error(`kwhPrevisto inválido: ${l?.kwhPrevisto}`);
    }
  }

  /** Upsert manual (origem='manual', sempre vence a nuvem). Se kwhPrevisto omitido, mantém o existente. */
  async upsertManual(l: LinhaManual): Promise<void> {
    this.validarLinha(l);
    const unidadeId = await this.resolverUnidadeId(l);
    const id = randomBytes(13).toString('hex');
    const real = Number(l.kwhRealizado);
    const prev = l.kwhPrevisto != null ? Number(l.kwhPrevisto) : null;
    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO geracao_diaria_plantas
        (id, unidade_id, data, kwh_realizado, kwh_previsto, origem, created_at, updated_at)
      VALUES (${id}, ${unidadeId}, ${l.data}::date, ${real}, ${prev ?? 0}, 'manual', now(), now())
      ON CONFLICT (unidade_id, data) DO UPDATE SET
        kwh_realizado = ${real},
        kwh_previsto  = ${prev === null
          ? Prisma.sql`geracao_diaria_plantas.kwh_previsto`
          : Prisma.sql`${prev}`},
        origem = 'manual',
        updated_at = now()
    `);
  }

  /** Import em lote (Excel/CSV parseado no front → JSON). Best-effort: aplica o que der, reporta erros. */
  async upsertBulk(linhas: LinhaManual[]): Promise<{ aplicadas: number; erros: Array<{ linha: number; erro: string }> }> {
    if (!Array.isArray(linhas) || linhas.length === 0) throw new BadRequestException('nenhuma linha recebida');
    if (linhas.length > 5000) throw new BadRequestException('máximo 5000 linhas por importação');
    let aplicadas = 0;
    const erros: Array<{ linha: number; erro: string }> = [];
    for (let i = 0; i < linhas.length; i++) {
      try {
        await this.upsertManual(linhas[i]);
        aplicadas++;
      } catch (e: any) {
        erros.push({ linha: i + 1, erro: String(e?.message || e) });
      }
    }
    return { aplicadas, erros };
  }

  /** Remove a correção manual (volta a ser preenchida pela nuvem no próximo sync). */
  async remover(unidadeId: string, data: string): Promise<{ removidas: number }> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new BadRequestException('data inválida');
    const n = await this.prisma.$executeRaw(Prisma.sql`
      DELETE FROM geracao_diaria_plantas
      WHERE TRIM(unidade_id) = ${unidadeId.trim()} AND data = ${data}::date AND origem = 'manual'
    `);
    return { removidas: Number(n) || 0 };
  }
}
