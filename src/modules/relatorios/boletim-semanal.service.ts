import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService, PermissionScopeService, ScopedUser } from '@aupus/api-shared';

/**
 * Monta o PAYLOAD do boletim semanal (contrato de bdo_semanal/dados_exemplo.json) a
 * partir dos dados reais. Regra do dono: DATA-DRIVEN — bloco/campo sem dado vem `null`
 * e o template omite. Sem irradiância → "pr" é PROXY realizado/esperado. Sem histórico
 * de 2025 → `ano_anterior`/`serie.anterior` = null (o template esconde o comparativo anual).
 */
@Injectable()
export class BoletimSemanalService {
  private readonly logger = new Logger(BoletimSemanalService.name);
  private readonly DIAS_PT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: PermissionScopeService,
  ) {}

  private mwh(v: any): number {
    return Math.round(((Number(v) || 0) / 1000) * 10) / 10;
  }
  private pct(real: number, prev: number): number | null {
    return prev > 0 ? Math.round((real / prev) * 1000) / 10 : null;
  }
  private brDate(ymd: string): string {
    const [y, m, d] = ymd.split('-');
    return `${d}/${m}/${y}`;
  }

  /**
   * @param unidadeId  unidade alvo
   * @param dataRef    data de referência (YYYY-MM-DD); a semana é a ANTERIOR (seg→dom). Default: hoje (SP).
   */
  async montarPayload(unidadeId: string, dataRef?: string, user?: ScopedUser): Promise<any> {
    const uid = (unidadeId || '').trim();
    // Escopo por dono (regra de isolamento): a unidade tem que estar na planta do usuário.
    if (user) {
      const escopo = await this.scope.getScope(user);
      if (this.scope.isScoped(escopo)) {
        const pr = await this.prisma.$queryRaw<Array<{ pid: string }>>`
          SELECT TRIM(planta_id) AS pid FROM unidades WHERE TRIM(id) = ${uid} LIMIT 1
        `;
        const pid = pr[0]?.pid;
        if (!pid || !escopo.includes(pid)) throw new ForbiddenException('Unidade fora do escopo');
      }
    }

    const refDate =
      dataRef ||
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

    // Janela (semana anterior completa seg→dom + a semana antes dela), como strings YYYY-MM-DD.
    const win = await this.prisma.$queryRaw<Array<{ s_ini: string; s_fim: string; a_ini: string; a_fim: string }>>`
      SELECT to_char(date_trunc('week', ${refDate}::date) - interval '7 days',  'YYYY-MM-DD') AS s_ini,
             to_char(date_trunc('week', ${refDate}::date) - interval '1 day',   'YYYY-MM-DD') AS s_fim,
             to_char(date_trunc('week', ${refDate}::date) - interval '14 days', 'YYYY-MM-DD') AS a_ini,
             to_char(date_trunc('week', ${refDate}::date) - interval '8 days',  'YYYY-MM-DD') AS a_fim
    `;
    const { s_ini: sIni, s_fim: sFim, a_ini: aIni, a_fim: aFim } = win[0];

    const uRows = await this.prisma.$queryRaw<Array<{ nome: string; potencia: number }>>`
      SELECT TRIM(nome) AS nome, COALESCE(potencia, 0)::float8 AS potencia
      FROM unidades WHERE TRIM(id) = ${uid} AND deleted_at IS NULL LIMIT 1
    `;
    if (!uRows.length) throw new NotFoundException('Unidade não encontrada');
    const kwp = Number(uRows[0].potencia) || 0;

    // Agregados de geração (kWh) — semana, semana anterior, mês e ano do fim da semana.
    const g = await this.prisma.$queryRaw<Array<any>>`
      SELECT
        (SELECT SUM(kwh_realizado) FROM geracao_diaria_plantas WHERE TRIM(unidade_id)=${uid} AND data BETWEEN ${sIni}::date AND ${sFim}::date) AS sem_real,
        (SELECT SUM(kwh_previsto)  FROM geracao_diaria_plantas WHERE TRIM(unidade_id)=${uid} AND data BETWEEN ${sIni}::date AND ${sFim}::date) AS sem_prev,
        (SELECT SUM(kwh_realizado) FROM geracao_diaria_plantas WHERE TRIM(unidade_id)=${uid} AND data BETWEEN ${aIni}::date AND ${aFim}::date) AS ant_real,
        (SELECT SUM(kwh_previsto)  FROM geracao_diaria_plantas WHERE TRIM(unidade_id)=${uid} AND data BETWEEN ${aIni}::date AND ${aFim}::date) AS ant_prev,
        (SELECT SUM(kwh_realizado) FROM geracao_diaria_plantas WHERE TRIM(unidade_id)=${uid} AND date_trunc('month',data)=date_trunc('month',${sFim}::date)) AS mes_real,
        (SELECT SUM(kwh_realizado) FROM geracao_diaria_plantas WHERE TRIM(unidade_id)=${uid} AND date_trunc('year',data)=date_trunc('year',${sFim}::date)) AS ano_real,
        (SELECT SUM(kwh_previsto)  FROM geracao_diaria_plantas WHERE TRIM(unidade_id)=${uid} AND date_trunc('year',data)=date_trunc('year',${sFim}::date)) AS ano_prev
    `;
    const a = g[0];
    const semReal = this.mwh(a.sem_real), semPrev = this.mwh(a.sem_prev);
    const antReal = this.mwh(a.ant_real), antPrev = this.mwh(a.ant_prev);
    const mesReal = this.mwh(a.mes_real);
    const anoReal = this.mwh(a.ano_real), anoPrev = this.mwh(a.ano_prev);

    // Série diária (uma linha por dia com dado)
    const serieRows = await this.prisma.$queryRaw<Array<{ rotulo: string; dow: number; atual: number; esperado: number }>>`
      SELECT to_char(data,'DD/MM') AS rotulo, EXTRACT(DOW FROM data)::int AS dow,
             COALESCE(kwh_realizado,0)::float8 AS atual, COALESCE(kwh_previsto,0)::float8 AS esperado
      FROM geracao_diaria_plantas WHERE TRIM(unidade_id)=${uid} AND data BETWEEN ${sIni}::date AND ${sFim}::date ORDER BY data
    `;
    const serie_diaria = serieRows.map((r) => ({
      rotulo: r.rotulo,
      dia: this.DIAS_PT[Number(r.dow)] ?? '',
      atual: this.mwh(r.atual),
      esperado: this.mwh(r.esperado),
      anterior: null,
    }));

    const alarmeSemana = await this.contarAlarmes(uid, sIni, sFim);
    const alarmeAnterior = await this.contarAlarmes(uid, aIni, aFim);
    const tipos = await this.alarmesPorTipo(uid, sIni, sFim);

    const geradoEm = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const performanceMeta = 80;

    return {
      usina: { nome: uRows[0].nome, potencia_kwp: kwp },
      periodo: {
        inicio: this.brDate(sIni),
        fim: this.brDate(sFim),
        gerado_em: this.brDate(geradoEm),
        rotulo_ano_atual: sFim.slice(0, 4),
        rotulo_ano_anterior: null,
        janela_ano_atual: `01/01 a ${this.brDate(sFim)}`,
        janela_ano_anterior: null,
        janela_semana_anterior: `${this.brDate(aIni)} a ${this.brDate(aFim)}`,
      },
      metas: { performance: performanceMeta },
      semana: {
        geracao_mwh: semReal,
        esperada_mwh: semPrev,
        disponibilidade: null, // pendente (uptime do TON — Fase 1.5)
        pr: this.pct(semReal, semPrev), // "Performance" (proxy real/esperado)
        alarmes: alarmeSemana.total,
      },
      semana_anterior: {
        geracao_mwh: antReal,
        disponibilidade: null,
        pr: this.pct(antReal, antPrev),
        alarmes: alarmeAnterior.total,
      },
      acumulado: {
        mes_mwh: mesReal,
        ano_mwh: anoReal,
        disponibilidade: null,
        pr: this.pct(anoReal, anoPrev),
        alarmes: alarmeSemana.total,
      },
      ano_anterior: null, // sem 2025 → template esconde comparativo anual
      serie_diaria,
      alarmes_severidade: { criticos: alarmeSemana.criticos, nao_criticos: alarmeSemana.nao_criticos },
      alarmes_tipo: tipos,
      ocorrencias: {
        falhas_criticas: { qtd: alarmeSemana.criticos, detalhe: 'Alarmes críticos da semana' },
        falhas_nao_criticas: { qtd: alarmeSemana.nao_criticos, detalhe: 'Alarmes de monitoramento' },
        os_abertas: null,
        os_concluidas: null,
      },
      destaques: this.destaques(semReal, antReal, this.pct(semReal, semPrev), performanceMeta),
    };
  }

  private async contarAlarmes(uid: string, ini: string, fim: string) {
    const rows = await this.prisma.$queryRaw<Array<{ sev: string; qtd: number }>>`
      SELECT UPPER(COALESCE(l.severidade,'')) AS sev, COUNT(*)::int AS qtd
      FROM logs_mqtt l
      JOIN equipamentos e ON TRIM(e.id) = TRIM(l.equipamento_id)
      WHERE TRIM(e.unidade_id) = ${uid}
        AND l.tipo = 'alerta'
        AND l.created_at >= ${ini}::date AND l.created_at < (${fim}::date + 1)
      GROUP BY 1
    `;
    let criticos = 0, nao_criticos = 0;
    for (const r of rows) {
      if (r.sev === 'CRITICA' || r.sev === 'CRITICO') criticos += Number(r.qtd);
      else nao_criticos += Number(r.qtd);
    }
    return { criticos, nao_criticos, total: criticos + nao_criticos };
  }

  private async alarmesPorTipo(uid: string, ini: string, fim: string) {
    const rows = await this.prisma.$queryRaw<Array<{ tipo: string; qtd: number }>>`
      SELECT COALESCE(NULLIF(TRIM(r.nome), ''), 'Outros') AS tipo, COUNT(*)::int AS qtd
      FROM logs_mqtt l
      JOIN equipamentos e ON TRIM(e.id) = TRIM(l.equipamento_id)
      LEFT JOIN regras_logs_mqtt r ON TRIM(r.id) = TRIM(l.regra_id)
      WHERE TRIM(e.unidade_id) = ${uid}
        AND l.tipo = 'alerta'
        AND l.created_at >= ${ini}::date AND l.created_at < (${fim}::date + 1)
      GROUP BY 1 ORDER BY 2 DESC LIMIT 6
    `;
    return rows.map((r) => ({ tipo: r.tipo, qtd: Number(r.qtd) }));
  }

  private destaques(semReal: number, antReal: number, perf: number | null, metaPerf: number): string[] {
    const out: string[] = [];
    const varSem = antReal > 0 ? Math.round(((semReal - antReal) / antReal) * 1000) / 10 : null;
    if (varSem != null) {
      out.push(`Geração ${varSem >= 0 ? `${varSem}% acima` : `${Math.abs(varSem)}% abaixo`} da semana anterior.`);
    }
    if (perf != null) {
      out.push(perf >= metaPerf
        ? `Performance de ${perf}% — dentro do esperado.`
        : `Performance de ${perf}% — abaixo da referência de ${metaPerf}%.`);
    }
    if (!out.length) out.push('Sem base suficiente para destaques automáticos nesta semana.');
    return out;
  }
}
