import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@aupus/api-shared';

const INTERVALOS_VALIDOS = [1, 5, 15, 30] as const;
const DEFAULT_INTERVALO_MIN = 30;
const TZ_BRASILIA = 'America/Sao_Paulo';

export interface GatewayPontoDia {
  timestamp: Date;
  hora: string;
  phf_kw: number;
  phr_kw: number;
  num_leituras: number;
}

export interface GatewayPontoMes {
  data: string;
  dia: number;
  phf_kw_avg: number;
  phr_kw_avg: number;
  num_registros: number;
}

@Injectable()
export class GatewayGraficosService {
  private readonly logger = new Logger(GatewayGraficosService.name);

  constructor(private prisma: PrismaService) {}

  async getGraficoDia(
    equipamentoId: string,
    data?: string,
    intervalo?: string,
    inicio?: string,
    fim?: string,
  ) {
    const equipamentoIdLimpo = equipamentoId.trim();
    await this.assertEquipamentoExiste(equipamentoIdLimpo);

    const intervaloMin = INTERVALOS_VALIDOS.includes(Number(intervalo) as any)
      ? Number(intervalo)
      : DEFAULT_INTERVALO_MIN;

    const { dataConsulta, dataFim } = this.resolverJanelaDia(data, inicio, fim);

    const rows: any[] = await this.prisma.$queryRaw`
      SELECT
        DATE_TRUNC('hour', timestamp_dados)
          + (FLOOR(EXTRACT(minute FROM timestamp_dados) / ${intervaloMin}) * ${intervaloMin}) * INTERVAL '1 minute'
          AS bucket,
        AVG(COALESCE((dados->'data'->>'phf')::numeric, (dados->>'phf')::numeric)) AS phf_avg,
        AVG(COALESCE((dados->'data'->>'phr')::numeric, (dados->>'phr')::numeric)) AS phr_avg,
        COUNT(*)::int AS num_leituras
      FROM equipamentos_dados
      WHERE equipamento_id = ${equipamentoIdLimpo}
        AND timestamp_dados >= ${dataConsulta}
        AND timestamp_dados < ${dataFim}
        AND (
          dados->'data'->>'phf' IS NOT NULL
          OR dados->>'phf' IS NOT NULL
          OR dados->'data'->>'phr' IS NOT NULL
          OR dados->>'phr' IS NOT NULL
        )
      GROUP BY bucket
      ORDER BY bucket ASC
    `;

    const pontos: GatewayPontoDia[] = rows.map((r: any) => ({
      timestamp: r.bucket,
      hora: new Date(r.bucket).toISOString(),
      phf_kw: Number(r.phf_avg) || 0,
      phr_kw: Number(r.phr_avg) || 0,
      num_leituras: r.num_leituras,
    }));

    return {
      data: dataConsulta.toISOString().split('T')[0],
      total_pontos: pontos.length,
      intervalo_minutos: intervaloMin,
      dados: pontos,
    };
  }

  async getGraficoMes(equipamentoId: string, mes?: string) {
    const equipamentoIdLimpo = equipamentoId.trim();
    await this.assertEquipamentoExiste(equipamentoIdLimpo);

    const { ano, mesNum } = this.resolverMes(mes);
    const dataInicio = new Date(Date.UTC(ano, mesNum - 1, 1, 0, 0, 0, 0));
    const dataFim = new Date(Date.UTC(ano, mesNum, 1, 0, 0, 0, 0));

    const rows: any[] = await this.prisma.$queryRaw`
      SELECT
        DATE(timestamp_dados) AS data,
        AVG(COALESCE((dados->'data'->>'phf')::numeric, (dados->>'phf')::numeric)) AS phf_avg,
        AVG(COALESCE((dados->'data'->>'phr')::numeric, (dados->>'phr')::numeric)) AS phr_avg,
        COUNT(*)::int AS num_registros
      FROM equipamentos_dados
      WHERE equipamento_id = ${equipamentoIdLimpo}
        AND timestamp_dados >= ${dataInicio}
        AND timestamp_dados < ${dataFim}
        AND (
          dados->'data'->>'phf' IS NOT NULL
          OR dados->>'phf' IS NOT NULL
          OR dados->'data'->>'phr' IS NOT NULL
          OR dados->>'phr' IS NOT NULL
        )
      GROUP BY DATE(timestamp_dados)
      ORDER BY data ASC
    `;

    const pontos: GatewayPontoMes[] = rows.map((r: any) => {
      const d: Date = r.data;
      return {
        data: d.toISOString().split('T')[0],
        dia: d.getUTCDate(),
        phf_kw_avg: Number(r.phf_avg) || 0,
        phr_kw_avg: Number(r.phr_avg) || 0,
        num_registros: r.num_registros,
      };
    });

    return {
      mes: `${ano}-${String(mesNum).padStart(2, '0')}`,
      total_dias: pontos.length,
      dados: pontos,
    };
  }

  private async assertEquipamentoExiste(id: string) {
    const eq = await this.prisma.equipamentos.findUnique({ where: { id } });
    if (!eq) {
      throw new NotFoundException(`Equipamento ${id} não encontrado`);
    }
  }

  private resolverJanelaDia(data?: string, inicio?: string, fim?: string) {
    if (inicio && fim) {
      const dataConsulta = new Date(inicio);
      const dataFim = new Date(fim);
      if (dataConsulta >= dataFim) {
        throw new Error('inicio deve ser anterior a fim');
      }
      return { dataConsulta, dataFim };
    }

    if (data) {
      const [ano, mes, dia] = data.split('-').map(Number);
      const dataConsulta = new Date(Date.UTC(ano, mes - 1, dia, 0, 0, 0, 0));
      const dataFim = new Date(Date.UTC(ano, mes - 1, dia + 1, 0, 0, 0, 0));
      return { dataConsulta, dataFim };
    }

    const { ano, mes, dia } = this.dataAtualBrasilia();
    const dataConsulta = new Date(Date.UTC(ano, mes - 1, dia, 0, 0, 0, 0));
    const dataFim = new Date();
    return { dataConsulta, dataFim };
  }

  private resolverMes(mes?: string) {
    if (mes) {
      const [ano, m] = mes.split('-').map(Number);
      return { ano, mesNum: m };
    }
    const { ano, mes: m } = this.dataAtualBrasilia();
    return { ano, mesNum: m };
  }

  private dataAtualBrasilia() {
    const now = new Date();
    const brt = now.toLocaleDateString('en-CA', { timeZone: TZ_BRASILIA });
    const [ano, mes, dia] = brt.split('-').map(Number);
    return { ano, mes, dia };
  }
}
