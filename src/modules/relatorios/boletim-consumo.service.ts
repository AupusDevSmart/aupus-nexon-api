import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService, PermissionScopeService, ScopedUser } from '@/core';
import { CalculoCustosService } from '../equipamentos-dados/services/calculo-custos.service';

/**
 * Payload do Relatório de Gestão de Energia (CONSUMO) POR UNIDADE. Reusa o
 * CalculoCustosService (consumo/custo por posto tarifário + demanda) e o M160
 * (demanda-série + qualidade V/I/FP). Fica no medidor da unidade
 * (configuracao_demanda.equipamentos_ids, ou o M160/Power Meter da unidade).
 *
 * Blocos REAIS: consumo/custo por posto, demanda máx/contratada, série de demanda,
 * qualidade (desequilíbrios + FP), eventos. Aproximados/placeholder (Fase 1.5):
 * tempo por posto (janela tarifária), FIC/DIC, acionamentos.
 */
@Injectable()
export class BoletimConsumoService {
  private readonly logger = new Logger(BoletimConsumoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: PermissionScopeService,
    private readonly custos: CalculoCustosService,
  ) {}

  private brDate(ymd: string): string {
    const [y, m, d] = ymd.split('-');
    return `${d}/${m}/${y}`;
  }
  private horas(dec: number): string {
    const h = Math.floor(dec);
    const min = Math.round((dec - h) * 60);
    return `${h}h ${String(min).padStart(2, '0')}m`;
  }
  private num(v: any): number {
    return Math.round((Number(v) || 0) * 10) / 10;
  }

  /**
   * Unidades ELEGÍVEIS ao relatório de consumo: têm medidor (M160/Power Meter) que JÁ reportou
   * alguma vez. Inclui usina OFF no momento (só exige histórico, não feed recente) — o dono
   * pediu que off temporário apareça na lista. Retorna `ultima` (última leitura) p/ a UI marcar
   * online/offline. Owner-scoped.
   */
  async listarUnidadesElegiveis(user?: ScopedUser): Promise<Array<{ id: string; nome: string; planta_id: string; ultima: Date | null }>> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; nome: string; planta_id: string; ultima: Date | null }>>`
      SELECT TRIM(u.id) AS id, TRIM(u.nome) AS nome, TRIM(u.planta_id) AS planta_id, MAX(m.ultima) AS ultima
      FROM unidades u
      JOIN equipamentos e ON TRIM(e.unidade_id) = TRIM(u.id)
      JOIN LATERAL (SELECT MAX(timestamp_dados) AS ultima FROM equipamentos_dados WHERE equipamento_id = e.id) m ON TRUE
      WHERE u.deleted_at IS NULL AND e.deleted_at IS NULL AND e.mqtt_habilitado = true
        AND (e.tipo_equipamento ILIKE '%METER%' OR e.tipo_equipamento ILIKE '%M160%' OR e.tipo_equipamento ILIKE '%M-160%'
             OR e.tipo_equipamento ILIKE '%medidor%' OR e.nome ILIKE '%power meter%' OR e.nome ILIKE '%medidor%' OR e.nome ILIKE '%m160%')
        AND m.ultima IS NOT NULL
      GROUP BY 1, 2, 3
      ORDER BY nome`;
    if (!user) return rows;
    const escopo = await this.scope.getScope(user);
    if (!this.scope.isScoped(escopo)) return rows;
    return rows.filter((r) => escopo.includes(r.planta_id));
  }

  async montarPayload(unidadeId: string, dataRef?: string, user?: ScopedUser): Promise<any> {
    const uid = (unidadeId || '').trim();
    if (user) {
      const escopo = await this.scope.getScope(user);
      if (this.scope.isScoped(escopo)) {
        const pr = await this.prisma.$queryRaw<Array<{ pid: string }>>`
          SELECT TRIM(planta_id) AS pid FROM unidades WHERE TRIM(id) = ${uid} LIMIT 1`;
        const pid = pr[0]?.pid;
        if (!pid || !escopo.includes(pid)) throw new ForbiddenException('Unidade fora do escopo');
      }
    }

    const refDate =
      dataRef ||
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const win = await this.prisma.$queryRaw<Array<{ s_ini: string; s_fim: string; m_ini: string; m_fim: string }>>`
      SELECT to_char(date_trunc('week', ${refDate}::date) - interval '7 days', 'YYYY-MM-DD') AS s_ini,
             to_char(date_trunc('week', ${refDate}::date) - interval '1 day',  'YYYY-MM-DD') AS s_fim,
             to_char(date_trunc('month', date_trunc('week', ${refDate}::date) - interval '1 day'), 'YYYY-MM-DD') AS m_ini,
             to_char(date_trunc('week', ${refDate}::date) - interval '1 day',  'YYYY-MM-DD') AS m_fim`;
    const { s_ini: sIni, s_fim: sFim, m_ini: mIni, m_fim: mFim } = win[0];

    const uRows = await this.prisma.$queryRaw<Array<{ nome: string }>>`
      SELECT TRIM(nome) AS nome FROM unidades WHERE TRIM(id) = ${uid} AND deleted_at IS NULL LIMIT 1`;
    if (!uRows.length) throw new NotFoundException('Unidade não encontrada');
    const unidadeNome = uRows[0].nome;

    // Medidor(es) da unidade: configuracao_demanda.equipamentos_ids, senão M160/Power Meter.
    const medidor = await this.acharMedidor(uid);
    if (!medidor) {
      throw new NotFoundException('Unidade sem medidor (M160/A966) — relatório de consumo não se aplica.');
    }

    const dSemIni = this.brtToUtcDate(sIni, 0);
    const dSemFim = this.brtToUtcDate(sFim, 1);
    const dMesIni = this.brtToUtcDate(mIni, 0);
    const dMesFim = this.brtToUtcDate(mFim, 1);

    const custoSemana = await this.custosSeguro(medidor.id, dSemIni, dSemFim);
    const custoMes = await this.custosSeguro(medidor.id, dMesIni, dMesFim);

    const ag = custoSemana?.agregacao ?? {};
    const cu = custoSemana?.custos ?? {};
    const demandaContratada = this.num(custoSemana?.unidade?.demanda_contratada) || (await this.demandaContratada(uid));

    // Postos tarifários (só os com consumo)
    const postosBrutos = [
      { nome: 'Fora de ponta', consumo_kwh: this.num(ag.energia_fora_ponta_kwh), custo: this.num(cu.custo_fora_ponta), horasSemana: 168 - 15 },
      { nome: 'Ponta', consumo_kwh: this.num(ag.energia_ponta_kwh), custo: this.num(cu.custo_ponta), horasSemana: 15 },
      { nome: 'Reservado', consumo_kwh: this.num(ag.energia_reservado_kwh), custo: this.num(cu.custo_reservado), horasSemana: 0 },
    ].filter((p) => p.consumo_kwh > 0 || p.custo > 0);
    const postos =
      postosBrutos.length > 0
        ? postosBrutos
        : [{ nome: 'Consumo', consumo_kwh: this.num(ag.energia_total_kwh), custo: this.num(cu.custo_total), horasSemana: 168 }];

    const postosPayload = postos.map((p) => ({
      nome: p.nome,
      consumo_kwh: p.consumo_kwh,
      tempo: this.horas(p.horasSemana), // aproximação: janela tarifária da semana (Fase 1.5)
      tempo_horas: p.horasSemana,
      custo: Math.round(p.custo * 100) / 100,
      acionamentos: 0, // pendente (contagem por posto)
    }));

    const consumoTotal = this.num(ag.energia_total_kwh) || postos.reduce((s, p) => s + p.consumo_kwh, 0);
    const demandaMaxSemana = this.num(ag.demanda_maxima_kw);

    const leiturasSemana = await this.leiturasPeriodo(medidor.id, dSemIni, dSemFim);
    const serie = this.serieDe(leiturasSemana);
    const maiorRegistrada = serie.length ? Math.max(...serie.map((p) => p.valor)) : demandaMaxSemana;
    const dispSemana = this.analisarDisponibilidade(leiturasSemana.map((l) => l.ts), dSemIni, dSemFim);
    const tsMes = await this.timestampsPeriodo(medidor.id, dMesIni, dMesFim);
    const dispMes = this.analisarDisponibilidade(tsMes, dMesIni, dMesFim);
    const qualidade = await this.qualidade(medidor.id);
    const eventos = await this.eventos(uid, sIni, sFim);
    const consumoMes = this.num(custoMes?.agregacao?.energia_total_kwh);

    const pctPonta = consumoTotal ? (this.num(ag.energia_ponta_kwh) / consumoTotal) * 100 : 0;
    const oportunidade =
      pctPonta > 5
        ? {
            titulo: 'Oportunidade de economia',
            texto: `${this.num(pctPonta).toFixed(1)}% do consumo da semana ocorreu na ponta. Deslocar parte dessa carga para fora de ponta reduz o custo.`,
            valor: Math.round(this.num(cu.custo_ponta) * 0.3 * 100) / 100,
          }
        : null;

    const geradoEm = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date());

    return {
      unidade: { nome: unidadeNome, ponto: medidor.nome },
      periodo: {
        inicio: this.brDate(sIni),
        fim: this.brDate(sFim),
        gerado_em: geradoEm,
        referencia_demanda: `${this.brDate(mIni)} a ${this.brDate(mFim)}`,
      },
      semana: {
        consumo_kwh: Math.round(consumoTotal),
        disponibilidade: dispSemana.disponibilidade, // uptime de MEDIÇÃO (gaps de leitura), não SAIDI/SAIFI da concessionária
        fic: dispSemana.fic,
        dic: dispSemana.dic,
        demanda_maxima_kw: Math.round(maiorRegistrada || demandaMaxSemana),
        qualidade_tensao: { classificacao: qualidade.classificacaoTensao },
      },
      metas: {},
      mes: { consumo_kwh: Math.round(consumoMes), disponibilidade: dispMes.disponibilidade, fic: dispMes.fic, dic: dispMes.dic },
      postos: postosPayload,
      funcionamento: {
        tempo_total: this.horas(postos.reduce((s, p) => s + p.horasSemana, 0)),
        media_diaria: this.horas(postos.reduce((s, p) => s + p.horasSemana, 0) / 7),
        dias: 7,
      },
      demanda: {
        contratada_kw: Math.round(demandaContratada),
        serie,
        maior_registrada_kw: Math.round(maiorRegistrada),
        data_pico: serie.find((p) => p.valor === maiorRegistrada)?.rotulo || this.brDate(sFim),
        permanencia_pico: '—',
        ultrapassagens: serie.filter((p) => p.valor > demandaContratada).length,
      },
      qualidade: { indicadores: qualidade.indicadores, fator_potencia: qualidade.fatorPotencia },
      eventos,
      oportunidade,
    };
  }

  // BRT-as-UTC literal (mesma convenção do controller de custos: banco guarda BRT sem tz).
  private brtToUtcDate(ymd: string, fim: 0 | 1): Date {
    const [y, m, d] = ymd.split('-').map(Number);
    return fim
      ? new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999))
      : new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
  }

  private async acharMedidor(uid: string): Promise<{ id: string; nome: string } | null> {
    // 1) configuracao_demanda.equipamentos_ids (primeiro)
    try {
      const cfg = await this.prisma.$queryRaw<Array<{ ids: any }>>`
        SELECT equipamentos_ids AS ids FROM configuracao_demanda WHERE TRIM(unidade_id) = ${uid} LIMIT 1`;
      const ids = cfg[0]?.ids;
      const arr: string[] = Array.isArray(ids) ? ids : typeof ids === 'string' ? JSON.parse(ids || '[]') : [];
      if (arr.length) {
        const eq = await this.prisma.$queryRaw<Array<{ id: string; nome: string }>>`
          SELECT TRIM(id) AS id, TRIM(nome) AS nome FROM equipamentos WHERE TRIM(id) = ${String(arr[0]).trim()} AND deleted_at IS NULL LIMIT 1`;
        if (eq.length) return eq[0];
      }
    } catch (e) {
      this.logger.warn(`[consumo] configuracao_demanda falhou: ${e instanceof Error ? e.message : e}`);
    }
    // 2) M160 / Power Meter da unidade com feed
    const eq = await this.prisma.$queryRaw<Array<{ id: string; nome: string }>>`
      SELECT TRIM(e.id) AS id, TRIM(e.nome) AS nome FROM equipamentos e
      WHERE TRIM(e.unidade_id) = ${uid} AND e.deleted_at IS NULL AND e.mqtt_habilitado = true
        AND (e.tipo_equipamento ILIKE '%METER%' OR e.tipo_equipamento ILIKE '%M160%' OR e.tipo_equipamento ILIKE '%M-160%'
             OR e.tipo_equipamento ILIKE '%medidor%' OR e.nome ILIKE '%power meter%' OR e.nome ILIKE '%medidor%' OR e.nome ILIKE '%m160%')
        AND EXISTS (SELECT 1 FROM equipamentos_dados ed WHERE ed.equipamento_id = e.id)
      ORDER BY (SELECT MAX(ed.timestamp_dados) FROM equipamentos_dados ed WHERE ed.equipamento_id = e.id) DESC NULLS LAST, e.nome
      LIMIT 1`;
    return eq[0] ?? null;
  }

  private async demandaContratada(uid: string): Promise<number> {
    const r = await this.prisma.$queryRaw<Array<{ v: number }>>`
      SELECT COALESCE(valor_contratado, 0)::float8 AS v FROM configuracao_demanda WHERE TRIM(unidade_id) = ${uid} LIMIT 1`;
    return this.num(r[0]?.v);
  }

  private async custosSeguro(medidorId: string, ini: Date, fim: Date): Promise<any> {
    try {
      return await this.custos.calcularCustos(medidorId, ini, fim, 'custom');
    } catch (e) {
      this.logger.warn(`[consumo] calcularCustos falhou (${medidorId}): ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  // Prisma model (respeita índice no char equipamento_id, ao contrário de TRIM() em raw).
  private async leiturasPeriodo(medidorId: string, ini: Date, fim: Date): Promise<Array<{ ts: Date; pot: number }>> {
    const rows = await this.prisma.equipamentos_dados.findMany({
      where: { equipamento_id: medidorId, timestamp_dados: { gte: ini, lte: fim } },
      select: { timestamp_dados: true, potencia_ativa_kw: true },
      orderBy: { timestamp_dados: 'asc' },
    });
    return rows.map((r) => ({ ts: r.timestamp_dados as Date, pot: Number(r.potencia_ativa_kw) || 0 }));
  }

  private async timestampsPeriodo(medidorId: string, ini: Date, fim: Date): Promise<Date[]> {
    const rows = await this.prisma.equipamentos_dados.findMany({
      where: { equipamento_id: medidorId, timestamp_dados: { gte: ini, lte: fim } },
      select: { timestamp_dados: true },
      orderBy: { timestamp_dados: 'asc' },
    });
    return rows.map((r) => r.timestamp_dados as Date);
  }

  // Demanda máxima diária (rótulo DD/MM em BRT — ts gravado como UTC, getters UTC = dia BRT).
  private serieDe(leituras: Array<{ ts: Date; pot: number }>): Array<{ rotulo: string; valor: number }> {
    const perDay = new Map<string, number>();
    for (const l of leituras) {
      const key = `${String(l.ts.getUTCDate()).padStart(2, '0')}/${String(l.ts.getUTCMonth() + 1).padStart(2, '0')}`;
      perDay.set(key, Math.max(perDay.get(key) ?? 0, l.pot));
    }
    return [...perDay.entries()].map(([rotulo, valor]) => ({ rotulo, valor: Math.round(valor) }));
  }

  private horasMin(min: number): string {
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m`;
  }

  /**
   * Disponibilidade de MEDIÇÃO: fração do período em que o medidor esteve reportando.
   * Um "gap" acima de max(30min, 3× intervalo mediano) conta como interrupção (FIC) e
   * soma sua duração (DIC). Não é o SAIDI/SAIFI oficial da concessionária — é o que dá
   * pra apurar da telemetria; a UI rotula como aproximação.
   */
  private analisarDisponibilidade(ts: Date[], ini: Date, fim: Date): { disponibilidade: number; fic: number; dic: string } {
    const totalMin = (fim.getTime() - ini.getTime()) / 60000;
    if (!ts.length) return { disponibilidade: 0, fic: 1, dic: this.horasMin(totalMin) };
    const sorted = ts.map((t) => t.getTime()).sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i] - sorted[i - 1]);
    gaps.sort((a, b) => a - b);
    const mediano = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 15 * 60000;
    const limite = Math.max(30 * 60000, 3 * mediano);
    const pts = [ini.getTime(), ...sorted, fim.getTime()];
    let dicMs = 0;
    let fic = 0;
    for (let i = 1; i < pts.length; i++) {
      const g = pts[i] - pts[i - 1];
      if (g > limite) {
        dicMs += g;
        fic++;
      }
    }
    const dicMin = dicMs / 60000;
    const disp = Math.max(0, Math.min(100, ((totalMin - dicMin) / totalMin) * 100));
    return { disponibilidade: Math.round(disp * 100) / 100, fic, dic: this.horasMin(dicMin) };
  }

  private async qualidade(medidorId: string): Promise<any> {
    const row = await this.prisma.equipamentos_dados.findFirst({
      where: { equipamento_id: medidorId },
      orderBy: { timestamp_dados: 'desc' },
      select: { dados: true },
    });
    const d = (row?.dados as any) ?? {};
    const dev = (a: number, b: number, c: number) => {
      const m = (a + b + c) / 3;
      return m ? (Math.max(Math.abs(a - m), Math.abs(b - m), Math.abs(c - m)) / m) * 100 : 0;
    };
    const desV = dev(Number(d.Va) || 0, Number(d.Vb) || 0, Number(d.Vc) || 0);
    const desI = dev(Number(d.Ia) || 0, Number(d.Ib) || 0, Number(d.Ic) || 0);
    const fps = [d.FPa, d.FPb, d.FPc].map(Number).filter((v) => !isNaN(v) && v > 0);
    const fpMed = fps.length ? fps.reduce((s, v) => s + v, 0) / fps.length : 0;
    const fpMin = fps.length ? Math.min(...fps) : 0;
    const fpMax = fps.length ? Math.max(...fps) : 0;
    const tipo = (fp: number) => (fp >= 0.98 ? 'unitário' : 'indutivo');
    const okFp = (fp: number) => (fp >= 0.92 ? 'ok' : 'atencao');

    const indicadores = [];
    if (d.Va != null) indicadores.push({ indicador: 'Desequilíbrio de tensão (V)', valor: `${desV.toFixed(2)}%`, limite: '≤ 2%', status: desV <= 2 ? 'ok' : 'atencao' });
    if (d.Ia != null) indicadores.push({ indicador: 'Desequilíbrio de corrente (I)', valor: `${desI.toFixed(2)}%`, limite: '≤ 10%', status: desI <= 10 ? 'ok' : 'atencao' });
    if (fps.length) {
      indicadores.push({ indicador: 'Fator de potência máximo', valor: `${fpMax.toFixed(2)}`, limite: '—', status: 'ok' });
      indicadores.push({ indicador: 'Fator de potência mínimo', valor: `${fpMin.toFixed(2)}`, limite: '≥ 0,92', status: okFp(fpMin) });
      indicadores.push({ indicador: 'Fator de potência médio', valor: `${fpMed.toFixed(2)}`, limite: '≥ 0,92', status: okFp(fpMed) });
    }

    return {
      classificacaoTensao: desV <= 2 ? 'Adequada' : 'Precária',
      indicadores: indicadores.length ? indicadores : [{ indicador: 'Sem leitura de qualidade', valor: '—', limite: '—', status: 'atencao' }],
      fatorPotencia: {
        medio: Math.round(fpMed * 100) / 100,
        tipo_medio: tipo(fpMed),
        minimo: Math.round(fpMin * 100) / 100,
        maximo: Math.round(fpMax * 100) / 100,
        limite: 0.92,
      },
    };
  }

  private async eventos(uid: string, sIni: string, sFim: string): Promise<Array<{ evento: string; qtd: number; severidade: string }>> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ tipo: string; qtd: number; sev: string }>>`
        SELECT COALESCE(NULLIF(TRIM(r.nome), ''), 'Alarme') AS tipo, COUNT(*)::int AS qtd,
               MAX(UPPER(COALESCE(l.severidade, ''))) AS sev
        FROM logs_mqtt l
        JOIN equipamentos e ON e.id = l.equipamento_id
        LEFT JOIN regras_logs_mqtt r ON r.id = l.regra_id
        WHERE TRIM(e.unidade_id) = ${uid} AND l.tipo = 'alerta'
          AND l.created_at >= ${sIni}::date AND l.created_at < (${sFim}::date + 1)
        GROUP BY 1 ORDER BY 2 DESC LIMIT 6`;
      return rows.map((r) => ({ evento: r.tipo, qtd: Number(r.qtd), severidade: r.sev === 'CRITICA' ? 'alta' : 'media' }));
    } catch (e) {
      this.logger.warn(`[consumo] eventos falhou: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }
}
