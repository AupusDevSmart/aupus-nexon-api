import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '@/core';
import {
  CAP_POTENCIA_GLITCH_KW,
  diaLocal,
  diasEntre,
  dividirIntervalo,
  faltantes,
  inicioDoDiaUtcSql,
  type LinhaDia,
} from './agregado-diario';

/**
 * Resumo diário por equipamento (energia, potência média, leituras) para os gráficos
 * de mês e ano do sinóptico.
 *
 * Sem ele, cada clique em Mês/Ano relia o período inteiro de `equipamentos_dados`
 * (5,6 GB, linha de ~1,2 KB com o JSON): 15–60 s com o cache de 128 MB do Postgres.
 * Dia fechado não muda, então é calculado uma vez e guardado em `equipamentos_dados_dia`;
 * ontem e hoje são calculados na hora. Leitura que chega atrasada (gateway que estava
 * offline) apaga o dia guardado na varredura de 5 em 5 min e ele é recalculado no
 * próximo pedido. DDL em db/manual-migrations/2026-10-20d_equipamentos_dados_dia.sql.
 */
@Injectable()
export class AgregadoDiarioService {
  private readonly logger = new Logger(AgregadoDiarioService.name);
  private semTabela = false;

  constructor(private readonly prisma: PrismaService) {}

  /** Uma linha por equipamento × dia com leitura, dias locais em [inicio, fim). */
  async porDia(ids: string[], inicio: string, fim: string): Promise<LinhaDia[]> {
    if (!ids.length || inicio >= fim) return [];
    const { fechado, vivo } = dividirIntervalo(inicio, fim, diaLocal(new Date()));
    const linhas: LinhaDia[] = [];
    if (fechado) linhas.push(...(await this.fechados(ids, fechado.inicio, fechado.fim)));
    if (vivo) linhas.push(...(await this.calcular(ids, vivo.inicio, vivo.fim)));
    return linhas.filter((l) => l.num_leituras > 0).sort((a, b) => a.dia.localeCompare(b.dia));
  }

  private async fechados(ids: string[], inicio: string, fim: string): Promise<LinhaDia[]> {
    if (this.semTabela) return this.calcular(ids, inicio, fim);
    let guardadas: LinhaDia[];
    try {
      guardadas = await this.prisma.$queryRaw<LinhaDia[]>`
        SELECT dia::text AS dia, equipamento_id, energia_kwh AS energia_total,
               potencia_media_kw AS potencia_media, num_leituras
        FROM equipamentos_dados_dia
        WHERE equipamento_id = ANY(${ids}::bpchar[]) AND dia >= ${inicio}::date AND dia < ${fim}::date`;
    } catch (e: any) {
      // Tabela ainda não criada (SQL manual não rodou): segue calculando tudo na hora.
      if (String(e?.message ?? '').includes('equipamentos_dados_dia')) this.semTabela = true;
      this.logger.warn(`Resumo diário indisponível, calculando na hora: ${e?.message ?? e}`);
      return this.calcular(ids, inicio, fim);
    }

    const { porEquipamento, intervalo } = faltantes(ids, diasEntre(inicio, fim), guardadas);
    if (!intervalo) return guardadas;

    const idsFaltando = [...porEquipamento.keys()];
    const calculadas = await this.calcular(idsFaltando, intervalo.inicio, intervalo.fim);
    const porChave = new Map(calculadas.map((c) => [`${c.equipamento_id.trim()}|${c.dia}`, c]));
    // Guarda também o dia sem leitura (num_leituras 0): sem isso ele seria recalculado
    // a cada pedido.
    const novas: LinhaDia[] = [];
    for (const [id, dias] of porEquipamento) {
      for (const dia of dias) {
        novas.push(
          porChave.get(`${id}|${dia}`) ?? { dia, equipamento_id: id, energia_total: null, potencia_media: null, num_leituras: 0 },
        );
      }
    }
    await this.guardar(novas);
    return [...guardadas, ...novas];
  }

  /**
   * Energia do dia por equipamento, direto das leituras. Mesma regra do gráfico do dia:
   * inversor = MAX(daily_yield); medidor só com potência = média × horas cobertas; senão
   * soma de energia_kwh. Dia local = (UTC → America/Sao_Paulo); o
   * `timestamp_dados AT TIME ZONE 'America/Sao_Paulo'` antigo tratava o UTC como hora local
   * e jogava as leituras das 21h–24h no dia seguinte.
   */
  private async calcular(ids: string[], inicio: string, fim: string): Promise<LinhaDia[]> {
    const linhas = await this.prisma.$queryRaw<LinhaDia[]>`
      SELECT
        ((timestamp_dados AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date::text AS dia,
        equipamento_id,
        (CASE
          WHEN COUNT(dados->'energy'->>'daily_yield') >= 1
          THEN MAX((dados->'energy'->>'daily_yield')::numeric)
          WHEN COUNT(energia_kwh) < COUNT(*) / 2 AND COUNT(potencia_ativa_kw) > 0
          THEN AVG(potencia_ativa_kw) * EXTRACT(EPOCH FROM (MAX(timestamp_dados) - MIN(timestamp_dados))) / 3600
          ELSE SUM(energia_kwh)
        END)::float8 AS energia_total,
        AVG(potencia_ativa_kw)::float8 AS potencia_media,
        COUNT(*)::int AS num_leituras
      FROM equipamentos_dados
      WHERE equipamento_id = ANY(${ids}::bpchar[])
        AND timestamp_dados >= ${inicioDoDiaUtcSql(inicio)}::timestamp
        AND timestamp_dados < ${inicioDoDiaUtcSql(fim)}::timestamp
        AND (potencia_ativa_kw IS NULL OR potencia_ativa_kw < ${CAP_POTENCIA_GLITCH_KW})
      GROUP BY 1, 2`;
    return linhas.map((l) => ({ ...l, equipamento_id: l.equipamento_id.trim() }));
  }

  private async guardar(linhas: LinhaDia[]): Promise<void> {
    if (!linhas.length) return;
    try {
      await this.prisma.$executeRaw`
        INSERT INTO equipamentos_dados_dia (equipamento_id, dia, energia_kwh, potencia_media_kw, num_leituras)
        SELECT equipamento_id, dia, energia_total, potencia_media, num_leituras
        FROM jsonb_to_recordset(${JSON.stringify(linhas)}::jsonb)
          AS x(equipamento_id char(26), dia date, energia_total float8, potencia_media float8, num_leituras int)
        ON CONFLICT (equipamento_id, dia) DO UPDATE SET
          energia_kwh = EXCLUDED.energia_kwh,
          potencia_media_kw = EXCLUDED.potencia_media_kw,
          num_leituras = EXCLUDED.num_leituras,
          calculado_em = now()`;
    } catch (e: any) {
      // Não guardar só faz o próximo pedido recalcular; a resposta já está pronta.
      this.logger.warn(`Falha ao guardar resumo diário: ${e?.message ?? e}`);
    }
  }

  /**
   * Leitura atrasada: apaga o dia guardado de quem recebeu leitura nova desde a última
   * varredura (pelo índice de created_at, só as linhas novas). A janela volta 5 min para
   * pegar inserção que estava em transação. Rodar em mais de uma instância é inofensivo.
   */
  @Interval(5 * 60_000)
  async invalidarAtrasadas(): Promise<void> {
    if (this.semTabela || process.env.AGREGADO_DIARIO_JOB === 'off') return;
    try {
      const n = await this.prisma.$executeRaw`
        WITH marca AS (
          SELECT ate FROM equipamentos_dados_dia_marca WHERE id = 1
        ), recentes AS (
          SELECT ed.equipamento_id, ed.timestamp_dados, ed.created_at
          FROM equipamentos_dados ed, marca
          WHERE ed.created_at > marca.ate - interval '5 minutes'
        ), apagados AS (
          DELETE FROM equipamentos_dados_dia d
          USING (SELECT DISTINCT equipamento_id,
                        ((timestamp_dados AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date AS dia
                 FROM recentes) novos
          WHERE d.equipamento_id = novos.equipamento_id AND d.dia = novos.dia
        )
        UPDATE equipamentos_dados_dia_marca m
        SET ate = GREATEST(m.ate, COALESCE((SELECT MAX(created_at) FROM recentes), m.ate))
        WHERE m.id = 1`;
      if (!n) this.logger.warn('Marca do resumo diário ausente (equipamentos_dados_dia_marca id=1)');
    } catch (e: any) {
      this.logger.warn(`Varredura do resumo diário falhou: ${e?.message ?? e}`);
    }
  }
}
