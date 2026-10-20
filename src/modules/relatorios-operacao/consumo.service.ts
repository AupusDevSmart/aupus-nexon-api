import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/core';
import { AgregadoDiarioService } from '../equipamentos-dados/services/agregado-diario.service';
import { resumoBlocos } from '../equipamentos-dados/services/medidor-resumo.util';
import { GeracaoConfigService } from '../geracao-analise/geracao-config.service';
import { ContextoRelatorio, RelatorioBaseService } from './relatorio-base.service';
import {
  cargaBaseKw,
  curvaTipica,
  demanda12m,
  demandaMaxima,
  energiaPorPosto,
  intervalosFpBaixo,
  modalidadeTarifaria,
  reativoIndutivoPct,
  ultrapassagens,
} from './calc/consumo';
import { arred } from './calc/disponibilidade';
import { inicioDoDia, isoBrt, periodoDoMes, somarDias, somarMeses } from './calc/periodo';
import type { RelatorioConsumo } from './relatorios-operacao.tipos';

export const TOLERANCIA_DEMANDA_PCT = 5;

/**
 * Relatório de consumo (medidor da instalação). Blocos de 15 min do medidor (SSU ou PM) —
 * a mesma leitura do resumo do medidor (MedidorResumoService) —, posto pelo
 * ClassificacaoHorariosService, demanda contratada da configuracao_demanda (ou da instalação).
 */
@Injectable()
export class ConsumoRelatorioService {
  private readonly logger = new Logger(ConsumoRelatorioService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly base: RelatorioBaseService,
    private readonly agregado: AgregadoDiarioService,
    private readonly configs: GeracaoConfigService,
  ) {}

  async gerar(ctx: ContextoRelatorio): Promise<RelatorioConsumo> {
    const { periodo, unidade, user } = ctx;
    const medidor = await this.base.medidorDaInstalacao(ctx, ctx.equipamentos);
    const contratada = await this.demandaContratada(unidade.id);
    const anterior = periodoDoMes(somarMeses(periodo.mes, -1), ctx.agora);

    const [blocos, blocosAnt, porMes, fontes, chamados] = await Promise.all([
      medidor ? this.base.blocos(medidor.id, periodo.inicio, periodo.fim) : Promise.resolve([]),
      medidor && anterior ? this.base.blocos(medidor.id, anterior.inicio, anterior.fim) : Promise.resolve([]),
      medidor ? this.demandaPorMes(medidor.id, periodo.mes, periodo.fim) : Promise.resolve(new Map<string, number>()),
      this.base.fontesDeMedicao(unidade.id),
      this.base.chamados(ctx),
    ]);

    const r = blocos.length ? resumoBlocos(blocos) : null;
    const daRede = r ? r.consumo_kwh : null;
    const injetada = r ? r.injecao_kwh : null;
    const max = demandaMaxima(blocos);
    if (max) porMes.set(periodo.mes, max.kw); // mês do relatório = mesma leitura do bloco "Demanda"

    // Geração da instalação (inversores) para o balanço; operador só com "Ver geração".
    let geracao: number | null = null;
    if (await this.base.podeVerGeracao(unidade.id, user)) {
      try {
        const invs = await this.configs.inversores(unidade.id);
        const linhas = invs.length ? await this.agregado.porDia(invs.map((i) => i.id), periodo.diaInicio, somarDias(periodo.diaFim, 1)) : [];
        geracao = linhas.length ? linhas.reduce((s, l) => s + Number(l.energia_total ?? 0), 0) : null;
      } catch (e) {
        this.logger.warn(`[consumo] geração: ${(e as Error)?.message}`);
      }
    }
    const autoconsumo = geracao !== null && injetada !== null ? Math.max(0, geracao - injetada) : null;

    // Maiores consumidores: os outros medidores da instalação (PM de pivô, carga...).
    const lib = ctx.eqScope ? new Set(ctx.eqScope) : null;
    const outros = fontes.filter((f) => f.fonte_id !== medidor?.id && (!lib || lib.has(f.fonte_id) || lib.has(f.dj_id)));
    const maiores: Array<{ nome: string; kwh: number }> = [];
    if (outros.length) {
      const linhas = await this.agregado.porDia([...new Set(outros.map((o) => o.fonte_id))], periodo.diaInicio, somarDias(periodo.diaFim, 1));
      const soma = new Map<string, number>();
      for (const l of linhas) soma.set(l.equipamento_id.trim(), (soma.get(l.equipamento_id.trim()) ?? 0) + Number(l.energia_total ?? 0));
      const vistos = new Set<string>();
      for (const o of outros) {
        if (vistos.has(o.fonte_id)) continue;
        vistos.add(o.fonte_id);
        const kwh = soma.get(o.fonte_id) ?? 0;
        if (kwh > 0) maiores.push({ nome: o.carga_nome ?? o.dj_nome ?? o.fonte_nome ?? 'Medidor', kwh: arred(kwh, 1) });
      }
      maiores.sort((a, b) => b.kwh - a.kwh);
    }

    return {
      cabecalho: this.base.cabecalho(ctx),
      modalidade: modalidadeTarifaria(unidade.grupo, unidade.subgrupo),
      demandaContratadaKw: contratada,
      toleranciaPct: TOLERANCIA_DEMANDA_PCT,
      consumoTotalKwh: daRede !== null ? arred(daRede + (autoconsumo ?? 0), 1) : null,
      daRedeKwh: daRede !== null ? arred(daRede, 1) : null,
      daRedeMesAnteriorKwh: blocosAnt.length ? arred(resumoBlocos(blocosAnt).consumo_kwh, 1) : null,
      energiaPorPosto: energiaPorPosto(blocos, this.base.classificadorDePosto(unidade)),
      demandaMaxKw: max ? arred(max.kw, 1) : null,
      demandaMaxEm: max ? isoBrt(max.t) : null,
      ultrapassagens: blocos.length ? ultrapassagens(blocos, contratada, TOLERANCIA_DEMANDA_PCT) : null,
      fpMedio: r?.fp_medio !== null && r?.fp_medio !== undefined ? arred(r.fp_medio, 3) : null,
      intervalosFpBaixo: blocos.length ? intervalosFpBaixo(blocos) : null,
      reativoExcedenteKvarh: r ? arred(r.reativo_excedente_kvarh, 1) : null,
      reativoIndutivoPct: reativoIndutivoPct(blocos),
      cargaBaseKw: cargaBaseKw(blocos),
      demanda12m: demanda12m(periodo.mes, porMes),
      maioresConsumidores: maiores.slice(0, 5),
      curvaTipica: curvaTipica(blocos, (d) => this.base.ehDiaUtil(d)),
      balanco: {
        geracaoKwh: geracao !== null ? arred(geracao, 1) : null,
        autoconsumoKwh: autoconsumo !== null ? arred(autoconsumo, 1) : null,
        daRedeKwh: daRede !== null ? arred(daRede, 1) : null,
        injetadaKwh: injetada !== null ? arred(injetada, 1) : null,
      },
      chamados: chamados.bloco,
    };
  }

  /** Demanda contratada: configuracao_demanda.valor_contratado, senão unidades.demanda_carga. */
  private async demandaContratada(unidadeId: string): Promise<number | null> {
    const [r] = await this.prisma.$queryRaw<Array<{ cfg: number | null; uni: number | null }>>`
      SELECT (SELECT valor_contratado::float8 FROM configuracao_demanda WHERE unidade_id = ${unidadeId}::bpchar LIMIT 1) AS cfg,
             (SELECT demanda_carga::float8 FROM unidades WHERE id = ${unidadeId}::bpchar) AS uni`;
    const v = Number(r?.cfg) > 0 ? Number(r?.cfg) : Number(r?.uni) > 0 ? Number(r?.uni) : null;
    return v !== null ? arred(v, 1) : null;
  }

  /**
   * Maior demanda (média de 15 min da potência de consumo) por mês nos 12 meses até `mes`.
   * Uma consulta só; usa potencia_ativa_kw (PM e SSU gravam a potência do bloco nela).
   */
  private async demandaPorMes(medidorId: string, mes: string, ate: Date): Promise<Map<string, number>> {
    const desde = inicioDoDia(`${somarMeses(mes, -11)}-01`);
    const rows = await this.prisma.$queryRaw<Array<{ mes: string; kw: number | null }>>`
      SELECT to_char((b AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') AS mes, MAX(kw)::float8 AS kw
      FROM (
        SELECT to_timestamp(floor(extract(epoch FROM timestamp_dados) / 900) * 900) AT TIME ZONE 'UTC' AS b,
               AVG(GREATEST(potencia_ativa_kw, 0)) AS kw
        FROM equipamentos_dados
        WHERE equipamento_id = ${medidorId}::bpchar AND timestamp_dados >= ${desde} AND timestamp_dados < ${ate}
          AND potencia_ativa_kw IS NOT NULL AND potencia_ativa_kw < 1000000
        GROUP BY 1) x
      GROUP BY 1`;
    return new Map(rows.filter((r) => r.kw !== null).map((r) => [r.mes, Number(r.kw)]));
  }
}
