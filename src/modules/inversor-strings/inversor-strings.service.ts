import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService, PermissionScopeService, ScopedUser } from '@/core';

/**
 * Perfil das strings de um inversor, aprendido do histórico (últimos 14 dias gerando):
 *  - presença: % das leituras com corrente (> 0,5 A). Porta que nunca tem corrente = "não
 *    conectada" pelo projeto (ex.: Huawei 100KTL com 13 de 20 entradas usadas).
 *  - razão típica: corrente da string ÷ mediana das strings ativas no mesmo instante. Uma
 *    string que sempre roda a ~55% da mediana (orientação/comprimento diferente) tem razão
 *    0,55 — a ficha compara com isso, não com a mediana crua (sem alerta falso).
 * Ajuste manual (inversor_strings_config.modos) sobrepõe a detecção.
 */
export interface PerfilString { n: number; presenca: number; razao: number | null; amostras: number }
export type ModoString = 'usada' | 'nao_usada';

const JANELA_DIAS = 14;
const MAX_LEITURAS = 4000;
const CACHE_MS = 30 * 60_000;
const I_PRESENTE = 0.5;   // A
const MED_MIN = 2;        // A — só aprende razão com sol de verdade

@Injectable()
export class InversorStringsService {
  private readonly cache = new Map<string, { em: number; perfil: { strings: PerfilString[]; leituras: number; desde: Date | null } }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: PermissionScopeService,
  ) {}

  async obter(equipamentoId: string, user?: ScopedUser) {
    const id = String(equipamentoId).trim();
    if (user) await this.scope.assertEntityInScope('equipamento', id, user);
    const perfil = await this.perfil(id);
    const cfg = await this.prisma.$queryRaw<Array<{ modos: Record<string, ModoString> }>>`
      SELECT modos FROM inversor_strings_config WHERE equipamento_id = ${id}::bpchar`;
    return { ...perfil, modos: cfg[0]?.modos ?? {}, janela_dias: JANELA_DIAS };
  }

  async salvarModos(equipamentoId: string, modos: Record<string, string>, user?: ScopedUser) {
    const id = String(equipamentoId).trim();
    if (user) await this.scope.assertEntityInScope('equipamento', id, user);
    const limpo: Record<string, ModoString> = {};
    for (const [k, v] of Object.entries(modos ?? {})) {
      const n = Math.trunc(Number(k));
      if (!(n >= 1 && n <= 48)) throw new BadRequestException(`String inválida: ${k}`);
      if (v === 'usada' || v === 'nao_usada') limpo[String(n)] = v;   // 'auto' = ausente
    }
    await this.prisma.$executeRaw`
      INSERT INTO inversor_strings_config (equipamento_id, modos, updated_at, updated_by)
      VALUES (${id}::bpchar, ${JSON.stringify(limpo)}::jsonb, now(), ${user?.id?.trim() || null})
      ON CONFLICT (equipamento_id) DO UPDATE SET modos = EXCLUDED.modos, updated_at = now(), updated_by = EXCLUDED.updated_by`;
    return this.obter(id, user);
  }

  private async perfil(id: string) {
    const c = this.cache.get(id);
    if (c && Date.now() - c.em < CACHE_MS) return c.perfil;
    const desde = new Date(Date.now() - JANELA_DIAS * 86_400_000);
    const rows = await this.prisma.$queryRaw<Array<{ ts: Date; dc: Record<string, unknown> | null }>>`
      SELECT timestamp_dados AS ts, dados->'dc' AS dc
      FROM equipamentos_dados
      WHERE equipamento_id = ${id}::bpchar AND timestamp_dados >= ${desde}
        AND COALESCE(NULLIF(dados->'power'->>'active_total', '')::numeric, 0) > 0
      ORDER BY timestamp_dados DESC
      LIMIT ${MAX_LEITURAS}`;
    const presentes = new Map<number, number>();
    const razoes = new Map<number, number[]>();
    let maxN = 0;
    let validas = 0;
    for (const r of rows) {
      const dc = r.dc ?? {};
      const correntes: Array<[number, number]> = [];
      for (const [k, v] of Object.entries(dc)) {
        const m = /^string(\d+)_current$/.exec(k);
        const x = Number(v);
        if (m && Number.isFinite(x)) correntes.push([Number(m[1]), x]);
      }
      if (correntes.length === 0) continue;
      const ativas = correntes.filter(([, i]) => i > I_PRESENTE).map(([, i]) => i).sort((a, b) => a - b);
      const med = ativas.length ? (ativas.length % 2 ? ativas[(ativas.length - 1) / 2] : (ativas[ativas.length / 2 - 1] + ativas[ativas.length / 2]) / 2) : 0;
      if (med < MED_MIN) continue;   // pouco sol: não ensina nada
      validas++;
      for (const [n, i] of correntes) {
        maxN = Math.max(maxN, n);
        if (i > I_PRESENTE) presentes.set(n, (presentes.get(n) ?? 0) + 1);
        const lista = razoes.get(n) ?? [];
        lista.push(i / med);
        razoes.set(n, lista);
      }
    }
    const strings: PerfilString[] = [];
    for (let n = 1; n <= maxN; n++) {
      const lista = (razoes.get(n) ?? []).sort((a, b) => a - b);
      const razao = lista.length ? lista[Math.floor(lista.length / 2)] : null;
      strings.push({
        n,
        presenca: validas ? (presentes.get(n) ?? 0) / validas : 0,
        razao: razao == null ? null : Math.round(razao * 1000) / 1000,
        amostras: lista.length,
      });
    }
    const perfil = { strings, leituras: validas, desde: rows.length ? rows[rows.length - 1].ts : null };
    this.cache.set(id, { em: Date.now(), perfil });
    return perfil;
  }
}
