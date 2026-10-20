import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/core';
import { GeracaoConfigService } from '../geracao-analise/geracao-config.service';
import { GeracaoAnaliseService } from '../geracao-analise/geracao-analise.service';
import { AgregadoDiarioService } from '../equipamentos-dados/services/agregado-diario.service';
import { resumoBlocos } from '../equipamentos-dados/services/medidor-resumo.util';
import { ContextoRelatorio, RelatorioBaseService } from './relatorio-base.service';
import { arred, diasParados, disponibilidadePct, mediaDisponibilidade } from './calc/disponibilidade';
import { diaLocal, diasDe, isoBrt, periodoDoMes, somarDias, somarMeses } from './calc/periodo';
import type { InversorRelatorio, RelatorioGeracao } from './relatorios-operacao.tipos';

/** Mesma potência do inversor da análise de geração / resumo do medidor (W → kW, teto anti-glitch). */
const CAP_INV_KW = 5000;

/**
 * Relatório de geração (inversores). Energia do dia = resumo diário (equipamentos_dados_dia,
 * ADR 0003); esperado e perdas = análise de geração (satélite/solarímetro, cache
 * geracao_analise_diaria); injeção e autoconsumo = medidor da instalação.
 */
@Injectable()
export class GeracaoRelatorioService {
  private readonly logger = new Logger(GeracaoRelatorioService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly base: RelatorioBaseService,
    private readonly configs: GeracaoConfigService,
    private readonly analise: GeracaoAnaliseService,
    private readonly agregado: AgregadoDiarioService,
  ) {}

  async gerar(ctx: ContextoRelatorio, medidorId: string | null): Promise<RelatorioGeracao> {
    const { periodo, unidade, user } = ctx;
    // PER-40: operador só com "Ver geração" na instalação.
    if (user && !(await this.base.podeVerGeracao(unidade.id, user))) throw new ForbiddenException('Recurso fora do escopo do usuario');

    const usina = await this.configs.contexto(unidade.id);
    const visiveis = new Set(ctx.equipamentos.map((e) => e.id));
    const inversores = usina.inversores.filter((i) => visiveis.has(i.id));
    const ids = inversores.map((i) => i.id);
    const ini = periodo.inicio.getTime();
    const fim = periodo.fim.getTime();
    const fimDia = somarDias(periodo.diaFim, 1);

    const anterior = periodoDoMes(somarMeses(periodo.mes, -1), ctx.agora);
    const [linhasDia, linhasAnt, pico, chamados, alertas, semCom] = await Promise.all([
      this.agregado.porDia(ids, periodo.diaInicio, fimDia),
      anterior ? this.agregado.porDia(ids, anterior.diaInicio, somarDias(anterior.diaFim, 1)) : Promise.resolve([]),
      this.picoPotencia(ids, periodo.inicio, periodo.fim),
      this.base.chamados(ctx),
      this.base.alertas(ids, periodo.inicio, periodo.fim),
      this.base.semComunicacao(ctx, inversores.map((i) => ({ id: i.id, nome: i.nome }))),
    ]);

    // energia[inv][dia]
    const energia = new Map<string, Map<string, number>>(ids.map((id) => [id, new Map()]));
    for (const l of linhasDia) {
      if (l.energia_total === null || l.energia_total === undefined) continue;
      energia.get(l.equipamento_id.trim())?.set(l.dia, Number(l.energia_total));
    }
    const total = linhasDia.reduce((s, l) => s + Number(l.energia_total ?? 0), 0);
    const totalAnt = linhasAnt.length ? linhasAnt.reduce((s, l) => s + Number(l.energia_total ?? 0), 0) : null;

    // Esperado e perdas: só com fonte de irradiância configurada.
    const dias = diasDe(periodo.diaInicio, periodo.diaFim);
    const comFonte = usina.config.fonte !== 'nenhuma' && ids.length > 0;
    let resumos = new Map<string, { esperadoKwh: number | null; realComEsperadoKwh: number; indisponibilidadeKwh: number; limitacaoProjetoKwh: number; limitacaoExternaKwh: number }>();
    if (comFonte && linhasDia.length) {
      try {
        const primeiro = linhasDia[0]?.dia ?? null;
        resumos = await this.analise.resumosDiarios(usina, dias, ctx.agora, primeiro);
      } catch (e) {
        this.logger.warn(`[geracao] análise indisponível: ${(e as Error)?.message}`);
      }
    }
    const hoje = diaLocal(ctx.agora);
    const comEsperado = [...resumos.entries()].filter(([d, r]) => d < hoje && r.esperadoKwh !== null).map(([, r]) => r);
    const esperado = comEsperado.length ? comEsperado.reduce((s, r) => s + (r.esperadoKwh as number), 0) : null;

    let perdas: RelatorioGeracao['perdas'] = null;
    if (esperado !== null) {
      const real = comEsperado.reduce((s, r) => s + r.realComEsperadoKwh, 0);
      const indisp = comEsperado.reduce((s, r) => s + r.indisponibilidadeKwh, 0);
      const ext = comEsperado.reduce((s, r) => s + r.limitacaoExternaKwh, 0);
      const proj = comEsperado.reduce((s, r) => s + r.limitacaoProjetoKwh, 0);
      perdas = {
        indisponibilidadeKwh: arred(indisp, 1),
        limitacaoExternaKwh: arred(ext, 1),
        limitacaoProjetoKwh: arred(proj, 1),
        outrasKwh: arred(Math.max(0, esperado - real - indisp - ext - proj), 1),
        notaIndisponibilidade: null,
      };
    }

    // Dias parados: dias fechados (antes de hoje) a partir do primeiro com leitura.
    const primeiroComDado = linhasDia.length ? linhasDia[0].dia : null;
    const diasFechados = primeiroComDado ? dias.filter((d) => d >= primeiroComDado && d < hoje) : [];
    const parados = diasParados(energia, ids, diasFechados);

    const kwpTotal = usina.config.kwpDc;
    const somaAc = inversores.reduce((s, i) => s + (i.potenciaKw ?? 0), 0);
    const multiplosGrupos = new Set(ctx.equipamentos.map((e) => e.pai_nome ?? '')).size > 1;
    const paiDe = new Map(ctx.equipamentos.map((e) => [e.id, e.pai_nome]));

    const linhasInv: InversorRelatorio[] = inversores.map((i) => {
      const e = [...(energia.get(i.id)?.values() ?? [])].reduce((s, x) => s + x, 0);
      // kWp do inversor = kWp DC da usina rateado pela potência AC (não há kWp por inversor no cadastro).
      const kwp = kwpTotal && i.potenciaKw && somaAc > 0 && inversores.every((x) => x.potenciaKw) ? arred((kwpTotal * i.potenciaKw) / somaAc, 2) : null;
      const diasP = parados.porInversor.get(i.id) ?? [];
      return {
        equipamentoId: i.id,
        nome: multiplosGrupos && paiDe.get(i.id) ? `${i.nome} · ${paiDe.get(i.id)}` : i.nome,
        potenciaKwp: kwp,
        energiaKwh: arred(e, 1),
        kwhPorKwp: kwp ? arred(e / kwp, 1) : null,
        diasParado: diasP.length,
        causa: diasP.length ? this.causa(i.id, parados.semLeitura.get(i.id) ?? 0, diasP.length, alertas) : null,
      };
    });

    if (perdas && perdas.indisponibilidadeKwh > 0) {
      const pior = [...linhasInv].sort((a, b) => b.diasParado - a.diasParado)[0];
      if (pior?.diasParado) perdas.notaIndisponibilidade = `${pior.nome} parado ${pior.diasParado} dia${pior.diasParado === 1 ? '' : 's'}`;
    }

    // Disponibilidade: energia (1 − indisponibilidade ÷ esperado) quando há esperado; senão a
    // média de comunicação dos inversores (alarmes de comunicação).
    const disponibilidade =
      esperado && perdas
        ? arred(Math.max(0, Math.min(100, (1 - perdas.indisponibilidadeKwh / esperado) * 100)), 1)
        : mediaDisponibilidade(ids.map((id) => disponibilidadePct(semCom.get(id) ?? [], ini, fim)));

    // Injeção/autoconsumo pelo medidor da instalação (se houver).
    let injetada: number | null = null;
    let injecaoMax: { kw: number; t: number } | null = null;
    if (medidorId) {
      const blocos = await this.base.blocos(medidorId, periodo.inicio, periodo.fim).catch(() => []);
      if (blocos.length) {
        const r = resumoBlocos(blocos);
        injetada = r.injecao_kwh;
        injecaoMax = r.injecao_max;
      }
    }

    const verRs = usina.config.exibirRs && (await this.base.podeVerValores(ids, user));

    return {
      cabecalho: this.base.cabecalho(ctx),
      potenciaKwp: kwpTotal ?? null,
      fonteEsperado: esperado !== null && usina.config.fonte === 'satelite' ? 'satelite' : null,
      energiaKwh: arred(total, 1),
      energiaMesAnteriorKwh: totalAnt !== null ? arred(totalAnt, 1) : null,
      esperadoKwh: esperado !== null ? arred(esperado, 1) : null,
      disponibilidadePct: disponibilidade,
      diasComInversorParado: parados.diasComParado,
      potenciaMaxKw: pico ? arred(pico.kw, 1) : null,
      potenciaMaxEm: pico ? isoBrt(pico.t) : null,
      autoconsumoKwh: injetada !== null && linhasDia.length ? arred(Math.max(0, total - injetada), 1) : null,
      injetadaKwh: injetada !== null ? arred(injetada, 1) : null,
      injecaoMaxKw: injecaoMax ? arred(injecaoMax.kw, 1) : null,
      injecaoMaxEm: injecaoMax ? isoBrt(injecaoMax.t) : null,
      tarifaReferencia: verRs && usina.tarifaRsKwh !== null ? Math.round(usina.tarifaRsKwh * 10000) / 10000 : null,
      diario: dias.map((d) => {
        const vals = ids.map((id) => energia.get(id)?.get(d)).filter((x): x is number => x !== undefined);
        const r = resumos.get(d);
        return {
          dia: d,
          geradoKwh: vals.length ? arred(vals.reduce((s, x) => s + x, 0), 1) : null,
          esperadoKwh: r && r.esperadoKwh !== null && d < hoje ? arred(r.esperadoKwh, 1) : null,
        };
      }),
      perdas,
      inversores: linhasInv,
      chamados: chamados.bloco,
    };
  }

  /** Causa provável em texto curto. */
  private causa(id: string, semLeitura: number, diasParado: number, alertas: Array<{ equipamento_id: string; regra: string | null; mensagem: string | null; origem: string | null }>): string | null {
    if (semLeitura >= Math.ceil(diasParado / 2)) return 'Sem comunicação';
    const conta = new Map<string, number>();
    for (const a of alertas) {
      if (a.equipamento_id !== id) continue;
      const k = a.origem === 'comunicacao' ? 'Sem comunicação' : (a.regra || a.mensagem || '').trim();
      if (k) conta.set(k, (conta.get(k) ?? 0) + 1);
    }
    const top = [...conta.entries()].sort((a, b) => b[1] - a[1])[0];
    return top ? top[0].slice(0, 80) : null;
  }

  /** Maior potência somada dos inversores (média de 15 min) no período. */
  private async picoPotencia(ids: string[], ini: Date, fim: Date): Promise<{ kw: number; t: number } | null> {
    if (!ids.length) return null;
    const rows = await this.prisma.$queryRaw<Array<{ t: Date; kw: number | null }>>`
      SELECT t, SUM(kw)::float8 AS kw FROM (
        SELECT equipamento_id, to_timestamp(floor(extract(epoch FROM timestamp_dados) / 900) * 900 + 900) AT TIME ZONE 'UTC' AS t,
               AVG(COALESCE(NULLIF(dados->'power'->>'active_total', '')::float / 1000, potencia_ativa_kw::float)) AS kw
        FROM equipamentos_dados
        WHERE equipamento_id = ANY(${ids}::bpchar[]) AND timestamp_dados >= ${ini} AND timestamp_dados < ${fim}
        GROUP BY 1, 2) x
      WHERE kw < ${CAP_INV_KW}
      GROUP BY t ORDER BY 2 DESC NULLS LAST LIMIT 1`;
    const r = rows[0];
    return r && r.kw !== null && Number(r.kw) > 0 ? { kw: Number(r.kw), t: new Date(r.t).getTime() } : null;
  }
}
