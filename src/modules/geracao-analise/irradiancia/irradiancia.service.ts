import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService, Prisma } from '@/core';
import { ghiParaPoa, INTERVALO_MS } from '../geracao-calculo';
import { diaLocal, diasEntre, inicioDoDiaUtc, somarDias, sqlUtc } from '../geracao-datas';
import type { ContextoUsina } from '../geracao-config.service';
import { sqlNum } from '../geracao-sql';
import { IRRADIANCE_PROVIDER, IrradianceProvider, LocalUsina, PontoIrradiancia } from './irradiance-provider';

/**
 * Irradiância por instalação em intervalos de 15 min (início do intervalo, UTC).
 * - satélite: cache em `irradiancia_15min` (tipo observado), completado sob demanda pelo provedor;
 * - solarímetro: lido de `equipamentos_dados` do equipamento vinculado (GHI vira POA);
 * - previsão: `irradiancia_15min` tipo previsto (job das 18h; sob demanda se faltar).
 */
@Injectable()
export class IrradianciaService {
  private readonly logger = new Logger(IrradianciaService.name);
  /** Última tentativa sob demanda por unidade+tipo — não martela o provedor a cada tela aberta. */
  private readonly tentativas = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(IRRADIANCE_PROVIDER) private readonly provider: IrradianceProvider,
  ) {}

  /** Inclinação|azimute: irradiância no plano dos módulos de outra geometria não serve. */
  private geometria(ctx: ContextoUsina): string {
    return `${ctx.config.inclinacaoGraus}|${ctx.config.azimuteGraus}`;
  }

  local(ctx: ContextoUsina): LocalUsina {
    return {
      latitude: ctx.unidade.latitude,
      longitude: ctx.unidade.longitude,
      inclinacaoGraus: ctx.config.inclinacaoGraus,
      azimuteGraus: ctx.config.azimuteGraus,
    };
  }

  /** Irradiância observada entre dois dias locais (inclusive). Map: início do intervalo (ms) → W/m². */
  async observada(ctx: ContextoUsina, diaInicio: string, diaFim: string, agora = new Date()): Promise<Map<number, number>> {
    if (ctx.config.fonte === 'solarimetro') return this.doSolarimetro(ctx, diaInicio, diaFim);
    if (ctx.config.fonte !== 'satelite') return new Map();
    await this.completarSatelite(ctx, diaInicio, diaFim, agora).catch(() => undefined);
    return this.lerCache(ctx, 'observado', inicioDoDiaUtc(diaInicio), inicioDoDiaUtc(somarDias(diaFim, 1)));
  }

  /** Previsão de um dia local (sob demanda se o job ainda não gravou). */
  async prevista(ctx: ContextoUsina, dia: string): Promise<Map<number, number>> {
    if (ctx.config.fonte === 'nenhuma') return new Map();
    const ini = inicioDoDiaUtc(dia);
    const fim = inicioDoDiaUtc(somarDias(dia, 1));
    let m = await this.lerCache(ctx, 'previsto', ini, fim);
    if (m.size < 80 && this.podeTentar(`${ctx.unidade.id}:previsto`, 30)) {
      await this.atualizarPrevisao(ctx).catch(() => undefined);
      m = await this.lerCache(ctx, 'previsto', ini, fim);
    }
    return m;
  }

  /** Busca e grava a previsão dos próximos 2 dias (job das 18h). */
  async atualizarPrevisao(ctx: ContextoUsina): Promise<number> {
    const pontos = await this.provider.prevista(this.local(ctx), 3);
    return this.gravar(ctx, 'previsto', 'satelite', pontos);
  }

  /** Rebusca no provedor a irradiância observada entre dois dias (jobs hora a hora e das 06h). */
  async atualizarSatelite(ctx: ContextoUsina, diaInicio: string, diaFim: string): Promise<number> {
    const pontos = await this.provider.observada(this.local(ctx), diaInicio, diaFim);
    return this.gravar(ctx, 'observado', 'satelite', pontos);
  }

  /** Apaga o cache de irradiância da unidade (inclinação/azimute mudaram). */
  async limpar(unidadeId: string): Promise<void> {
    await this.prisma.$executeRaw`DELETE FROM irradiancia_15min WHERE unidade_id = ${unidadeId.trim()}`;
  }

  private podeTentar(chave: string, minutos: number): boolean {
    const ultima = this.tentativas.get(chave) ?? 0;
    if (Date.now() - ultima < minutos * 60_000) return false;
    this.tentativas.set(chave, Date.now());
    return true;
  }

  /** Busca no satélite os dias sem cobertura. Dia passado = ≥ 90 intervalos; hoje = até ~3 h atrás. */
  private async completarSatelite(ctx: ContextoUsina, diaInicio: string, diaFim: string, agora: Date): Promise<void> {
    const hoje = diaLocal(agora);
    const fim = diaFim > hoje ? hoje : diaFim;
    if (diaInicio > fim) return;
    const rows = await this.prisma.$queryRaw<Array<{ dia: string; n: number; ultimo: string }>>`
      SELECT to_char((ts - interval '3 hours')::date, 'YYYY-MM-DD') AS dia, count(*)::int AS n,
             to_char(max(ts), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ultimo
      FROM irradiancia_15min
      WHERE unidade_id = ${ctx.unidade.id} AND tipo = 'observado' AND geometria = ${this.geometria(ctx)}
        AND ts >= ${sqlUtc(inicioDoDiaUtc(diaInicio))}::timestamp AND ts < ${sqlUtc(inicioDoDiaUtc(somarDias(fim, 1)))}::timestamp
      GROUP BY 1`;
    const cobertura = new Map(rows.map((r) => [r.dia, r]));
    const faltando = diasEntre(diaInicio, fim).filter((d) => {
      const c = cobertura.get(d);
      if (d === hoje) {
        if (!c) return true;
        return agora.getTime() - Date.parse(c.ultimo) > 3 * 3_600_000;
      }
      return !c || c.n < 90;
    });
    if (!faltando.length) return;
    if (!this.podeTentar(`${ctx.unidade.id}:sat:${faltando[0]}:${faltando[faltando.length - 1]}`, 20)) return;
    await this.atualizarSatelite(ctx, faltando[0], faltando[faltando.length - 1]);
  }

  private async gravar(ctx: ContextoUsina, tipo: 'observado' | 'previsto', fonte: string, pontos: PontoIrradiancia[]): Promise<number> {
    if (!pontos.length) return 0;
    const uid = ctx.unidade.id;
    const geo = this.geometria(ctx);
    for (let i = 0; i < pontos.length; i += 500) {
      const lote = pontos.slice(i, i + 500);
      const values = lote.map(
        (p) => Prisma.sql`(${uid}, ${tipo}, ${sqlUtc(p.inicio)}::timestamp, ${Math.round(p.gPoaWm2 * 100) / 100}, ${fonte}, ${this.provider.nome}, ${geo}, now())`,
      );
      await this.prisma.$executeRaw(Prisma.sql`
        INSERT INTO irradiancia_15min (unidade_id, tipo, ts, g_poa_wm2, fonte, provedor, geometria, updated_at)
        VALUES ${Prisma.join(values)}
        ON CONFLICT (unidade_id, tipo, ts) DO UPDATE SET
          g_poa_wm2 = EXCLUDED.g_poa_wm2, fonte = EXCLUDED.fonte, provedor = EXCLUDED.provedor,
          geometria = EXCLUDED.geometria, updated_at = now()`);
    }
    return pontos.length;
  }

  private async lerCache(ctx: ContextoUsina, tipo: string, ini: Date, fim: Date): Promise<Map<number, number>> {
    const rows = await this.prisma.$queryRaw<Array<{ ts: string; g: number }>>`
      SELECT to_char(ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ts, g_poa_wm2::float8 AS g
      FROM irradiancia_15min
      WHERE unidade_id = ${ctx.unidade.id} AND tipo = ${tipo} AND geometria = ${this.geometria(ctx)}
        AND ts >= ${sqlUtc(ini)}::timestamp AND ts < ${sqlUtc(fim)}::timestamp`;
    return new Map(rows.map((r) => [Date.parse(r.ts), Number(r.g)]));
  }

  /**
   * Solarímetro: média da irradiância por 15 min do equipamento vinculado. O caminho no JSON
   * varia por modelo; GHI é convertido para o plano dos módulos (GER-7).
   */
  private async doSolarimetro(ctx: ContextoUsina, diaInicio: string, diaFim: string): Promise<Map<number, number>> {
    const eq = ctx.config.solarimetroEquipamentoId;
    if (!eq) return new Map();
    const ini = inicioDoDiaUtc(diaInicio);
    const fim = inicioDoDiaUtc(somarDias(diaFim, 1));
    const rows = await this.prisma.$queryRaw<Array<{ b: number; g: number }>>`
      SELECT (floor(extract(epoch FROM timestamp_dados) / 900) * 900)::bigint AS b, AVG(g)::float8 AS g
      FROM (
        SELECT timestamp_dados,
          ${sqlNum(`COALESCE(dados->>'irradiancia', dados->>'irradiance', dados->>'irradiancia_wm2', dados->>'ghi',
            dados->>'poa', dados->>'radiation', dados->>'solar_radiation', dados->'meteo'->>'irradiance',
            dados->'sensor'->>'irradiance')`)} AS g
        FROM equipamentos_dados
        WHERE equipamento_id = ${eq}::bpchar
          AND timestamp_dados >= ${sqlUtc(ini)}::timestamp AND timestamp_dados < ${sqlUtc(fim)}::timestamp
      ) x
      WHERE g IS NOT NULL AND g >= 0 AND g < 2000
      GROUP BY 1`;
    const out = new Map<number, number>();
    for (const r of rows) {
      const inicio = Number(r.b) * 1000;
      let g = Number(r.g);
      if (ctx.config.solarimetroMedicao === 'GHI') {
        g = ghiParaPoa(g, new Date(inicio + INTERVALO_MS / 2), ctx.unidade.latitude, ctx.unidade.longitude,
          ctx.config.inclinacaoGraus, ctx.config.azimuteGraus);
      }
      out.set(inicio, g);
    }
    return out;
  }
}
