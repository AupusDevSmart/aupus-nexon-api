import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/core';
import {
  agregarTonDia, blocosSolares, DiaFonte, escolherFonte, FonteGeracaoConfig, normalizarFonteGeracao, TonDia,
  TonInversorDia,
} from './geracao-fonte';
import { diaLocal, diasEntre, inicioDoDiaUtc, somarDias, sqlUtc } from './geracao-datas';
import { ColunaOpcional, FILTRO_TON, POTENCIA_KW, YIELD_KWH, YIELD_MAX_KWH } from './geracao-sql';

/** Dia escolhido + completude de cada fonte (para quem quer explicar a escolha). */
export interface DiaFonteCalc extends DiaFonte {
  tonCompleta: boolean;
  nuvemCompleta: boolean;
}

interface NuvemDia {
  kwhNuvem: number | null;
  nuvemCompleta: boolean;
  kwhManual: number | null;
}

/** Curva do dia na nuvem: início do bloco de 15 min (ms UTC) → kW médio. */
export interface CurvaNuvem {
  origem: 'horaria' | 'fusion';
  kw: Map<number, number>;
}

const BLOCO_MS = 15 * 60_000;
const HORA_MS = 3_600_000;
/** Dias sem limite prático (período Total). */
const SEM_LIMITE = 20_000;
const CACHE_MS = 60_000;

/** 'YYYY-MM-DDTHH:MI:SS' local (SP, sem fuso) → instante. */
const instanteLocal = (s: string | null): number | null => (s ? Date.parse(`${s}-03:00`) : null);

/**
 * Fonte da geração (NEXON-37): por unidade e dia BRT, qual kWh vale — TON, nuvem ou manual.
 * Regra pura em geracao-fonte.ts (escolherFonte); aqui só as leituras, em lote (o COA chama
 * para todas as unidades a cada 60 s: poucas consultas, agrupadas por unidade e dia).
 *
 * - TON: Σ por inversor (mesma lista de GeracaoConfigService.inversores()) de MAX(daily_yield)
 *   do dia, sem as linhas NUVEM_FUSION; inversor sem daily_yield usa a integral da potência.
 * - Nuvem: MAX(kwh_acumulado) do horário (06h em diante); sem horário, o diário (origem
 *   nuvem/api); sem os dois, hoje/ontem, o fallback Fusion gravado em equipamentos_dados.
 * - Manual: geracao_diaria_plantas com origem manual/bdo.
 */
@Injectable()
export class FonteGeracaoService {
  private readonly logger = new Logger(FonteGeracaoService.name);
  private readonly coluna = new ColunaOpcional(/fonte_geracao/);
  private readonly cache = new Map<string, { ts: number; valor: Map<string, Map<string, DiaFonteCalc>> }>();
  private readonly cacheInversores = new Map<string, { ts: number; valor: Map<string, string[]> }>();

  constructor(private readonly prisma: PrismaService) {}

  // ── Leituras ──────────────────────────────────────────────────────────────

  /** fonte_geracao gravada de cada unidade (ausente ou SQL não aplicado = automatico). */
  async configs(unidadeIds: string[]): Promise<Map<string, FonteGeracaoConfig>> {
    const out = new Map<string, FonteGeracaoConfig>();
    const ids = [...new Set(unidadeIds.map((i) => i.trim()).filter(Boolean))];
    if (!ids.length || !this.coluna.disponivel()) return out;
    try {
      const rows = await this.prisma.$queryRaw<Array<{ u: string; f: string | null }>>`
        SELECT TRIM(unidade_id) AS u, fonte_geracao AS f FROM unidade_usina_config
        WHERE TRIM(unidade_id) = ANY(${ids}::text[])`;
      for (const r of rows) out.set(r.u, normalizarFonteGeracao(r.f));
    } catch (e) {
      if (!this.coluna.ausente(e)) this.logger.warn(`[fonte] config falhou: ${(e as Error)?.message ?? e}`);
    }
    return out;
  }

  /**
   * Inversores de cada unidade (mesmo filtro de GeracaoConfigService.inversores()). Cache de
   * 60 s: o COA pergunta e logo depois o porDias usa a mesma lista.
   */
  async inversoresPorUnidade(unidadeIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    const ids = [...new Set(unidadeIds.map((i) => i.trim()).filter(Boolean))].sort();
    if (!ids.length) return out;
    const chave = ids.join(',');
    const c = this.cacheInversores.get(chave);
    if (c && Date.now() - c.ts < CACHE_MS) return c.valor;
    const rows = await this.prisma.$queryRaw<Array<{ u: string; id: string }>>`
      SELECT TRIM(e.unidade_id) AS u, TRIM(e.id) AS id
      FROM equipamentos e
      LEFT JOIN tipos_equipamentos t ON t.id = e.tipo_equipamento_id
      LEFT JOIN categorias_equipamentos c ON c.id = t.categoria_id
      WHERE e.unidade_id = ANY(${ids}::bpchar[]) AND e.deleted_at IS NULL
        AND COALESCE(e.tipo_equipamento, '') NOT ILIKE 'TON%'
        AND CONCAT_WS(' ', t.codigo, t.nome, e.tipo_equipamento, e.topico_mqtt, c.nome) ~* 'INVERSOR'`;
    for (const r of rows) out.set(r.u, [...(out.get(r.u) ?? []), r.id]);
    if (this.cacheInversores.size > 100) this.cacheInversores.clear();
    this.cacheInversores.set(chave, { ts: Date.now(), valor: out });
    return out;
  }

  /** TON por inversor e dia: daily_yield, integral e blocos solares com leitura. */
  async tonPorInversorDia(inversorIds: string[], diaIni: string, diaFim: string, agora: Date): Promise<Map<string, Map<string, TonInversorDia>>> {
    const out = new Map<string, Map<string, TonInversorDia>>();
    const ini = inicioDoDiaUtc(diaIni);
    const fim = new Date(Math.min(inicioDoDiaUtc(somarDias(diaFim, 1)).getTime(), agora.getTime()));
    if (!inversorIds.length || fim <= ini) return out;
    const rows = await this.prisma.$queryRaw<Array<{ eq: string; dia: string; y: number | null; integ: number | null; blocos: number }>>`
      SELECT eq, dia, MAX(y)::float8 AS y, (SUM(media) * 0.25)::float8 AS integ,
             (COUNT(*) FILTER (WHERE h >= 6 AND h < 18))::int AS blocos
      FROM (
        SELECT TRIM(equipamento_id) AS eq,
               to_char(timestamp_dados - interval '3 hours', 'YYYY-MM-DD') AS dia,
               floor(extract(epoch FROM timestamp_dados) / 900) AS b,
               MIN(extract(hour FROM timestamp_dados - interval '3 hours'))::int AS h,
               AVG(GREATEST(p, 0)) AS media,
               MAX(CASE WHEN y >= 0 AND y < ${YIELD_MAX_KWH} THEN y END) AS y
        FROM (
          SELECT equipamento_id, timestamp_dados, ${POTENCIA_KW} AS p, ${YIELD_KWH} AS y
          FROM equipamentos_dados
          WHERE equipamento_id = ANY(${inversorIds}::bpchar[])
            AND timestamp_dados >= ${sqlUtc(ini)}::timestamp AND timestamp_dados < ${sqlUtc(fim)}::timestamp
            AND ${FILTRO_TON}
        ) x
        WHERE p IS NOT NULL AND abs(p) < 1000000
        GROUP BY 1, 2, 3
      ) b
      GROUP BY eq, dia`;
    for (const r of rows) {
      const m = out.get(r.eq) ?? new Map<string, TonInversorDia>();
      m.set(r.dia, { yieldKwh: r.y ?? null, integralKwh: Number(r.integ) || 0, blocosSolares: Number(r.blocos) || 0 });
      out.set(r.eq, m);
    }
    return out;
  }

  /** Nuvem e manual por unidade e dia. `inversores` habilita o fallback Fusion de hoje/ontem. */
  async nuvemPorDia(
    unidadeIds: string[], diaIni: string, diaFim: string, agora: Date, inversores: Map<string, string[]>,
  ): Promise<Map<string, Map<string, NuvemDia>>> {
    const ids = [...new Set(unidadeIds.map((i) => i.trim()).filter(Boolean))];
    const out = new Map<string, Map<string, NuvemDia>>();
    if (!ids.length) return out;
    const hoje = diaLocal(agora);
    const fimDia = diaFim > hoje ? hoje : diaFim;
    const iniFusion = diaIni > somarDias(hoje, -1) ? diaIni : somarDias(hoje, -1);
    const invFusion = ids.flatMap((u) => inversores.get(u) ?? []);

    const [horaria, diaria, fusion] = await Promise.all([
      this.prisma.$queryRaw<Array<{ u: string; dia: string; kwh: number | null; ultima: string }>>`
        SELECT TRIM(unidade_id) AS u, to_char(hora::date, 'YYYY-MM-DD') AS dia,
               MAX(kwh_acumulado)::float8 AS kwh, to_char(MAX(hora), 'YYYY-MM-DD"T"HH24:MI:SS') AS ultima
        FROM geracao_horaria_plantas
        WHERE TRIM(unidade_id) = ANY(${ids}::text[])
          AND hora >= ${diaIni}::date AND hora < (${fimDia}::date + 1)
          AND EXTRACT(HOUR FROM hora) > 5               -- madrugada = resíduo de ontem na nuvem
          AND COALESCE(origem, 'nuvem') <> 'manual'
        GROUP BY 1, 2`.catch((e) => this.falhou('horária', e)),
      this.prisma.$queryRaw<Array<{ u: string; dia: string; kwh: number | null; origem: string }>>`
        SELECT TRIM(unidade_id) AS u, to_char(data, 'YYYY-MM-DD') AS dia, kwh_realizado::float8 AS kwh,
               lower(COALESCE(origem, 'nuvem')) AS origem
        FROM geracao_diaria_plantas
        WHERE TRIM(unidade_id) = ANY(${ids}::text[]) AND data BETWEEN ${diaIni}::date AND ${fimDia}::date`
        .catch((e) => this.falhou('diária', e)),
      iniFusion <= fimDia && invFusion.length ? this.fusionPorInversorDia(invFusion, iniFusion, fimDia, agora) : Promise.resolve([]),
    ]);

    const pega = (u: string, d: string) => {
      const m = out.get(u) ?? new Map<string, NuvemDia>();
      out.set(u, m);
      const v = m.get(d) ?? { kwhNuvem: null, nuvemCompleta: false, kwhManual: null };
      m.set(d, v);
      return v;
    };
    const recente = (ult: number | null) => ult != null && agora.getTime() - ult <= 2 * HORA_MS;
    const ate17 = (dia: string, ult: number | null) => ult != null && ult >= inicioDoDiaUtc(dia).getTime() + 17 * HORA_MS;
    const completa = (dia: string, ult: number | null) => (dia < hoje ? ate17(dia, ult) : recente(ult));

    const comHoraria = new Set<string>();
    for (const r of horaria) {
      if (r.kwh == null) continue;
      const v = pega(r.u, r.dia);
      v.kwhNuvem = Number(r.kwh);
      v.nuvemCompleta = completa(r.dia, instanteLocal(r.ultima));
      comHoraria.add(`${r.u}|${r.dia}`);
    }
    const comDiaria = new Set<string>();
    for (const r of diaria) {
      if (r.kwh == null) continue;
      const v = pega(r.u, r.dia);
      if (r.origem === 'manual' || r.origem === 'bdo') { v.kwhManual = Number(r.kwh); continue; }
      if (r.origem !== 'nuvem' && r.origem !== 'api') continue;
      comDiaria.add(`${r.u}|${r.dia}`);
      // Fechamento diário (21h) = dia completo na nuvem; o kWh segue o horário quando houver.
      v.nuvemCompleta = true;
      if (!comHoraria.has(`${r.u}|${r.dia}`)) v.kwhNuvem = Number(r.kwh);
    }
    if (fusion.length) {
      const unidadeDe = new Map<string, string>();
      for (const [u, invs] of inversores) for (const i of invs) unidadeDe.set(i, u);
      const porUnidadeDia = new Map<string, { kwh: number; ult: number | null }>();
      for (const r of fusion) {
        const u = unidadeDe.get(r.eq);
        if (!u || r.y == null) continue;
        const k = `${u}|${r.dia}`;
        const a = porUnidadeDia.get(k) ?? { kwh: 0, ult: null };
        a.kwh += Number(r.y);
        const ult = instanteLocal(r.ultima);
        if (ult != null && (a.ult == null || ult > a.ult)) a.ult = ult;
        porUnidadeDia.set(k, a);
      }
      for (const [k, a] of porUnidadeDia) {
        if (comHoraria.has(k) || comDiaria.has(k)) continue;
        const [u, dia] = k.split('|');
        const v = pega(u, dia);
        v.kwhNuvem = a.kwh;
        v.nuvemCompleta = completa(dia, a.ult);
      }
    }
    return out;
  }

  /** Fallback Fusion (equipamentos_dados, fonte NUVEM_FUSION): daily_yield por inversor e dia. */
  private async fusionPorInversorDia(inversorIds: string[], diaIni: string, diaFim: string, agora: Date) {
    const ini = inicioDoDiaUtc(diaIni);
    const fim = new Date(Math.min(inicioDoDiaUtc(somarDias(diaFim, 1)).getTime(), agora.getTime()));
    return this.prisma.$queryRaw<Array<{ eq: string; dia: string; y: number | null; ultima: string }>>`
      SELECT TRIM(equipamento_id) AS eq, to_char(timestamp_dados - interval '3 hours', 'YYYY-MM-DD') AS dia,
             MAX(CASE WHEN y >= 0 AND y < ${YIELD_MAX_KWH} THEN y END)::float8 AS y,
             to_char(MAX(timestamp_dados) - interval '3 hours', 'YYYY-MM-DD"T"HH24:MI:SS') AS ultima
      FROM (
        SELECT equipamento_id, timestamp_dados, ${YIELD_KWH} AS y
        FROM equipamentos_dados
        WHERE equipamento_id = ANY(${inversorIds}::bpchar[])
          AND timestamp_dados >= ${sqlUtc(ini)}::timestamp AND timestamp_dados < ${sqlUtc(fim)}::timestamp
          AND fonte = 'NUVEM_FUSION'
      ) x
      GROUP BY 1, 2`.catch((e) => this.falhou('fusion', e));
  }

  private falhou(o: string, e: unknown): never[] {
    this.logger.warn(`[fonte] nuvem ${o} falhou: ${(e as Error)?.message ?? e}`);
    return [];
  }

  // ── Escolha ───────────────────────────────────────────────────────────────

  private montar(dia: string, config: FonteGeracaoConfig, ton: TonDia | undefined, nuvem: NuvemDia | undefined): DiaFonteCalc {
    const entrada = {
      config,
      kwhTon: ton?.kwh ?? null,
      tonCompleta: ton?.completa ?? false,
      kwhNuvem: nuvem?.kwhNuvem ?? null,
      nuvemCompleta: nuvem?.nuvemCompleta ?? false,
      kwhManual: nuvem?.kwhManual ?? null,
    };
    return {
      data: dia,
      ...escolherFonte(entrada),
      kwhTon: entrada.kwhTon,
      kwhNuvem: entrada.kwhNuvem,
      kwhManual: entrada.kwhManual,
      tonCompleta: entrada.tonCompleta,
      nuvemCompleta: entrada.nuvemCompleta,
    };
  }

  /**
   * Escolha de várias unidades em vários dias (COA, boletins). unidade → dia → escolha.
   * Dias depois de hoje ficam de fora. Cache de 60 s por conjunto de unidades e janela.
   */
  async porDias(unidadeIds: string[], diaIni: string, diaFim: string, agora = new Date()): Promise<Map<string, Map<string, DiaFonteCalc>>> {
    const ids = [...new Set(unidadeIds.map((i) => i.trim()).filter(Boolean))].sort();
    const out = new Map<string, Map<string, DiaFonteCalc>>();
    const hoje = diaLocal(agora);
    const fim = diaFim > hoje ? hoje : diaFim;
    if (!ids.length || diaIni > fim) return out;

    const chave = `${ids.join(',')}|${diaIni}|${fim}`;
    const c = this.cache.get(chave);
    if (c && agora.getTime() - c.ts < CACHE_MS && agora.getTime() >= c.ts) return c.valor;

    const [configs, inversores] = await Promise.all([this.configs(ids), this.inversoresPorUnidade(ids)]);
    const todos = [...inversores.values()].flat();
    const [ton, nuvem] = await Promise.all([
      this.tonPorInversorDia(todos, diaIni, fim, agora),
      this.nuvemPorDia(ids, diaIni, fim, agora, inversores),
    ]);
    const dias = diasEntre(diaIni, fim, SEM_LIMITE);
    for (const u of ids) {
      const invs = inversores.get(u) ?? [];
      const m = new Map<string, DiaFonteCalc>();
      for (const d of dias) {
        const leituras = invs.map((i) => ton.get(i)?.get(d)).filter((x): x is TonInversorDia => !!x);
        const tonDia = agregarTonDia(leituras, invs.length, blocosSolares(d, agora));
        m.set(d, this.montar(d, configs.get(u) ?? 'automatico', tonDia, nuvem.get(u)?.get(d)));
      }
      out.set(u, m);
    }

    if (this.cache.size > 100) this.cache.clear();
    this.cache.set(chave, { ts: agora.getTime(), valor: out });
    return out;
  }

  /**
   * Escolha de UMA unidade com a TON já calculada (a análise tira a TON do próprio cache
   * diário). `config` omitida = lê do banco.
   */
  async escolherComTon(
    unidadeId: string, inversorIds: string[], ton: Map<string, TonDia>, diaIni: string, diaFim: string,
    agora: Date, config?: FonteGeracaoConfig,
  ): Promise<Map<string, DiaFonteCalc>> {
    const uid = unidadeId.trim();
    const hoje = diaLocal(agora);
    const fim = diaFim > hoje ? hoje : diaFim;
    const out = new Map<string, DiaFonteCalc>();
    if (diaIni > fim) return out;
    const [cfg, nuvem] = await Promise.all([
      config ? Promise.resolve(config) : this.configs([uid]).then((m) => m.get(uid) ?? 'automatico'),
      this.nuvemPorDia([uid], diaIni, fim, agora, new Map([[uid, inversorIds]])),
    ]);
    const n = nuvem.get(uid);
    for (const d of diasEntre(diaIni, fim, SEM_LIMITE)) out.set(d, this.montar(d, cfg, ton.get(d), n?.get(d)));
    return out;
  }

  /** Integração de nuvem ativa (unidade_fv_config.ativo). */
  async temNuvem(unidadeId: string): Promise<boolean> {
    try {
      const r = await this.prisma.$queryRaw<Array<{ ok: boolean }>>`
        SELECT EXISTS (SELECT 1 FROM unidade_fv_config WHERE TRIM(unidade_id) = ${unidadeId.trim()} AND ativo = true) AS ok`;
      return r[0]?.ok === true;
    } catch (e) {
      this.logger.warn(`[fonte] unidade_fv_config falhou: ${(e as Error)?.message ?? e}`);
      return false;
    }
  }

  /** Primeiro dia (≥ 2020) com geração na nuvem ou manual. */
  async primeiroDiaNuvem(unidadeId: string): Promise<string | null> {
    const uid = unidadeId.trim();
    const r = await this.prisma.$queryRaw<Array<{ d: string | null }>>`
      SELECT to_char(LEAST(
        (SELECT MIN(data) FROM geracao_diaria_plantas
          WHERE TRIM(unidade_id) = ${uid} AND data >= '2020-01-01' AND COALESCE(kwh_realizado, 0) > 0),
        (SELECT MIN(hora)::date FROM geracao_horaria_plantas
          WHERE TRIM(unidade_id) = ${uid} AND hora >= '2020-01-01' AND COALESCE(kwh_acumulado, 0) > 0)
      ), 'YYYY-MM-DD') AS d`.catch(() => [] as Array<{ d: string | null }>);
    return r[0]?.d ?? null;
  }

  /**
   * Curva de 15 min do dia na nuvem. Horário: o snapshot das H h traz o kWh desde o anterior,
   * espalhado nos 4 blocos da hora que terminou (H−1 h). Sem horário (Fusion), a potência do
   * fallback gravado em equipamentos_dados. null = sem curva (a tela fica com a da TON).
   */
  async curvaNuvem(unidadeId: string, inversorIds: string[], dia: string): Promise<CurvaNuvem | null> {
    const uid = unidadeId.trim();
    const ini = inicioDoDiaUtc(dia).getTime();
    const horas = await this.prisma.$queryRaw<Array<{ h: number; kwh: number | null }>>`
      SELECT EXTRACT(HOUR FROM hora)::int AS h, SUM(kwh_hora)::float8 AS kwh
      FROM geracao_horaria_plantas
      WHERE TRIM(unidade_id) = ${uid} AND hora::date = ${dia}::date AND EXTRACT(HOUR FROM hora) > 5
        AND COALESCE(origem, 'nuvem') <> 'manual'
      GROUP BY 1`.catch((e) => this.falhou('curva horária', e));
    if (horas.length) {
      const kw = new Map<number, number>();
      for (const r of horas) {
        const v = Math.max(0, Number(r.kwh) || 0);
        for (let k = 0; k < 4; k++) kw.set(ini + (Number(r.h) - 1) * HORA_MS + k * BLOCO_MS, v);
      }
      return { origem: 'horaria', kw };
    }
    if (!inversorIds.length) return null;
    const fim = new Date(ini + 24 * HORA_MS);
    const blocos = await this.prisma.$queryRaw<Array<{ b: bigint | number; kw: number | null }>>`
      SELECT b, SUM(media)::float8 AS kw FROM (
        SELECT equipamento_id, (floor(extract(epoch FROM timestamp_dados) / 900) * 900)::bigint AS b,
               AVG(GREATEST(${POTENCIA_KW}, 0)) AS media
        FROM equipamentos_dados
        WHERE equipamento_id = ANY(${inversorIds}::bpchar[])
          AND timestamp_dados >= ${sqlUtc(new Date(ini))}::timestamp AND timestamp_dados < ${sqlUtc(fim)}::timestamp
          AND fonte = 'NUVEM_FUSION'
        GROUP BY 1, 2
      ) x GROUP BY b`.catch((e) => this.falhou('curva fusion', e));
    if (!blocos.length) return null;
    return { origem: 'fusion', kw: new Map(blocos.map((r) => [Number(r.b) * 1000, Number(r.kw) || 0] as [number, number])) };
  }

  /** Esquece o cache em memória (config da fonte mudou). */
  limpar(): void {
    this.cache.clear();
    this.cacheInversores.clear();
  }
}

