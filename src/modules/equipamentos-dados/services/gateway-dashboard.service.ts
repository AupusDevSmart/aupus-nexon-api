import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@aupus/api-shared';

// Constante de divisao do medidor SSU acoplado ao A966. Energia (kWh) =
// leitura_bruta * KD. Hoje hardcoded; quando houver mais de uma unidade
// com Kd diferente, ler de equipamentos_dados_tecnicos.campo='kd'.
const KD_A966_SSU = 0.048;

// 15min = 1/4 hora -> energia do bucket * 4 = potencia media (kW/kvar)
const ENERGIA_PARA_POTENCIA = 4;

// 24h * 4 buckets/h = 96 leituras esperadas/dia se cadencia for 15min
const LEITURAS_POR_HORA = 4;

const TZ_BRASILIA = 'America/Sao_Paulo';
const PERIODOS_VALIDOS = ['1H', '6H', '24H', '7D', 'custom'] as const;
type Periodo = (typeof PERIODOS_VALIDOS)[number];

export interface BucketDerivado {
  kW_consumo: number;
  kW_injecao: number;
  kvar_ind: number;
  kvar_cap: number;
  kvar_resultante: number;     // com sinal: + indutivo, - capacitivo
  kVA: number;
  FP: number;
  FP_natureza: 'ind' | 'cap';
  fluxo_liquido_kw: number;
}

/**
 * Calcula todos os derivados de UM bucket (uma leitura ou uma agregacao).
 * Recebe valores brutos do payload (sem KD aplicada).
 */
function calcularBucket(
  phf: number,
  phr: number,
  qhfi: number,
  qhfc: number,
  qhri: number,
  qhrc: number,
): BucketDerivado {
  const phf_kwh = phf * KD_A966_SSU;
  const phr_kwh = phr * KD_A966_SSU;
  const q_ind_kvarh = (qhfi + qhri) * KD_A966_SSU;
  const q_cap_kvarh = (qhfc + qhrc) * KD_A966_SSU;

  const kW_consumo = phf_kwh * ENERGIA_PARA_POTENCIA;
  const kW_injecao = phr_kwh * ENERGIA_PARA_POTENCIA;
  const kvar_ind = q_ind_kvarh * ENERGIA_PARA_POTENCIA;
  const kvar_cap = q_cap_kvarh * ENERGIA_PARA_POTENCIA;

  // Resultante com sinal (so pra UI: tabela ultimas leituras e FP_natureza)
  const kvar_resultante = kvar_ind - kvar_cap;
  // No kVA usa-se a SOMA dos 4 quadrantes (definicao do operador): cada
  // quadrante e' um vetor, e o medidor reporta os 4 modulos. Somar os
  // 4 da a magnitude total reativa.
  const kvar_para_kVA = kvar_ind + kvar_cap;

  const kW_predominante = Math.max(kW_consumo, kW_injecao);
  const kVA = Math.sqrt(kW_predominante ** 2 + kvar_para_kVA ** 2);
  const FP = kVA === 0 ? 1.0 : kW_predominante / kVA;
  const FP_natureza: 'ind' | 'cap' = kvar_resultante >= 0 ? 'ind' : 'cap';
  // Fluxo liquido = injecao - consumo. Positivo = exportando para a rede,
  // negativo = importando da rede.
  const fluxo_liquido_kw = kW_injecao - kW_consumo;

  return {
    kW_consumo,
    kW_injecao,
    kvar_ind,
    kvar_cap,
    kvar_resultante,
    kVA,
    FP,
    FP_natureza,
    fluxo_liquido_kw,
  };
}

/** Extrai um campo numerico do payload, suportando nested em 'data' ou flat. */
function getNum(dados: any, campo: string): number {
  const flat = dados?.data && typeof dados.data === 'object' ? dados.data : dados;
  const v = flat?.[campo];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return 0;
}

@Injectable()
export class GatewayDashboardService {
  private readonly logger = new Logger(GatewayDashboardService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Dashboard completo: snapshot + resumo do dia + ultimas N leituras + comunicacao.
   * Tudo que NAO depende do seletor de periodo do grafico (carrega 1x ao abrir o modal).
   */
  async getDashboard(equipamentoId: string, n = 5) {
    const id = equipamentoId.trim();
    const eq = await this.prisma.equipamentos.findUnique({
      where: { id },
      include: {
        tipo_equipamento_rel: { select: { nome: true } },
        unidade: { select: { id: true, demanda_carga: true, demanda_geracao: true } },
      },
    });
    if (!eq) {
      throw new NotFoundException(`Equipamento ${id} não encontrado`);
    }

    const { dataInicioDia, agora } = this.janelaHoje();

    // 1. Ultimas N leituras (mais recentes primeiro)
    const ultimasRaw = await this.prisma.equipamentos_dados.findMany({
      where: { equipamento_id: id },
      orderBy: { timestamp_dados: 'desc' },
      take: n,
      select: { timestamp_dados: true, dados: true },
    });

    const ultimas_leituras = ultimasRaw.map((r) => {
      const d = calcularBucket(
        getNum(r.dados, 'phf'),
        getNum(r.dados, 'phr'),
        getNum(r.dados, 'qhfi'),
        getNum(r.dados, 'qhfc'),
        getNum(r.dados, 'qhri'),
        getNum(r.dados, 'qhrc'),
      );
      return {
        timestamp: r.timestamp_dados,
        kW_consumo: d.kW_consumo,
        kW_injecao: d.kW_injecao,
        kvar_resultante: d.kvar_resultante,
        kVA: d.kVA,
        FP: d.FP,
        FP_natureza: d.FP_natureza,
      };
    });

    const snapshot =
      ultimasRaw.length > 0
        ? {
            timestamp_dados: ultimasRaw[0].timestamp_dados,
            ...calcularBucket(
              getNum(ultimasRaw[0].dados, 'phf'),
              getNum(ultimasRaw[0].dados, 'phr'),
              getNum(ultimasRaw[0].dados, 'qhfi'),
              getNum(ultimasRaw[0].dados, 'qhfc'),
              getNum(ultimasRaw[0].dados, 'qhri'),
              getNum(ultimasRaw[0].dados, 'qhrc'),
            ),
          }
        : null;

    // 2. Resumo do dia: agrega no SQL pra evitar trazer N rows.
    // Campos do JSON podem estar em dados->data->>* ou dados->>* (defensivo).
    const resumoRow: any[] = await this.prisma.$queryRaw`
      SELECT
        COALESCE(SUM(COALESCE((dados->'data'->>'phf')::numeric, (dados->>'phf')::numeric)), 0)  AS phf_sum,
        COALESCE(SUM(COALESCE((dados->'data'->>'phr')::numeric, (dados->>'phr')::numeric)), 0)  AS phr_sum,
        COALESCE(SUM(COALESCE((dados->'data'->>'qhfi')::numeric, (dados->>'qhfi')::numeric)), 0) AS qhfi_sum,
        COALESCE(SUM(COALESCE((dados->'data'->>'qhfc')::numeric, (dados->>'qhfc')::numeric)), 0) AS qhfc_sum,
        COALESCE(SUM(COALESCE((dados->'data'->>'qhri')::numeric, (dados->>'qhri')::numeric)), 0) AS qhri_sum,
        COALESCE(SUM(COALESCE((dados->'data'->>'qhrc')::numeric, (dados->>'qhrc')::numeric)), 0) AS qhrc_sum,
        COUNT(*)::int AS num_leituras
      FROM equipamentos_dados
      WHERE equipamento_id = ${id}
        AND timestamp_dados >= ${dataInicioDia}
        AND timestamp_dados <  ${agora}
    `;

    const r0 = resumoRow[0] ?? {};
    const consumo_kwh = Number(r0.phf_sum) * KD_A966_SSU;
    const injecao_kwh = Number(r0.phr_sum) * KD_A966_SSU;
    const q_ind_kvarh = (Number(r0.qhfi_sum) + Number(r0.qhri_sum)) * KD_A966_SSU;
    const q_cap_kvarh = (Number(r0.qhfc_sum) + Number(r0.qhrc_sum)) * KD_A966_SSU;
    const num_leituras_hoje = Number(r0.num_leituras) || 0;

    // 3. Picos do dia: precisa do timestamp do bucket que teve o pico.
    // Calcula por bucket (no SQL) e usa argmax via DISTINCT ON.
    const picoConsumoRow: any[] = await this.prisma.$queryRaw`
      SELECT timestamp_dados,
             COALESCE((dados->'data'->>'phf')::numeric, (dados->>'phf')::numeric) * ${KD_A966_SSU} * ${ENERGIA_PARA_POTENCIA} AS kw
        FROM equipamentos_dados
       WHERE equipamento_id = ${id}
         AND timestamp_dados >= ${dataInicioDia}
         AND timestamp_dados <  ${agora}
         AND COALESCE((dados->'data'->>'phf')::numeric, (dados->>'phf')::numeric) IS NOT NULL
       ORDER BY kw DESC
       LIMIT 1
    `;
    const picoInjecaoRow: any[] = await this.prisma.$queryRaw`
      SELECT timestamp_dados,
             COALESCE((dados->'data'->>'phr')::numeric, (dados->>'phr')::numeric) * ${KD_A966_SSU} * ${ENERGIA_PARA_POTENCIA} AS kw
        FROM equipamentos_dados
       WHERE equipamento_id = ${id}
         AND timestamp_dados >= ${dataInicioDia}
         AND timestamp_dados <  ${agora}
         AND COALESCE((dados->'data'->>'phr')::numeric, (dados->>'phr')::numeric) IS NOT NULL
       ORDER BY kw DESC
       LIMIT 1
    `;

    const pico_consumo =
      picoConsumoRow[0]
        ? { kw: Number(picoConsumoRow[0].kw), timestamp: picoConsumoRow[0].timestamp_dados }
        : null;
    const pico_injecao =
      picoInjecaoRow[0]
        ? { kw: Number(picoInjecaoRow[0].kw), timestamp: picoInjecaoRow[0].timestamp_dados }
        : null;

    // 4. Comunicacao: leituras esperadas ate agora baseado nas horas decorridas no dia.
    // Evita mostrar 0% as 00:00; mostra qualidade real ate o momento.
    const horasDecorridas = (agora.getTime() - dataInicioDia.getTime()) / 3_600_000;
    const leituras_esperadas = Math.max(1, Math.floor(horasDecorridas * LEITURAS_POR_HORA));
    const pacotes_perdidos = Math.max(0, leituras_esperadas - num_leituras_hoje);
    const percentual = Math.min(100, (num_leituras_hoje / leituras_esperadas) * 100);

    return {
      equipamento: {
        id: eq.id,
        nome: eq.nome,
        tag: eq.tag,
        tipo: eq.tipo_equipamento_rel?.nome ?? eq.tipo_equipamento,
      },
      unidade: eq.unidade
        ? {
            id: eq.unidade.id,
            demanda_carga: eq.unidade.demanda_carga ? Number(eq.unidade.demanda_carga) : null,
            demanda_geracao: eq.unidade.demanda_geracao ? Number(eq.unidade.demanda_geracao) : null,
          }
        : null,
      snapshot,
      resumo_dia: {
        data: dataInicioDia.toISOString().split('T')[0],
        consumo_kwh,
        injecao_kwh,
        q_ind_kvarh,
        q_cap_kvarh,
        pico_consumo,
        pico_injecao,
      },
      ultimas_leituras,
      comunicacao: {
        leituras_recebidas_hoje: num_leituras_hoje,
        leituras_esperadas,
        percentual,
        pacotes_perdidos,
        ultimo_pulso: ultimasRaw[0]?.timestamp_dados ?? null,
      },
    };
  }

  /**
   * Serie temporal pra grafico de tendencia. Bucket adaptativo por periodo.
   * Retorna kW_consumo e kW_injecao (frontend faz *-1 em injecao ao plotar).
   */
  async getTendencia(
    equipamentoId: string,
    periodo: string,
    inicio?: string,
    fim?: string,
  ) {
    const id = equipamentoId.trim();
    await this.assertEquipamentoExiste(id);

    if (!PERIODOS_VALIDOS.includes(periodo as Periodo)) {
      throw new BadRequestException(
        `periodo invalido. Use: ${PERIODOS_VALIDOS.join(', ')}`,
      );
    }

    const { dataInicio, dataFim, intervaloMin } = this.resolverJanela(
      periodo as Periodo,
      inicio,
      fim,
    );

    const rows: any[] = await this.prisma.$queryRaw`
      SELECT
        DATE_TRUNC('hour', timestamp_dados)
          + (FLOOR(EXTRACT(minute FROM timestamp_dados) / ${intervaloMin}) * ${intervaloMin}) * INTERVAL '1 minute'
          AS bucket,
        AVG(COALESCE((dados->'data'->>'phf')::numeric, (dados->>'phf')::numeric)) AS phf_avg,
        AVG(COALESCE((dados->'data'->>'phr')::numeric, (dados->>'phr')::numeric)) AS phr_avg,
        COUNT(*)::int AS num_leituras
      FROM equipamentos_dados
      WHERE equipamento_id = ${id}
        AND timestamp_dados >= ${dataInicio}
        AND timestamp_dados <  ${dataFim}
        AND (
          dados->'data'->>'phf' IS NOT NULL
          OR dados->>'phf' IS NOT NULL
          OR dados->'data'->>'phr' IS NOT NULL
          OR dados->>'phr' IS NOT NULL
        )
      GROUP BY bucket
      ORDER BY bucket ASC
    `;

    const dados = rows.map((r) => {
      const phf_avg = Number(r.phf_avg) || 0;
      const phr_avg = Number(r.phr_avg) || 0;
      return {
        timestamp: r.bucket,
        kW_consumo: phf_avg * KD_A966_SSU * ENERGIA_PARA_POTENCIA,
        kW_injecao: phr_avg * KD_A966_SSU * ENERGIA_PARA_POTENCIA,
        num_leituras: r.num_leituras,
      };
    });

    return {
      periodo,
      intervalo_min: intervaloMin,
      inicio: dataInicio.toISOString(),
      fim: dataFim.toISOString(),
      total_pontos: dados.length,
      dados,
    };
  }

  private async assertEquipamentoExiste(id: string) {
    const eq = await this.prisma.equipamentos.findUnique({ where: { id } });
    if (!eq) {
      throw new NotFoundException(`Equipamento ${id} não encontrado`);
    }
  }

  /**
   * Resolve janela [inicio, fim) e tamanho do bucket pelo periodo.
   * Bucket adaptativo evita gerar gráfico denso demais (7D × 15min = 672 pontos).
   */
  private resolverJanela(periodo: Periodo, inicio?: string, fim?: string) {
    if (periodo === 'custom') {
      if (!inicio || !fim) {
        throw new BadRequestException('periodo=custom exige inicio e fim');
      }
      const dataInicio = new Date(inicio);
      const dataFim = new Date(fim);
      if (!(dataInicio instanceof Date) || isNaN(dataInicio.getTime())) {
        throw new BadRequestException('inicio invalido');
      }
      if (!(dataFim instanceof Date) || isNaN(dataFim.getTime())) {
        throw new BadRequestException('fim invalido');
      }
      if (dataInicio >= dataFim) {
        throw new BadRequestException('inicio deve ser anterior a fim');
      }
      const horas = (dataFim.getTime() - dataInicio.getTime()) / 3_600_000;
      const intervaloMin = horas <= 48 ? 15 : horas <= 24 * 30 ? 60 : 60 * 24;
      return { dataInicio, dataFim, intervaloMin };
    }

    const agora = new Date();
    const map: Record<Exclude<Periodo, 'custom'>, { horas: number; intervaloMin: number }> = {
      '1H': { horas: 1, intervaloMin: 15 },
      '6H': { horas: 6, intervaloMin: 15 },
      '24H': { horas: 24, intervaloMin: 15 },
      '7D': { horas: 24 * 7, intervaloMin: 60 },
    };
    const { horas, intervaloMin } = map[periodo as Exclude<Periodo, 'custom'>];
    const dataInicio = new Date(agora.getTime() - horas * 3_600_000);
    return { dataInicio, dataFim: agora, intervaloMin };
  }

  /** Inicio do dia atual em BRT (UTC equivalente) e timestamp atual. */
  private janelaHoje() {
    const agora = new Date();
    const brt = agora.toLocaleDateString('en-CA', { timeZone: TZ_BRASILIA });
    const [ano, mes, dia] = brt.split('-').map(Number);
    // 00:00 BRT = 03:00 UTC. Pra evitar lidar com TZ offset variavel,
    // uso UTC midnight da data BRT — equivale a ~21:00 UTC do dia anterior.
    // Funciona porque equipamentos_dados.timestamp_dados eh timestamp without TZ
    // armazenado em UTC pelo Prisma.
    const dataInicioDia = new Date(Date.UTC(ano, mes - 1, dia, 0, 0, 0, 0));
    return { dataInicioDia, agora };
  }
}
