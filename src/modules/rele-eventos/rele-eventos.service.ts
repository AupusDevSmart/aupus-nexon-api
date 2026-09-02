import { ForbiddenException, Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService, Prisma, ScopedUser, PlantaScope } from '@/core';

const PAPEIS_EDITORES = ['super_admin', 'admin'];

export interface EventoRow {
  id: string;
  device: string;
  origem_protocolo: string;
  ts_fonte: string | null;
  ts_recebido: string;
  hora_confiavel: boolean;
  tipo_registro: number | null;
  fun: number | null;
  inf: number | null;
  evento: string | null;
  estado: string | null;
  tempo_relativo_ms: number | null;
  falta_num: number | null;
  valor: number | null;
  equipamento_nome: string | null;
}

/**
 * SOE — leitura dos eventos de relé (append-only, ingeridos pelo mqtt.service).
 * Modelo canônico: agnóstico de protocolo (`origem_protocolo`). Ver
 * docs/IOT-SOE-EVENTOS-RELE.md.
 *
 * ⚠️ RBAC: eventos são de equipamento de uma unidade → a listagem É escopada por dono
 * (PlantaScope). Sem isso um proprietário veria trip de usina de outro.
 */
@Injectable()
export class ReleEventosService {
  constructor(private readonly prisma: PrismaService) {}

  assertEditor(user?: ScopedUser): void {
    if (!user?.role || !PAPEIS_EDITORES.includes(user.role)) {
      throw new ForbiddenException('Apenas administradores editam o mapa de códigos.');
    }
  }

  /** Lista eventos, ordenados pela HORA DA FONTE (não a de chegada). */
  async listar(
    opts: { device?: string; equipamentoId?: string; limit?: number; desde?: string },
    scope: PlantaScope = null,
  ): Promise<EventoRow[]> {
    const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 1000);
    const filtros: Prisma.Sql[] = [];
    if (opts.device?.trim()) filtros.push(Prisma.sql`AND e.device = ${opts.device.trim()}`);
    if (opts.equipamentoId?.trim()) {
      filtros.push(Prisma.sql`AND TRIM(e.equipamento_id) = ${opts.equipamentoId.trim()}`);
    }
    if (opts.desde?.trim()) filtros.push(Prisma.sql`AND e.ts_fonte >= ${opts.desde.trim()}::timestamp`);

    // Escopo por dono: eventos -> equipamento -> unidade -> planta.
    const escopo =
      scope === null
        ? Prisma.empty
        : scope.length === 0
          ? Prisma.sql`AND 1 = 0`
          : Prisma.sql`AND TRIM(u.planta_id) IN (${Prisma.join(scope.map((s) => s.trim()))})`;

    return this.prisma.$queryRaw<EventoRow[]>`
      SELECT e.id, e.device, e.origem_protocolo,
             to_char(e.ts_fonte, 'YYYY-MM-DD HH24:MI:SS.MS') AS ts_fonte,
             to_char(e.ts_recebido, 'YYYY-MM-DD HH24:MI:SS') AS ts_recebido,
             e.hora_confiavel, e.tipo_registro, e.fun, e.inf, e.evento, e.estado,
             e.tempo_relativo_ms, e.falta_num, e.valor::float8 AS valor,
             TRIM(eq.nome) AS equipamento_nome
      FROM rele_eventos e
      LEFT JOIN equipamentos eq ON TRIM(eq.id) = TRIM(e.equipamento_id)
      LEFT JOIN unidades u ON TRIM(u.id) = TRIM(eq.unidade_id)
      WHERE 1 = 1
      ${filtros.length > 0 ? Prisma.join(filtros, ' ') : Prisma.empty}
      ${escopo}
      ORDER BY e.ts_fonte DESC NULLS LAST, e.ts_recebido DESC
      LIMIT ${limit}
    `;
  }

  /** Códigos ainda NÃO traduzidos — é a fila de curadoria do mapa FUN/INF. */
  async codigosDesconhecidos(): Promise<Array<{ protocolo: string; fun: number; inf: number; ocorrencias: number }>> {
    return this.prisma.$queryRaw`
      SELECT e.origem_protocolo AS protocolo, e.fun, e.inf, COUNT(*)::int AS ocorrencias
      FROM rele_eventos e
      WHERE e.evento IS NULL AND e.fun IS NOT NULL AND e.inf IS NOT NULL
      GROUP BY 1, 2, 3
      ORDER BY ocorrencias DESC
      LIMIT 100
    `;
  }

  async listarCodigos() {
    return this.prisma.$queryRaw`
      SELECT id, protocolo, fun, inf, evento, descricao
      FROM rele_evento_codigos ORDER BY protocolo, fun, inf
    `;
  }

  /**
   * Cadastra/atualiza a tradução de um código. Reprocessa retroativamente os eventos
   * já gravados com esse fun/inf — o histórico não se perde por falta do mapa.
   */
  async salvarCodigo(d: { protocolo?: string; fun: number; inf: number; evento: string; descricao?: string }) {
    const proto = d.protocolo?.trim() || 'modbus_7sr';
    const id = randomBytes(13).toString('hex');
    await this.prisma.$executeRaw`
      INSERT INTO rele_evento_codigos (id, protocolo, fun, inf, evento, descricao)
      VALUES (${id}, ${proto}, ${Number(d.fun)}, ${Number(d.inf)}, ${d.evento.trim()}, ${d.descricao ?? null})
      ON CONFLICT (protocolo, fun, inf) DO UPDATE SET
        evento = EXCLUDED.evento, descricao = EXCLUDED.descricao
    `;
    const n = await this.prisma.$executeRaw`
      UPDATE rele_eventos SET evento = ${d.evento.trim()}
      WHERE origem_protocolo = ${proto} AND fun = ${Number(d.fun)} AND inf = ${Number(d.inf)}
        AND evento IS DISTINCT FROM ${d.evento.trim()}
    `;
    return { ok: true, reprocessados: n };
  }
}
