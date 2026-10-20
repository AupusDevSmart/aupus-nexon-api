import { Injectable } from '@nestjs/common';
import { PermissionScopeService, PrismaService, ScopedUser } from '@/core';
import { calcularBucket, getNum } from './gateway-dashboard.service';
import { Bloco15, resumoBlocos } from './medidor-resumo.util';

const TZ = 'America/Sao_Paulo';
/** Teto anti-glitch de potência de inversor (kW), como no COA. */
const CAP_INV_KW = 5000;

/**
 * Resumo do ciclo do medidor da concessionária (cartões "Geração", "Fator de potência
 * e reativo" e "Energia do ciclo" do modal web).
 *
 * Ciclo = mês corrente (dia 1, 00:00 de Brasília, até agora): o NexON não guarda a data
 * de leitura/reposição da concessionária.
 *
 * Medidor SSU (A-966 / TON-V2): cada linha é um bloco de 15 min (pulsos → calcularBucket);
 * linhas sem potencia_ativa_kw (dump pós-boot, sts≠1) ficam fora. Medidor direto (PM):
 * média de Pt/Qt (W/var) por janela de 15 min.
 *
 * Geração: inversores da mesma instalação do medidor (latest power.active_total da última
 * hora; energia diária = max(energy.daily_yield) do dia, ou Σ energia_kwh).
 */
@Injectable()
export class MedidorResumoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: PermissionScopeService,
  ) {}

  private inicioMesBRT(agora = new Date()) {
    const [ano, mes] = agora.toLocaleDateString('en-CA', { timeZone: TZ }).split('-').map(Number);
    return new Date(Date.UTC(ano, mes - 1, 1, 3, 0, 0, 0)); // 00:00 BRT
  }
  private inicioDiaBRT(agora = new Date()) {
    const [ano, mes, dia] = agora.toLocaleDateString('en-CA', { timeZone: TZ }).split('-').map(Number);
    return new Date(Date.UTC(ano, mes - 1, dia, 3, 0, 0, 0));
  }

  async resumo(equipamentoId: string, user?: ScopedUser) {
    const id = equipamentoId.trim();
    const desde = this.inicioMesBRT();
    const hoje = this.inicioDiaBRT();
    const blocos = await this.blocos(id, desde);
    const r = resumoBlocos(blocos);
    // Geração soma os inversores da instalação: operador só com "Ver geração" nela (PER-40).
    const geracao = (await this.podeVerGeracao(id, user)) ? await this.geracao(id, desde, hoje) : null;
    const iso = (t?: number | null) => (t ? new Date(t).toISOString() : null);
    return {
      ciclo_inicio: desde.toISOString(),
      fonte: blocos.length ? (blocos[0] as any).fonte : null,
      blocos: r.blocos,
      consumo_kwh: round(r.consumo_kwh, 1),
      injecao_kwh: round(r.injecao_kwh, 1),
      injecao_max: r.injecao_max ? { kw: round(r.injecao_max.kw, 1), timestamp: iso(r.injecao_max.t) } : null,
      fp_min_ind: r.fp_min_ind ? { fp: round(r.fp_min_ind.fp, 3), timestamp: iso(r.fp_min_ind.t) } : null,
      fp_min_cap: r.fp_min_cap ? { fp: round(r.fp_min_cap.fp, 3), timestamp: iso(r.fp_min_cap.t) } : null,
      fp_medio: r.fp_medio != null ? round(r.fp_medio, 3) : null,
      reativo_max: r.reativo_max ? { kvar: round(r.reativo_max.kvar, 1), natureza: r.reativo_max.natureza, timestamp: iso(r.reativo_max.t) } : null,
      energia_reativa_kvarh: round(r.energia_reativa_kvarh, 0),
      reativo_excedente_kvarh: round(r.reativo_excedente_kvarh, 0),
      geracao: geracao
        ? { ...geracao, autoconsumo_kwh: geracao.ciclo_kwh != null ? round(Math.max(0, geracao.ciclo_kwh - r.injecao_kwh), 0) : null }
        : null,
    };
  }

  /** "Ver geração" na instalação do medidor (a dele ou a do equipamento pai). */
  private async podeVerGeracao(id: string, user?: ScopedUser): Promise<boolean> {
    if (!user || !(await this.scope.acessoPorEquipamento(user))) return true;
    const u = await this.prisma.$queryRaw<Array<{ unidade_id: string | null }>>`
      SELECT TRIM(COALESCE(m.unidade_id, pai.unidade_id)) AS unidade_id FROM equipamentos m
      LEFT JOIN equipamentos pai ON pai.id = m.equipamento_pai_id
      WHERE m.id = ${id}::bpchar`;
    return this.scope.podeVerGeracao(u[0]?.unidade_id ?? null, user);
  }

  /**
   * Blocos de 15 min do período (SSU ou PM), de `desde` até `ate` (exclusivo; sem `ate` = até
   * agora). Público: o relatório de operação (NEXON-33) usa a mesma leitura do medidor.
   */
  async blocos(id: string, desde: Date, ate?: Date): Promise<Array<Bloco15 & { fonte: string }>> {
    const fim = ate ?? new Date('9999-12-31T00:00:00Z');
    const ssu = await this.prisma.$queryRaw<Array<{ t: Date; dados: any }>>`
      SELECT timestamp_dados AS t, dados FROM equipamentos_dados
      WHERE equipamento_id = ${id}::bpchar AND timestamp_dados >= ${desde} AND timestamp_dados < ${fim}
        AND (dados ? 'NSU' OR dados->'data' ? 'phf') AND potencia_ativa_kw IS NOT NULL
      ORDER BY timestamp_dados`;
    if (ssu.length) {
      return ssu.map((x) => {
        const d = calcularBucket(getNum(x.dados, 'phf'), getNum(x.dados, 'phr'), getNum(x.dados, 'qhfi'), getNum(x.dados, 'qhfc'), getNum(x.dados, 'qhri'), getNum(x.dados, 'qhrc'));
        return { t: new Date(x.t).getTime(), kWc: d.kW_consumo, kWi: d.kW_injecao, kvarInd: d.kvar_ind, kvarCap: d.kvar_cap, fonte: 'ssu' };
      });
    }
    // PM: Pt/Qt em W/var (Pt < 0 = injeção; Qt < 0 = capacitivo), média por 15 min.
    const pm = await this.prisma.$queryRaw<Array<{ t: Date; p: number | null; q: number | null }>>`
      SELECT to_timestamp(floor(extract(epoch FROM timestamp_dados) / 900) * 900 + 900) AT TIME ZONE 'UTC' AS t,
             AVG(NULLIF(dados->>'Pt','')::float) AS p, AVG(NULLIF(dados->>'Qt','')::float) AS q
      FROM equipamentos_dados
      WHERE equipamento_id = ${id}::bpchar AND timestamp_dados >= ${desde} AND timestamp_dados < ${fim} AND dados ? 'Pt'
      GROUP BY 1 ORDER BY 1`;
    return pm.filter((x) => x.p != null).map((x) => {
      const p = Number(x.p) / 1000, q = Number(x.q ?? 0) / 1000;
      return { t: new Date(x.t).getTime(), kWc: Math.max(0, p), kWi: Math.max(0, -p), kvarInd: Math.max(0, q), kvarCap: Math.max(0, -q), fonte: 'pm' };
    });
  }

  /** Inversores da instalação do medidor: agora, máx. do mês, hoje e ciclo. */
  private async geracao(id: string, desde: Date, hoje: Date) {
    const invs = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT TRIM(i.id) AS id FROM equipamentos m
      LEFT JOIN equipamentos pai ON pai.id = m.equipamento_pai_id
      JOIN equipamentos i ON TRIM(i.unidade_id) = TRIM(COALESCE(m.unidade_id, pai.unidade_id)) AND i.deleted_at IS NULL
      WHERE m.id = ${id}::bpchar AND (i.tipo_equipamento ILIKE '%INVERSOR%')`;
    if (!invs.length) return null;
    const ids = invs.map((x) => x.id);
    const agora = await this.prisma.$queryRaw<Array<{ kw: number | null }>>`
      SELECT SUM(kw) AS kw FROM (
        SELECT DISTINCT ON (equipamento_id) COALESCE((dados->'power'->>'active_total')::float / 1000, potencia_ativa_kw::float) AS kw
        FROM equipamentos_dados
        WHERE TRIM(equipamento_id) = ANY(${ids}) AND timestamp_dados > now() - interval '1 hour'
        ORDER BY equipamento_id, timestamp_dados DESC) x WHERE kw < ${CAP_INV_KW}`;
    const pico = await this.prisma.$queryRaw<Array<{ t: Date; kw: number }>>`
      SELECT t, SUM(kw) AS kw FROM (
        SELECT equipamento_id, date_trunc('hour', timestamp_dados) + floor(extract(minute FROM timestamp_dados) / 15) * interval '15 minutes' AS t,
               AVG(COALESCE((dados->'power'->>'active_total')::float / 1000, potencia_ativa_kw::float)) AS kw
        FROM equipamentos_dados
        WHERE TRIM(equipamento_id) = ANY(${ids}) AND timestamp_dados >= ${desde}
        GROUP BY 1, 2) x WHERE kw < ${CAP_INV_KW}
      GROUP BY t ORDER BY 2 DESC NULLS LAST LIMIT 1`;
    const dias = await this.prisma.$queryRaw<Array<{ dia: Date; kwh: number }>>`
      SELECT dia, SUM(dia_kwh) AS kwh FROM (
        SELECT equipamento_id, date_trunc('day', (timestamp_dados AT TIME ZONE 'UTC') AT TIME ZONE ${TZ}) AS dia,
               CASE WHEN COUNT(dados->'energy'->>'daily_yield') >= 1 THEN MAX((dados->'energy'->>'daily_yield')::numeric)
                    ELSE SUM(energia_kwh) END AS dia_kwh
        FROM equipamentos_dados
        WHERE TRIM(equipamento_id) = ANY(${ids}) AND timestamp_dados >= ${desde}
          AND (potencia_ativa_kw IS NULL OR potencia_ativa_kw < ${CAP_INV_KW})
        GROUP BY 1, 2) x GROUP BY dia`;
    const diaHoje = hoje.toISOString().slice(0, 10);
    const kwhHoje = dias.filter((d) => new Date(d.dia).toISOString().slice(0, 10) === diaHoje).reduce((a, d) => a + Number(d.kwh || 0), 0);
    const ciclo = dias.reduce((a, d) => a + Number(d.kwh || 0), 0);
    return {
      inversores: ids.length,
      agora_kw: agora[0]?.kw != null ? round(Number(agora[0].kw), 1) : null,
      max_mes: pico[0]?.kw != null ? { kw: round(Number(pico[0].kw), 1), timestamp: new Date(pico[0].t).toISOString() } : null,
      hoje_kwh: dias.length ? round(kwhHoje, 0) : null,
      ciclo_kwh: dias.length ? round(ciclo, 0) : null,
    };
  }
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
