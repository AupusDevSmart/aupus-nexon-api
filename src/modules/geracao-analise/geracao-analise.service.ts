import { createHash } from 'crypto';
import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService, Prisma, PermissionScopeService, ScopedUser } from '@/core';
import {
  classificarIntervalo, energiaPrevista, fechamentoDoMes, InversorIntervalo, INTERVALO_H, INTERVALO_MS,
  outrasPerdas, pctEsperado, potenciaEsperadaKw, potenciaEstavel,
} from './geracao-calculo';
import {
  ANO_MINIMO_TOTAL, DIAS_SEMANA, diaLocal, diasEntre, diasNoMes, horaLocal, inicioDoDiaUtc, isoLocal, janelaDoPeriodo,
  MESES, Periodo, PERIODOS, somarDias, sqlUtc,
} from './geracao-datas';
import { ContextoUsina, GeracaoConfigService } from './geracao-config.service';
import { IrradianciaService } from './irradiancia/irradiancia.service';
import { ColunaOpcional, FILTRO_TON, POTENCIA_KW, sqlNum, YIELD_KWH, YIELD_MAX_KWH } from './geracao-sql';
import { DiaFonteCalc, FonteGeracaoService } from './fonte-geracao.service';
import {
  agregarTonDia, blocosSolares, DiaFonte, resumirFontes, SOLAR_FIM_H, SOLAR_INICIO_H, TonDia, TonInversorDia,
} from './geracao-fonte';

/** Leitura agregada de um inversor num intervalo de 15 min. */
interface BucketInversor {
  media: number;
  min: number | null;
  max: number | null;
  leituras: number;
  falha: boolean;
  desligado: boolean;
  limiteAtivo: boolean;
  /** MAX(daily_yield) válido no intervalo (kWh); null = sem daily_yield. */
  y: number | null;
  /** false = só linhas com daily_yield, sem potência: não entra na curva nem nas perdas. */
  temPotencia: boolean;
}

export interface Intervalo {
  inicio: number; // ms UTC
  realKw: number | null;
  esperadoKw: number | null;
  indisponibilidadeKw: number;
  limitacaoProjetoKw: number;
  limitacaoExternaKw: number;
}

export interface ResumoDia {
  dia: string;
  realKwh: number | null;
  esperadoKwh: number | null;
  realComEsperadoKwh: number;
  indisponibilidadeKwh: number;
  limitacaoProjetoKwh: number;
  limitacaoExternaKwh: number;
  intervalosComDado: number;
  intervalosComEsperado: number;
  /** kWh da TON no dia (Σ MAX(daily_yield) dos inversores, NEXON-37); null = sem leitura. */
  kwhTon: number | null;
  /** Todo inversor com leitura em ≥ 70% dos blocos solares. */
  tonCompleta: boolean;
}

/**
 * Hash do que muda o resultado de um dia: config mudou → o dia em cache não vale.
 * `versao` muda quando o cálculo do dia muda (NEXON-37: TON sem NUVEM_FUSION, inversor por
 * tópico e kWh da TON no cache). A fonte da geração NÃO entra: o cache só guarda a TON.
 */
export function hashConfig(ctx: ContextoUsina, versao = ''): string {
  const c = ctx.config;
  return createHash('sha1').update(JSON.stringify([
    c.fonte, c.kwpDc, ctx.potenciaAcKw, c.fatorDesempenho, c.inclinacaoGraus, c.azimuteGraus,
    c.solarimetroEquipamentoId, c.solarimetroMedicao, ctx.inversores.map((i) => [i.id, i.potenciaKw]),
    versao,
  ])).digest('hex');
}

/** Lacuna máxima (em intervalos) em que o último valor do inversor é repetido. */
const PREENCHER_ATE = 2;
/** Recalcula do zero dias recentes que ficaram sem esperado (satélite atrasado). */
const DIAS_REVALIDAR = 7;
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const rn = (v: number | null) => (v == null ? null : r2(v));
/** Período Total: anos de dias (diasEntre limita a ~1 ano por padrão). */
const SEM_LIMITE = 20_000;
/** Versão do cálculo do dia (entra no hash do cache). */
const VERSAO_CACHE = 'fonte-v1';

/** TON de cada dia a partir dos resumos (cache diário da análise). */
function tonDosResumos(resumos: Iterable<ResumoDia>): Map<string, TonDia> {
  const m = new Map<string, TonDia>();
  for (const r of resumos) m.set(r.dia, { kwh: r.kwhTon, completa: r.tonCompleta });
  return m;
}

@Injectable()
export class GeracaoAnaliseService {
  private readonly logger = new Logger(GeracaoAnaliseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: PermissionScopeService,
    private readonly configs: GeracaoConfigService,
    private readonly irradiancia: IrradianciaService,
    private readonly fontes: FonteGeracaoService,
  ) {}

  /** geracao_analise_diaria.kwh_ton/ton_completa (SQL 2026-10-21). */
  private readonly colunasTon = new ColunaOpcional(/kwh_ton|ton_completa/);
  /** O SQL 2026-10-21 entra antes do deploy: uma versão só (sem invalidação extra quando ele entra). */
  private versao(): string {
    return VERSAO_CACHE;
  }

  // ── Leitura dos inversores ────────────────────────────────────────────────

  /** Agrega as leituras dos inversores em intervalos de 15 min. eq → (início ms → bucket). */
  private async buckets(ids: string[], ini: Date, fim: Date): Promise<Map<string, Map<number, BucketInversor>>> {
    const out = new Map<string, Map<number, BucketInversor>>();
    if (!ids.length) return out;
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT TRIM(equipamento_id) AS eq, (floor(extract(epoch FROM timestamp_dados) / 900) * 900)::bigint AS b,
             AVG(CASE WHEN pv IS NOT NULL THEN GREATEST(pv, 0) END)::float8 AS media, MIN(pv)::float8 AS min, MAX(pv)::float8 AS max, COUNT(pv)::int AS n,
             bool_or(st ~* '(fault|falha|alarm|trip|erro)') AS falha,
             bool_or(st ~* '(stop|shutdown|deslig|emergenc|power ?off)') AS desligado,
             MIN(lim)::float8 AS lim,
             MAX(CASE WHEN y >= 0 AND y < ${YIELD_MAX_KWH} THEN y END)::float8 AS y
      FROM (
        SELECT equipamento_id, timestamp_dados,
               ${POTENCIA_KW} AS p, ${YIELD_KWH} AS y,
               COALESCE(dados->'status'->>'work_state_text', '') AS st,
               ${sqlNum("COALESCE(dados->'limits'->>'active_power_pct', dados->>'power_limit_pct', dados->'power'->>'limit_pct')")} AS lim
        FROM equipamentos_dados
        WHERE equipamento_id = ANY(${ids}::bpchar[])
          AND timestamp_dados >= ${sqlUtc(ini)}::timestamp AND timestamp_dados < ${sqlUtc(fim)}::timestamp
          AND ${FILTRO_TON}
      ) x
      CROSS JOIN LATERAL (SELECT CASE WHEN abs(p) < 1000000 THEN p END AS pv) v
      -- linha só com daily_yield (sem campo de potência) entra para o kWh da TON
      WHERE (p IS NOT NULL AND abs(p) < 1000000) OR y IS NOT NULL
      GROUP BY 1, 2`;
    for (const r of rows) {
      const m = out.get(r.eq) ?? new Map<number, BucketInversor>();
      m.set(Number(r.b) * 1000, {
        media: Number(r.media) || 0, min: r.min, max: r.max, leituras: Number(r.n) || 0,
        temPotencia: Number(r.n) > 0,
        falha: r.falha === true, desligado: r.desligado === true,
        limiteAtivo: r.lim != null && Number(r.lim) >= 0 && Number(r.lim) < 100,
        y: r.y == null ? null : Number(r.y),
      });
      out.set(r.eq, m);
    }
    return out;
  }

  /** Primeiro dia com leitura de algum inversor (evita calcular anos vazios). */
  private async primeiroDia(ids: string[]): Promise<string | null> {
    if (!ids.length) return null;
    const r = await this.prisma.$queryRaw<Array<{ m: string | null }>>`
      SELECT to_char(min(x.m), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS m
      FROM unnest(${ids}::bpchar[]) AS i(id)
      CROSS JOIN LATERAL (
        SELECT d.timestamp_dados AS m FROM equipamentos_dados d
        WHERE d.equipamento_id = i.id AND d.timestamp_dados >= '2020-01-01' -- relógio zerado manda 1970
        ORDER BY d.timestamp_dados LIMIT 1
      ) x`;
    return r[0]?.m ? diaLocal(new Date(r[0].m)) : null;
  }

  /** Potência atual (soma da última leitura de cada inversor nos últimos 15 min). */
  private async potenciaAgora(ids: string[], agora: Date): Promise<number | null> {
    if (!ids.length) return null;
    const desde = new Date(agora.getTime() - INTERVALO_MS);
    const r = await this.prisma.$queryRaw<Array<{ p: number | null; n: number }>>`
      SELECT SUM(GREATEST(x.p, 0))::float8 AS p, COUNT(x.p)::int AS n
      FROM unnest(${ids}::bpchar[]) AS i(id)
      CROSS JOIN LATERAL (
        SELECT ${POTENCIA_KW} AS p
        FROM equipamentos_dados
        WHERE equipamento_id = i.id AND timestamp_dados >= ${sqlUtc(desde)}::timestamp
        ORDER BY timestamp_dados DESC LIMIT 1
      ) x`;
    return r[0]?.n ? Number(r[0].p) || 0 : null;
  }

  // ── Cálculo por intervalo ─────────────────────────────────────────────────

  /**
   * Intervalos de 15 min entre dois dias locais (inclusive), até `agora`. Cada intervalo traz
   * real, esperado e a perda classificada (seção 4).
   */
  async intervalos(ctx: ContextoUsina, diaInicio: string, diaFim: string, agora: Date): Promise<Intervalo[]> {
    return (await this.calcular(ctx, diaInicio, diaFim, agora)).ints;
  }

  /** Intervalos + TON de cada dia (kWh por daily_yield e completude), numa leitura só. */
  async calcular(ctx: ContextoUsina, diaInicio: string, diaFim: string, agora: Date): Promise<{ ints: Intervalo[]; ton: Map<string, TonDia> }> {
    const ini = inicioDoDiaUtc(diaInicio);
    const fimDia = inicioDoDiaUtc(somarDias(diaFim, 1));
    const fim = new Date(Math.min(fimDia.getTime(), agora.getTime()));
    if (fim <= ini) return { ints: [], ton: new Map() };
    const ids = ctx.inversores.map((i) => i.id);
    const [porInversor, irr] = await Promise.all([
      this.buckets(ids, ini, fim),
      this.irradiancia.observada(ctx, diaInicio, diaFim, agora),
    ]);
    const { kwpDc, fatorDesempenho } = ctx.config;
    const comFonte = ctx.config.fonte !== 'nenhuma' && kwpDc != null;
    const ultimo = new Map<string, { b: BucketInversor; idx: number }>();
    const out: Intervalo[] = [];

    for (let t = ini.getTime(), idx = 0; t < fim.getTime(); t += INTERVALO_MS, idx++) {
      const estados: InversorIntervalo[] = [];
      let algumDado = false;
      for (const inv of ctx.inversores) {
        let b = porInversor.get(inv.id)?.get(t) ?? null;
        if (b && !b.temPotencia) b = null;
        let preenchido = false;
        if (b) ultimo.set(inv.id, { b, idx });
        else {
          const u = ultimo.get(inv.id);
          if (u && idx - u.idx <= PREENCHER_ATE) { b = u.b; preenchido = true; }
        }
        if (b) algumDado = true;
        estados.push({
          id: inv.id,
          potenciaNominalKw: inv.potenciaKw ?? 0,
          realKw: b ? b.media : null,
          falha: b?.falha ?? false,
          desligado: b?.desligado ?? false,
          limiteAtivo: b?.limiteAtivo ?? false,
          estavel: !!b && !preenchido && potenciaEstavel(b.min, b.max, b.media, b.leituras),
        });
      }
      const realKw = algumDado ? estados.reduce((s, e) => s + Math.max(e.realKw ?? 0, 0), 0) : null;
      const g = comFonte ? irr.get(t) : undefined;
      const esperadoKw = g != null ? potenciaEsperadaKw(kwpDc as number, g, fatorDesempenho) : null;
      const perdas = esperadoKw != null ? classificarIntervalo(esperadoKw, estados, ctx.potenciaAcKw ?? 0) : null;
      out.push({
        inicio: t, realKw, esperadoKw,
        indisponibilidadeKw: perdas?.indisponibilidadeKw ?? 0,
        limitacaoProjetoKw: perdas?.limitacaoProjetoKw ?? 0,
        limitacaoExternaKw: perdas?.limitacaoExternaKw ?? 0,
      });
    }
    return { ints: out, ton: this.tonDosBuckets(ctx, porInversor, diaInicio, diaFim, agora) };
  }

  /** TON por dia a partir dos buckets: Σ MAX(daily_yield) (ou integral) e cobertura solar. */
  private tonDosBuckets(
    ctx: ContextoUsina, porInversor: Map<string, Map<number, BucketInversor>>, diaInicio: string, diaFim: string, agora: Date,
  ): Map<string, TonDia> {
    const porDia = new Map<string, Map<string, TonInversorDia>>();
    for (const [eq, m] of porInversor) {
      for (const [t, b] of m) {
        const dia = diaLocal(new Date(t));
        const h = Math.floor((t - inicioDoDiaUtc(dia).getTime()) / 3_600_000);
        const doDia = porDia.get(dia) ?? new Map<string, TonInversorDia>();
        porDia.set(dia, doDia);
        const a = doDia.get(eq) ?? { yieldKwh: null, integralKwh: 0, blocosSolares: 0 };
        if (b.y != null && (a.yieldKwh == null || b.y > a.yieldKwh)) a.yieldKwh = b.y;
        if (b.temPotencia) a.integralKwh += b.media * INTERVALO_H;
        if (h >= SOLAR_INICIO_H && h < SOLAR_FIM_H) a.blocosSolares++;
        doDia.set(eq, a);
      }
    }
    const hoje = diaLocal(agora);
    const out = new Map<string, TonDia>();
    for (const d of diasEntre(diaInicio, diaFim > hoje ? hoje : diaFim, SEM_LIMITE)) {
      out.set(d, agregarTonDia([...(porDia.get(d)?.values() ?? [])], ctx.inversores.length, blocosSolares(d, agora)));
    }
    return out;
  }

  /** Soma os intervalos de um dia local num resumo (com a TON do dia, quando calculada). */
  resumir(dia: string, intervalos: Intervalo[], ton?: TonDia): ResumoDia {
    let real = 0, esperado = 0, realCom = 0, indisp = 0, projeto = 0, externa = 0, comDado = 0, comEsperado = 0;
    for (const i of intervalos) {
      if (i.realKw != null) { real += i.realKw * INTERVALO_H; comDado++; }
      if (i.esperadoKw != null) {
        comEsperado++;
        esperado += i.esperadoKw * INTERVALO_H;
        realCom += (i.realKw ?? 0) * INTERVALO_H;
        indisp += i.indisponibilidadeKw * INTERVALO_H;
        projeto += i.limitacaoProjetoKw * INTERVALO_H;
        externa += i.limitacaoExternaKw * INTERVALO_H;
      }
    }
    return {
      dia,
      realKwh: comDado ? real : null,
      esperadoKwh: comEsperado ? esperado : null,
      realComEsperadoKwh: realCom,
      indisponibilidadeKwh: indisp,
      limitacaoProjetoKwh: projeto,
      limitacaoExternaKwh: externa,
      intervalosComDado: comDado,
      intervalosComEsperado: comEsperado,
      kwhTon: ton ? ton.kwh : comDado ? real : null,
      tonCompleta: ton ? ton.completa : false,
    };
  }

  // ── Cache diário ──────────────────────────────────────────────────────────

  /** Resumo de cada dia pedido: dia passado vem do cache (ou é calculado e gravado); hoje é ao vivo. */
  async resumosDiarios(ctx: ContextoUsina, dias: string[], agora: Date, primeiro: string | null): Promise<Map<string, ResumoDia>> {
    const hoje = diaLocal(agora);
    const out = new Map<string, ResumoDia>();
    // Antes da primeira leitura (ou instalação que nunca mandou dado) não há o que calcular.
    const passados = primeiro ? dias.filter((d) => d < hoje && d >= primeiro) : [];
    if (passados.length) {
      const cache = await this.lerCache(ctx, passados);
      const limiteRevalidar = somarDias(hoje, -DIAS_REVALIDAR);
      const hash = hashConfig(ctx, this.versao());
      const faltando = passados.filter((d) => {
        const c = cache.get(d);
        if (!c || c.hash !== hash) return true;
        if (d < limiteRevalidar || !this.podeRevalidar(ctx.unidade.id, d)) return false;
        // Dias recentes: satélite incompleto, ou calculado cedo demais (leituras reenviadas depois).
        const incompleto = ctx.config.fonte !== 'nenhuma' && c.resumo.intervalosComEsperado < 90;
        const cedo = c.calculadoEm < inicioDoDiaUtc(somarDias(d, 1)).getTime() + 6 * 3_600_000;
        return incompleto || cedo;
      });
      for (const [d, c] of cache) if (!faltando.includes(d)) out.set(d, c.resumo);
      // Satélite primeiro, num pedido só para o intervalo todo; depois os blocos em paralelo.
      if (faltando.length && ctx.config.fonte === 'satelite') {
        await this.irradiancia.observada(ctx, faltando[0], faltando[faltando.length - 1], agora);
      }
      const blocos = blocosContiguos(faltando, 31);
      for (let i = 0; i < blocos.length; i += 4) {
        await Promise.all(blocos.slice(i, i + 4).map(async (bloco) => {
          const { ints, ton } = await this.calcular(ctx, bloco[0], bloco[bloco.length - 1], agora);
          const resumos = bloco.map((d) => this.resumir(d, doDia(ints, d), ton.get(d)));
          await this.gravarCache(ctx, resumos);
          for (const r of resumos) out.set(r.dia, r);
        }));
      }
    }
    if (dias.includes(hoje)) {
      const { ints, ton } = await this.calcular(ctx, hoje, hoje, agora);
      out.set(hoje, this.resumir(hoje, ints, ton.get(hoje)));
    }
    return out;
  }

  /** Revalidação de dia recente no máximo a cada 30 min (unidade fora da cobertura do satélite). */
  private readonly revalidados = new Map<string, number>();
  private podeRevalidar(unidadeId: string, dia: string): boolean {
    const k = `${unidadeId}:${dia}`;
    if (Date.now() - (this.revalidados.get(k) ?? 0) < 30 * 60_000) return false;
    this.revalidados.set(k, Date.now());
    return true;
  }

  private async lerCache(ctx: ContextoUsina, dias: string[]): Promise<Map<string, { hash: string | null; calculadoEm: number; resumo: ResumoDia }>> {
    const comTon = this.colunasTon.disponivel();
    let rows: any[] | null = null;
    if (comTon) {
      try {
        rows = await this.prisma.$queryRaw<any[]>`
          SELECT to_char(dia, 'YYYY-MM-DD') AS dia, real_kwh::float8 AS real, esperado_kwh::float8 AS esperado,
                 COALESCE(real_com_esperado_kwh, 0)::float8 AS real_com, indisponibilidade_kwh::float8 AS indisp,
                 limitacao_projeto_kwh::float8 AS projeto, limitacao_externa_kwh::float8 AS externa,
                 intervalos_com_dado AS n, intervalos_com_esperado AS ne, config_hash,
                 to_char(calculado_em, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS calculado_em,
                 kwh_ton::float8 AS kwh_ton, ton_completa
          FROM geracao_analise_diaria
          WHERE unidade_id = ${ctx.unidade.id} AND dia = ANY(${dias}::date[])`;
      } catch (e) {
        if (!this.colunasTon.ausente(e)) throw e;
        this.logger.warn('[analise] colunas kwh_ton/ton_completa ausentes (SQL 2026-10-21 não aplicado): TON pela integral');
      }
    }
    // Sem as colunas (SQL não aplicado): kWh da TON = integral da potência; completa ≈ 70% de 48 blocos.
    const semTon = rows == null;
    rows ??= await this.prisma.$queryRaw<any[]>`
      SELECT to_char(dia, 'YYYY-MM-DD') AS dia, real_kwh::float8 AS real, esperado_kwh::float8 AS esperado,
             COALESCE(real_com_esperado_kwh, 0)::float8 AS real_com, indisponibilidade_kwh::float8 AS indisp,
             limitacao_projeto_kwh::float8 AS projeto, limitacao_externa_kwh::float8 AS externa,
             intervalos_com_dado AS n, intervalos_com_esperado AS ne, config_hash,
             to_char(calculado_em, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS calculado_em
      FROM geracao_analise_diaria
      WHERE unidade_id = ${ctx.unidade.id} AND dia = ANY(${dias}::date[])`;
    return new Map(rows.map((r) => [r.dia, {
      hash: r.config_hash ?? null,
      calculadoEm: Date.parse(r.calculado_em),
      resumo: {
        dia: r.dia, realKwh: r.real, esperadoKwh: r.esperado, realComEsperadoKwh: r.real_com,
        indisponibilidadeKwh: r.indisp, limitacaoProjetoKwh: r.projeto, limitacaoExternaKwh: r.externa,
        intervalosComDado: Number(r.n) || 0, intervalosComEsperado: Number(r.ne) || 0,
        kwhTon: semTon ? (r.real ?? null) : (r.kwh_ton ?? null),
        tonCompleta: semTon ? (Number(r.n) || 0) >= 34 : r.ton_completa === true,
      },
    }]));
  }

  private async gravarCache(ctx: ContextoUsina, resumos: ResumoDia[]): Promise<void> {
    if (!resumos.length) return;
    const comTon = this.colunasTon.disponivel();
    const hash = hashConfig(ctx, this.versao());
    const values = resumos.map((r) => Prisma.sql`(${ctx.unidade.id}, ${r.dia}::date, ${rn(r.realKwh)}, ${rn(r.esperadoKwh)},
      ${r2(r.realComEsperadoKwh)}, ${r2(r.indisponibilidadeKwh)}, ${r2(r.limitacaoProjetoKwh)}, ${r2(r.limitacaoExternaKwh)},
      ${r.intervalosComDado}, ${r.intervalosComEsperado}, ${ctx.config.fonte}, ${hash}, now()
      ${comTon ? Prisma.sql`, ${rn(r.kwhTon)}, ${r.tonCompleta}` : Prisma.empty})`);
    try {
      await this.prisma.$executeRaw(Prisma.sql`
        INSERT INTO geracao_analise_diaria (unidade_id, dia, real_kwh, esperado_kwh, real_com_esperado_kwh,
          indisponibilidade_kwh, limitacao_projeto_kwh, limitacao_externa_kwh, intervalos_com_dado,
          intervalos_com_esperado, fonte, config_hash, calculado_em
          ${comTon ? Prisma.sql`, kwh_ton, ton_completa` : Prisma.empty})
        VALUES ${Prisma.join(values)}
        ON CONFLICT (unidade_id, dia) DO UPDATE SET
          real_kwh = EXCLUDED.real_kwh, esperado_kwh = EXCLUDED.esperado_kwh,
          real_com_esperado_kwh = EXCLUDED.real_com_esperado_kwh,
          indisponibilidade_kwh = EXCLUDED.indisponibilidade_kwh, limitacao_projeto_kwh = EXCLUDED.limitacao_projeto_kwh,
          limitacao_externa_kwh = EXCLUDED.limitacao_externa_kwh, intervalos_com_dado = EXCLUDED.intervalos_com_dado,
          intervalos_com_esperado = EXCLUDED.intervalos_com_esperado, fonte = EXCLUDED.fonte,
          ${comTon ? Prisma.sql`kwh_ton = EXCLUDED.kwh_ton, ton_completa = EXCLUDED.ton_completa,` : Prisma.empty}
          config_hash = EXCLUDED.config_hash, calculado_em = now()`);
    } catch (e) {
      if (!comTon || !this.colunasTon.ausente(e)) throw e;
      // Coluna sumiu entre a leitura e a gravação: grava sem ela (hash da versão sem TON).
      await this.gravarCache(ctx, resumos);
    }
  }

  /** Recalcula e grava um dia passado (job das 06h). Devolve os intervalos para os eventos. */
  async recalcularDia(ctx: ContextoUsina, dia: string, agora: Date): Promise<Intervalo[]> {
    const { ints, ton } = await this.calcular(ctx, dia, dia, agora);
    await this.gravarCache(ctx, [this.resumir(dia, ints, ton.get(dia))]);
    return ints;
  }

  /** Aquece o cache dos últimos `dias` dias (job das 06h e depois de mudar a config). */
  async aquecer(ctx: ContextoUsina, dias: number, agora = new Date()): Promise<void> {
    const ids = ctx.inversores.map((i) => i.id);
    if (!ids.length) return;
    const hoje = diaLocal(agora);
    const lista = diasEntre(somarDias(hoje, -dias), somarDias(hoje, -1));
    await this.resumosDiarios(ctx, lista, agora, await this.primeiroDia(ids));
  }

  async limparCache(unidadeId: string): Promise<void> {
    await this.prisma.$executeRaw`DELETE FROM geracao_analise_diaria WHERE unidade_id = ${unidadeId.trim()}`;
  }

  // ── Resposta da tela ──────────────────────────────────────────────────────

  async analise(unidadeId: string, periodoQ: string | undefined, dataQ: string | undefined, user?: ScopedUser, agora = new Date()) {
    const uid = (unidadeId ?? '').trim();
    if (!uid) throw new BadRequestException('unidadeId obrigatório');
    if (user) await this.scope.assertEntityInScope('unidade', uid, user);
    // PER-40: operador só com "Ver geração" na instalação; 403 sem dar pista.
    if (user && !(await this.scope.podeVerGeracao(uid, user))) {
      throw new ForbiddenException('Recurso fora do escopo do usuario');
    }
    const periodo: Periodo = PERIODOS.includes(periodoQ as Periodo) ? (periodoQ as Periodo) : 'dia';
    const hoje = diaLocal(agora);
    // Data real (somarDias normaliza 2026-02-31 → 03-03) e de 2000 em diante.
    if (dataQ && (!/^\d{4}-\d{2}-\d{2}$/.test(dataQ) || somarDias(dataQ, 0) !== dataQ || dataQ < '2000-01-01')) {
      throw new BadRequestException('data deve ser um dia válido no formato YYYY-MM-DD');
    }
    const referencia = dataQ && dataQ <= hoje ? dataQ : hoje;
    let janela = janelaDoPeriodo(periodo, referencia, hoje);

    const ctx = await this.configs.contexto(uid);
    const ids = ctx.inversores.map((i) => i.id);
    const comFonte = ctx.config.fonte !== 'nenhuma';
    const tarifa = ctx.config.exibirRs ? ctx.tarifaRsKwh : null;
    const rs = (kwh: number | null) => (tarifa != null && kwh != null ? r2(kwh * tarifa) : null);

    const [primeiro, primeiroNuvem, temNuvem] = await Promise.all([
      this.primeiroDia(ids),
      // Só o Total precisa do primeiro dia da nuvem (começa no primeiro ano com dado em qualquer fonte).
      periodo === 'total' ? this.fontes.primeiroDiaNuvem(uid) : Promise.resolve(null),
      this.fontes.temNuvem(uid),
    ]);
    if (periodo === 'total') {
      const primeiroGeral = [primeiro, primeiroNuvem].filter((d): d is string => !!d).sort()[0] ?? null;
      const anoIni = Math.max(ANO_MINIMO_TOTAL, Number((primeiroGeral ?? hoje).slice(0, 4)));
      janela = { ...janela, inicio: `${Math.min(anoIni, Number(hoje.slice(0, 4)))}-01-01` };
    }

    const base = {
      unidade_id: ctx.unidade.id,
      unidade_nome: ctx.unidade.nome,
      periodo,
      referencia,
      inicio: janela.inicio,
      fim: janela.fim,
      anterior: janela.anterior,
      proximo: janela.proximo,
      hoje,
      config: {
        fonte: ctx.config.fonte,
        kwp_dc: ctx.config.kwpDc,
        potencia_ac_kw: ctx.potenciaAcKw,
        exibir_rs: ctx.config.exibirRs,
        tarifa_rs_kwh: tarifa != null ? Math.round(tarifa * 10000) / 10000 : null,
        fonte_geracao: ctx.config.fonteGeracao,
      },
      tem_inversor: ids.length > 0,
    };
    if (!ids.length || !primeiro) {
      // Sem inversor ou inversor que nunca mandou leitura: a tela mostra o gráfico antigo.
      return {
        ...base, tem_dados: false, agora: null, pontos: [], resumo: null, perdas: null, fechamento: null, previsao_amanha: null,
        fonte_geracao: {
          config: ctx.config.fonteGeracao, escolhida: null, divergem: false, selo: null, tem_nuvem: temNuvem,
          kwh_ton: null, kwh_nuvem: null,
        },
      };
    }

    let pontos: any[];
    let resumos: ResumoDia[];
    let ints: Intervalo[] = [];
    if (periodo === 'dia') {
      const calc = await this.calcular(ctx, referencia, referencia, agora);
      ints = calc.ints;
      resumos = [this.resumir(referencia, calc.ints, calc.ton.get(referencia))];
      if (referencia < hoje) await this.gravarCache(ctx, resumos).catch(() => undefined);
    } else {
      const dias = diasEntre(janela.inicio, janela.fim, SEM_LIMITE);
      const mapa = await this.resumosDiarios(ctx, dias, agora, primeiro);
      resumos = dias.map((d) => mapa.get(d)).filter((r): r is ResumoDia => !!r);
    }
    // Fonte de cada dia (TON do cache × nuvem ao vivo: a escolha nunca fica congelada no cache).
    const escolhas = await this.fontes.escolherComTon(
      uid, ids, tonDosResumos(resumos), janela.inicio, janela.fim, agora, ctx.config.fonteGeracao,
    );
    const diasFonte = [...escolhas.values()];
    const resumoPorDia = new Map(resumos.map((r) => [r.dia, r]));
    const kwhPonto = (dias: DiaFonte[]) => {
      const f = resumirFontes(dias);
      return { real: rn(f.kwh), fonte: f.escolhida, kwh_ton: rn(f.kwhTon), kwh_nuvem: rn(f.kwhNuvem), divergem: f.divergem };
    };

    if (periodo === 'dia') {
      const esc = escolhas.get(referencia);
      // Nuvem escolhida: a curva sai do horário da nuvem (ou do fallback Fusion); sem curva, fica a da TON.
      const curva = esc?.fonte === 'nuvem' ? await this.fontes.curvaNuvem(uid, ids, referencia) : null;
      const inicioDia = inicioDoDiaUtc(referencia).getTime();
      const porInicio = new Map(ints.map((i) => [i.inicio, i]));
      pontos = Array.from({ length: 96 }, (_, k) => {
        const t = inicioDia + k * INTERVALO_MS;
        const i = porInicio.get(t);
        const futuro = t > agora.getTime();
        let realKw = i?.realKw ?? null;
        if (curva) {
          realKw = curva.kw.get(t) ?? null;
          // Madrugada sem snapshot no horário = sem sol (o horário só vale das 06h em diante).
          if (realKw == null && curva.origem === 'horaria' && !futuro && k < 5 * 4) realKw = 0;
        }
        return {
          rotulo: horaLocal(new Date(t)),
          data: referencia,
          inicio: isoLocal(new Date(t)),
          real_kw: realKw != null ? r2(realKw) : null,
          esperado_kw: i?.esperadoKw != null ? r2(i.esperadoKw) : null,
          real_kwh: realKw != null ? r2(realKw * INTERVALO_H) : null,
          esperado_kwh: i?.esperadoKw != null ? r2(i.esperadoKw * INTERVALO_H) : null,
          sem_dados: realKw == null,
          futuro,
          fonte: curva ? 'nuvem' : 'ton',
        };
      });
    } else if (periodo === 'ano' || periodo === 'total') {
      const grupos = periodo === 'ano'
        ? MESES.map((rot, m) => ({ rotulo: rot, prefixo: `${janela.inicio.slice(0, 4)}-${String(m + 1).padStart(2, '0')}` }))
        : Array.from({ length: Number(hoje.slice(0, 4)) - Number(janela.inicio.slice(0, 4)) + 1 }, (_, k) => {
            const ano = String(Number(janela.inicio.slice(0, 4)) + k);
            return { rotulo: ano, prefixo: ano };
          });
      pontos = grupos.map(({ rotulo, prefixo }) => {
        const data = prefixo.length === 4 ? `${prefixo}-01-01` : `${prefixo}-01`;
        const doGrupo = resumos.filter((r) => r.dia.startsWith(prefixo));
        const comEsp = doGrupo.filter((r) => r.esperadoKwh != null);
        const k = kwhPonto(diasFonte.filter((d) => d.data.startsWith(prefixo)));
        return {
          rotulo,
          data,
          real_kwh: k.real,
          esperado_kwh: comFonte && comEsp.length ? r2(comEsp.reduce((s, r) => s + (r.esperadoKwh as number), 0)) : null,
          sem_dados: k.real == null && data <= hoje,
          futuro: data > hoje,
          fonte: k.fonte,
          kwh_ton: k.kwh_ton,
          kwh_nuvem: k.kwh_nuvem,
          divergem: k.divergem,
        };
      });
    } else {
      pontos = diasEntre(janela.inicio, janela.fim).map((d) => {
        const r = resumoPorDia.get(d);
        const f = escolhas.get(d);
        return {
          rotulo: periodo === 'semana' ? `${DIAS_SEMANA[diasEntre(janela.inicio, d).length - 1]} ${d.slice(8, 10)}` : d.slice(8, 10),
          data: d,
          real_kwh: f?.kwh != null ? r2(f.kwh) : null,
          // Hoje o satélite está ~2 h atrás do real: o marcador parcial enganaria na barra.
          esperado_kwh: comFonte && d < hoje && r?.esperadoKwh != null ? r2(r.esperadoKwh) : null,
          sem_dados: d <= hoje && f?.kwh == null,
          futuro: d > hoje,
          fonte: f?.fonte ?? null,
          kwh_ton: rn(f?.kwhTon ?? null),
          kwh_nuvem: rn(f?.kwhNuvem ?? null),
          divergem: f?.motivo === 'divergem',
        };
      });
    }

    // Resumo: energia = kWh da fonte escolhida; esperado e perdas seguem pelos intervalos da TON.
    const energia = diasFonte.reduce((s, d) => s + (d.kwh ?? 0), 0);
    const comEsperado = resumos.filter((r) => r.esperadoKwh != null);
    const esperado = comFonte && comEsperado.length ? comEsperado.reduce((s, r) => s + (r.esperadoKwh as number), 0) : null;
    const realCom = comEsperado.reduce((s, r) => s + r.realComEsperadoKwh, 0);
    const kwp = ctx.config.kwpDc;
    const diasNoPeriodo = periodo === 'dia' ? 1 : diasEntre(janela.inicio, janela.fim > hoje ? hoje : janela.fim, SEM_LIMITE).length;
    const resumo = {
      energia_kwh: r2(energia),
      kwh_kwp: kwp ? r2(energia / kwp) : null,
      esperado_kwh: rn(esperado),
      pct_esperado: esperado != null ? rn(pctEsperado(realCom, esperado)) : null,
      valor_rs: rs(energia),
      dias_com_dados: diasFonte.filter((d) => d.kwh != null).length,
      dias_no_periodo: diasNoPeriodo,
    };

    let perdas: any = null;
    if (comFonte && esperado != null) {
      const t = {
        esperadoKwh: esperado,
        realKwh: realCom,
        indisponibilidadeKwh: comEsperado.reduce((s, r) => s + r.indisponibilidadeKwh, 0),
        limitacaoProjetoKwh: comEsperado.reduce((s, r) => s + r.limitacaoProjetoKwh, 0),
        limitacaoExternaKwh: comEsperado.reduce((s, r) => s + r.limitacaoExternaKwh, 0),
      };
      const outras = outrasPerdas(t);
      const cat = (chave: string, rotulo: string, kwh: number, informativo = false) => ({
        chave, rotulo, kwh: r2(kwh), pct: esperado > 0 ? r1((kwh / esperado) * 100) : 0, valor_rs: rs(kwh), informativo,
      });
      perdas = {
        esperado_kwh: r2(esperado),
        real_kwh: r2(realCom),
        categorias: [
          cat('indisponibilidade', 'Indisponibilidade', t.indisponibilidadeKwh),
          cat('limitacao_projeto', 'Limitação de projeto', t.limitacaoProjetoKwh, true),
          cat('limitacao_externa', 'Limitação externa', t.limitacaoExternaKwh),
          cat('outras', 'Outras perdas', outras),
        ],
      };
    }

    const rf = resumirFontes(diasFonte);
    const fonteGeracao = {
      config: ctx.config.fonteGeracao,
      escolhida: rf.escolhida,
      divergem: rf.divergem,
      selo: rf.selo,
      tem_nuvem: temNuvem,
      kwh_ton: rn(rf.kwhTon),
      kwh_nuvem: rn(rf.kwhNuvem),
      // Dia: 1 item; Semana/Mês: 1 por dia até hoje; Ano/Total: por ponto.
      ...(periodo === 'dia' || periodo === 'semana' || periodo === 'mes'
        ? {
            dias: diasFonte.map((d) => ({
              data: d.data, kwh: rn(d.kwh), kwh_ton: rn(d.kwhTon), kwh_nuvem: rn(d.kwhNuvem), kwh_manual: rn(d.kwhManual),
              fonte: d.fonte, motivo: d.motivo, divergencia_pct: d.divergenciaPct,
            })),
          }
        : {}),
    };

    const [fechamento, previsao, potAgora] = await Promise.all([
      this.fechamento(ctx, agora, primeiro, rs),
      comFonte ? this.previsaoAmanha(ctx, agora, rs) : Promise.resolve(null),
      periodo === 'dia' && referencia === hoje ? this.potenciaAgora(ids, agora) : Promise.resolve(null),
    ]);
    const limiarGerando = Math.max(0.5, (ctx.potenciaAcKw ?? 0) * 0.005);
    const agoraResp = periodo === 'dia' && referencia === hoje
      ? { potencia_kw: potAgora != null ? r2(potAgora) : null, gerando: (potAgora ?? 0) > limiarGerando }
      : null;

    return {
      ...base, tem_dados: true, agora: agoraResp, pontos, resumo, perdas, fechamento, previsao_amanha: previsao,
      fonte_geracao: fonteGeracao,
    };
  }

  /**
   * Fonte e kWh escolhido de cada dia pedido (NEXON-37): TON do cache diário da análise ×
   * nuvem ao vivo. Dias depois de hoje ficam de fora.
   */
  private async escolhasDosDias(ctx: ContextoUsina, dias: string[], agora: Date, primeiro: string | null): Promise<Map<string, DiaFonteCalc>> {
    if (!dias.length) return new Map();
    const ordenados = [...dias].sort();
    const ids = ctx.inversores.map((i) => i.id);
    const resumos = ids.length && primeiro ? await this.resumosDiarios(ctx, ordenados, agora, primeiro) : new Map<string, ResumoDia>();
    const todos = await this.fontes.escolherComTon(
      ctx.unidade.id, ids, tonDosResumos(resumos.values()), ordenados[0], ordenados[ordenados.length - 1], agora, ctx.config.fonteGeracao,
    );
    const pedidos = new Set(dias);
    return new Map([...todos].filter(([d]) => pedidos.has(d)));
  }

  /**
   * Geração de cada dia pela fonte escolhida (boletim semanal e quem mais precisar do mesmo
   * número da análise). Unidade sem inversor: só nuvem/manual.
   */
  async geracaoEscolhida(unidadeId: string, diaIni: string, diaFim: string, agora = new Date()): Promise<Map<string, DiaFonteCalc>> {
    const ctx = await this.configs.contexto(unidadeId.trim());
    const hoje = diaLocal(agora);
    const fim = diaFim > hoje ? hoje : diaFim;
    if (diaIni > fim) return new Map();
    const primeiro = await this.primeiroDia(ctx.inversores.map((i) => i.id));
    return this.escolhasDosDias(ctx, diasEntre(diaIni, fim, SEM_LIMITE), agora, primeiro);
  }

  /** Fechamento do mês corrente (GER-26..29), sem meta (GER-30), pelo kWh da fonte escolhida. */
  private async fechamento(ctx: ContextoUsina, agora: Date, primeiro: string | null, rs: (k: number | null) => number | null) {
    const hoje = diaLocal(agora);
    const [a, m, d] = hoje.split('-').map(Number);
    const nDias = diasNoMes(a, m);
    const mes = hoje.slice(0, 7);
    const completos = d > 1 ? diasEntre(`${mes}-01`, somarDias(hoje, -1)) : [];
    const mapa = await this.escolhasDosDias(ctx, completos, agora, primeiro);

    // Média do mesmo mês nos anos anteriores (só anos com leitura da TON), pelo kWh escolhido.
    let mediaHistorica: number | null = null;
    if (primeiro) {
      const diasHist: string[] = [];
      for (let ano = a - 1; ano >= Number(primeiro.slice(0, 4)); ano--) {
        const ini = `${ano}-${String(m).padStart(2, '0')}-01`;
        const fim = `${ano}-${String(m).padStart(2, '0')}-${String(diasNoMes(ano, m)).padStart(2, '0')}`;
        if (fim < primeiro) break;
        diasHist.push(...diasEntre(ini < primeiro ? primeiro : ini, fim));
      }
      if (diasHist.length) {
        const hist = await this.escolhasDosDias(ctx, diasHist, agora, primeiro);
        const vals = [...hist.values()].map((r) => r.kwh).filter((v): v is number => v != null);
        // Exige um mês com cobertura razoável (≥ 20 dias) para valer como histórico.
        if (vals.length >= 20) mediaHistorica = vals.reduce((s, v) => s + v, 0) / vals.length;
      }
    }

    const f = fechamentoDoMes({
      diasCompletos: completos.map((dd) => mapa.get(dd)?.kwh ?? null),
      diasDoMes: nDias,
      diaHoje: d,
      mediaHistorica,
    });
    return {
      mes,
      disponivel: f.disponivel,
      motivo: f.motivo,
      acumulado_kwh: r2(f.acumuladoKwh),
      estimativa_kwh: rn(f.estimativaKwh),
      faixa_kwh: rn(f.faixaKwh),
      valor_rs: rs(f.estimativaKwh),
      dias_decorridos: f.diasDecorridos,
      dias_do_mes: nDias,
      usa_historico: f.usaHistorico,
    };
  }

  /** Previsão de amanhã (GER-31): Σ P_esperada prevista, limitada à potência AC. */
  private async previsaoAmanha(ctx: ContextoUsina, agora: Date, rs: (k: number | null) => number | null) {
    if (ctx.config.kwpDc == null) return null;
    const amanha = somarDias(diaLocal(agora), 1);
    const irr = await this.irradiancia.prevista(ctx, amanha);
    if (irr.size < 80) return null;
    const esperados = [...irr.values()].map((g) => potenciaEsperadaKw(ctx.config.kwpDc as number, g, ctx.config.fatorDesempenho));
    const kwh = energiaPrevista(esperados, ctx.potenciaAcKw);
    return { data: amanha, energia_kwh: r2(kwh), valor_rs: rs(kwh), fonte: ctx.config.fonte };
  }

  // ── Eventos de limitação externa (GER-18) ────────────────────────────────

  /** Agrupa intervalos seguidos com limitação externa e grava um evento por janela no Registro. */
  async registrarLimitacoesExternas(ctx: ContextoUsina, ints: Intervalo[]): Promise<number> {
    const eq = ctx.inversores[0];
    if (!eq) return 0;
    const janelas: Array<{ ini: number; fim: number; kwh: number }> = [];
    for (const i of ints) {
      if (!(i.limitacaoExternaKw > 0)) continue;
      const ult = janelas[janelas.length - 1];
      if (ult && ult.fim === i.inicio) { ult.fim = i.inicio + INTERVALO_MS; ult.kwh += i.limitacaoExternaKw * INTERVALO_H; }
      else janelas.push({ ini: i.inicio, fim: i.inicio + INTERVALO_MS, kwh: i.limitacaoExternaKw * INTERVALO_H });
    }
    let n = 0;
    for (const j of janelas.filter((x) => x.kwh >= 1)) {
      const ini = new Date(j.ini);
      const ja = await this.prisma.$queryRaw<any[]>`
        SELECT 1 FROM geracao_limitacao_eventos WHERE unidade_id = ${ctx.unidade.id} AND inicio = ${sqlUtc(ini)}::timestamp`;
      if (ja.length) continue;
      const kwh = r1(j.kwh).toLocaleString('pt-BR');
      const mensagem = `Limitação externa: ${kwh} kWh entre ${horaLocal(ini)} e ${horaLocal(new Date(j.fim))} (${diaLocal(ini).split('-').reverse().join('/')})`;
      // 'comando' informativo (não 'alerta'): entra no Registro sem virar alarme ativo nem push.
      const log = await this.prisma.logs_mqtt.create({
        data: {
          tipo: 'comando', equipamento_id: eq.id, severidade: 'WARN', status: 'registrado',
          mensagem, comando_semantico: 'geracao.limitacao_externa',
        },
      });
      await this.prisma.$executeRaw`
        INSERT INTO geracao_limitacao_eventos (unidade_id, inicio, fim, kwh, log_id)
        VALUES (${ctx.unidade.id}, ${sqlUtc(ini)}::timestamp, ${sqlUtc(new Date(j.fim))}::timestamp, ${r2(j.kwh)}, ${log.id.trim()})
        ON CONFLICT DO NOTHING`;
      n++;
    }
    return n;
  }
}

function doDia(ints: Intervalo[], dia: string): Intervalo[] {
  const ini = inicioDoDiaUtc(dia).getTime();
  const fim = inicioDoDiaUtc(somarDias(dia, 1)).getTime();
  return ints.filter((i) => i.inicio >= ini && i.inicio < fim);
}

/** Quebra uma lista ordenada de dias em blocos contíguos de até `max` dias. */
export function blocosContiguos(dias: string[], max: number): string[][] {
  const out: string[][] = [];
  for (const d of [...dias].sort()) {
    const ult = out[out.length - 1];
    if (ult && ult.length < max && somarDias(ult[ult.length - 1], 1) === d) ult.push(d);
    else out.push([d]);
  }
  return out;
}
