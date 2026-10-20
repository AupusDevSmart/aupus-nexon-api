import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/core';
import { GeracaoConfigService } from '../geracao-analise/geracao-config.service';
import { janelaOuPadrao, PONTA_PADRAO } from '../pivos/pivo-config.util';
import { ContextoRelatorio, RelatorioBaseService } from './relatorio-base.service';
import { Bloco, energiaPorPosto } from './calc/consumo';
import { arred, disponibilidadePct, Intervalo } from './calc/disponibilidade';
import { contarChamados } from './calc/chamados';
import {
  classificarParada,
  horasDe,
  JanelaPonta,
  laminaAplicadaMm,
  laminaProgramadaMm,
  limiarOperacao,
  ProgramacaoPivo,
  Segmento,
  segmentosNaSemana,
  segmentosOperando,
  voltasPorVelocidade,
} from './calc/pivo-operacao';
import { diasDe, inicioDoDia, isoBrt, semanaDaLinhaDoTempo, somarDias } from './calc/periodo';
import type { LinhaPivo, OcorrenciaIrrigacao, RelatorioIrrigacao } from './relatorios-operacao.tipos';

interface ConfigPivo {
  id: string;
  parametros: Record<string, unknown> | null;
  bloqueio_ponta: unknown;
  motobomba_equipamento_id: string | null;
}

interface Sequencia {
  equipamento_id: string;
  acao: string;
  status: string;
  erro: string | null;
  irrigacao: { config?: { percentual?: unknown } } | null;
  created_at: Date;
  finished_at: Date | null;
}

const numOuNull = (v: unknown): number | null => {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n;
};

/**
 * Relatório de irrigação (pivôs). Operação do pivô sai da medição de energia do Power Meter
 * do disjuntor que o alimenta (vínculo do IoT) — ver calc/pivo-operacao.ts. Comandos e
 * irrigações enviadas pelo NexON (pivo_sequencias, trilha em logs_mqtt) explicam as paradas.
 */
@Injectable()
export class IrrigacaoRelatorioService {
  private readonly logger = new Logger(IrrigacaoRelatorioService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly base: RelatorioBaseService,
    private readonly configs: GeracaoConfigService,
  ) {}

  async gerar(ctx: ContextoRelatorio): Promise<RelatorioIrrigacao> {
    const { periodo, unidade } = ctx;
    const ini = periodo.inicio.getTime();
    const fim = periodo.fim.getTime();
    const pivos = ctx.equipamentos;
    const ids = pivos.map((p) => p.id);

    const [configs, programacoes, fontes, tecnicos, sequencias, comandos, chamados] = await Promise.all([
      this.lerConfigs(ids),
      this.programacoes(ids),
      this.base.fontesDeMedicao(unidade.id),
      this.dadosTecnicos(ids),
      this.sequencias(ids, periodo.inicio, periodo.fim),
      this.comandos(ids, periodo.inicio, periodo.fim),
      this.base.chamados(ctx),
    ]);

    // Fonte de medição de cada pivô: PM do disjuntor ligado a ele; senão o da motobomba
    // exclusiva (motobomba de 2+ pivôs mede o conjunto e não serve para um pivô só).
    const usoMotobomba = new Map<string, number>();
    for (const c of configs.values()) if (c.motobomba_equipamento_id) usoMotobomba.set(c.motobomba_equipamento_id, (usoMotobomba.get(c.motobomba_equipamento_id) ?? 0) + 1);
    const fonteDe = new Map<string, string>();
    for (const p of pivos) {
      const direta = fontes.find((f) => f.carga_id === p.id);
      const mb = configs.get(p.id)?.motobomba_equipamento_id ?? null;
      const daMotobomba = mb && usoMotobomba.get(mb) === 1 ? fontes.find((f) => f.carga_id === mb) : undefined;
      const f = direta ?? daMotobomba;
      if (f) fonteDe.set(p.id, f.fonte_id);
    }

    const blocosDe = new Map<string, Bloco[]>();
    await Promise.all(
      [...new Set(fonteDe.values())].map(async (fid) => {
        blocosDe.set(fid, await this.base.blocos(fid, periodo.inicio, periodo.fim).catch(() => []));
      }),
    );

    const fonteIds = [...new Set(fonteDe.values())];
    const alvosCom = [...pivos.map((p) => ({ id: p.id, nome: p.nome }))];
    for (const f of fontes) if (fonteIds.includes(f.fonte_id)) alvosCom.push({ id: f.fonte_id, nome: f.fonte_nome ?? f.dj_nome });
    const [semCom, alertas] = await Promise.all([this.base.semComunicacao(ctx, alvosCom), this.base.alertas([...ids, ...fonteIds], periodo.inicio, periodo.fim)]);

    const dias = diasDe(periodo.diaInicio, periodo.diaFim);
    const semana = semanaDaLinhaDoTempo(periodo);
    const semanaIni = inicioDoDia(semana).getTime();
    const ponta = this.janelaPonta(configs.get(ids[0])?.bloqueio_ponta);

    const linhas: LinhaPivo[] = [];
    const ocorrencias: OcorrenciaIrrigacao[] = [];
    const linhaTempo: Array<{ nome: string; segmentos: Array<{ inicioH: number; fimH: number }>; paradasH: number[] }> = [];
    let algumaFonte = false;

    for (const p of pivos) {
      const cfg = configs.get(p.id);
      const par = cfg?.parametros ?? {};
      const lamina100 = numOuNull(par.lamina_100);
      const tv100 = numOuNull(par.tempo_volta_100);
      const fid = fonteDe.get(p.id) ?? null;
      const blocos = fid ? (blocosDe.get(fid) ?? []) : [];
      const temMedicao = blocos.length > 0;
      if (temMedicao) algumaFonte = true;

      const segs: Segmento[] = temMedicao ? segmentosOperando(blocos.map((b) => ({ t: b.t, kw: b.kWc })), limiarOperacao(blocos.map((b) => b.kWc))) : [];
      const horas = horasDe(segs, ini, fim);
      const cmds = [...(comandos.get(p.id) ?? []), ...(sequencias.get(p.id) ?? []).flatMap((s) => [new Date(s.created_at).getTime(), s.finished_at ? new Date(s.finished_at).getTime() : NaN])].filter(Number.isFinite);
      const pontaPivo = this.janelaPonta(cfg?.bloqueio_ponta);

      let paradas = 0;
      const paradasSemana: number[] = [];
      segs.forEach((s, i) => {
        if (s.termino !== 'parada' || s.fim < ini || s.fim >= fim) return;
        const motivo = classificarParada(s.fim, cmds, pontaPivo);
        if (motivo === 'comando') return;
        const prox = segs[i + 1]?.ini ?? fim;
        const duracaoMin = Math.max(0, Math.round((Math.min(prox, fim) - s.fim) / 60_000));
        if (motivo === 'nao_programada') {
          paradas++;
          const h = (s.fim - semanaIni) / 3_600_000;
          if (h >= 0 && h <= 168) paradasSemana.push(arred(h, 2));
        }
        ocorrencias.push({
          inicio: isoBrt(s.fim) as string,
          pivo: p.nome,
          motivo: motivo === 'ponta' ? 'Bloqueio de ponta (programado)' : this.motivoParada(s.fim, alertas, [p.id, fid]),
          duracaoMin,
          mmPerdidos: null,
          problema: motivo === 'nao_programada',
        });
      });

      // Velocidade de cada trecho: a da irrigação enviada pelo NexON que estava valendo.
      const seqs = (sequencias.get(p.id) ?? []).slice().sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      const trechos = segs
        .filter((s) => s.fim > ini && s.ini < fim)
        .map((s) => {
          const vigente = [...seqs].reverse().find((q) => new Date(q.created_at).getTime() <= s.ini + 15 * 60_000);
          const pct = vigente && vigente.acao !== 'desligar' ? numOuNull(vigente.irrigacao?.config?.percentual) : null;
          return { horas: horasDe([s], ini, fim), pct };
        });

      const indisponivel: Intervalo[] = [...(semCom.get(p.id) ?? []), ...(fid ? (semCom.get(fid) ?? []) : [])];
      linhas.push({
        equipamentoId: p.id,
        nome: p.nome,
        areaHa: tecnicos.get(p.id)?.area ?? null,
        cultura: tecnicos.get(p.id)?.cultura ?? null,
        voltas: temMedicao ? voltasPorVelocidade(trechos, tv100) : null,
        laminaMm: temMedicao ? laminaAplicadaMm(horas, lamina100, tv100) : null,
        programadoMm: laminaProgramadaMm(programacoes.get(p.id) ?? [], dias, lamina100, tv100),
        horas: arred(horas, 1),
        kwh: temMedicao ? arred(blocos.reduce((s, b) => s + Math.max(0, b.kWc) * 0.25, 0), 1) : null,
        paradas,
        disponibilidadePct: fid ? disponibilidadePct(indisponivel, ini, fim) : null,
        chamados: contarChamados(chamados.linhas, [p.id, ...(fid ? [fid] : [])], ini, fim),
      });
      linhaTempo.push({ nome: p.nome, segmentos: segmentosNaSemana(segs, semanaIni), paradasH: paradasSemana });

      // Alarmes do pivô e do medidor dele (comunicação e regras) e falhas de acionamento.
      for (const a of alertas.filter((x) => x.equipamento_id === p.id || x.equipamento_id === fid)) {
        const comeco = a.origem === 'comunicacao' && a.desde ? Date.parse(a.desde) : new Date(a.created_at).getTime();
        const termino = a.volta_em ? Date.parse(a.volta_em) : a.resolvido_em ? new Date(a.resolvido_em).getTime() : fim;
        ocorrencias.push({
          inicio: isoBrt(Math.max(comeco, ini)) as string,
          pivo: p.nome,
          motivo: a.origem === 'comunicacao' ? 'Sem comunicação' : (a.regra || a.mensagem || 'Alarme'),
          duracaoMin: Math.max(0, Math.round((Math.min(termino, fim) - Math.max(comeco, ini)) / 60_000)),
          mmPerdidos: null,
          problema: true,
        });
      }
      for (const s of seqs.filter((q) => q.status === 'falhou')) {
        const t0 = new Date(s.created_at).getTime();
        ocorrencias.push({
          inicio: isoBrt(t0) as string,
          pivo: p.nome,
          motivo: `Falha no acionamento${s.erro ? `: ${String(s.erro).slice(0, 120)}` : ''}`,
          duracaoMin: s.finished_at ? Math.max(0, Math.round((new Date(s.finished_at).getTime() - t0) / 60_000)) : 0,
          mmPerdidos: null,
          problema: true,
        });
      }
    }

    // Energia por posto (soma dos medidores dos pivôs) e tarifa de referência.
    const todosBlocos = [...blocosDe.values()].flat();
    const porPosto = todosBlocos.length ? energiaPorPosto(todosBlocos, this.base.classificadorDePosto(unidade)) : null;
    const tarifaKwh = await this.tarifa(ctx, ids);
    const areas = linhas.map((l) => l.areaHa).filter((x): x is number => x !== null);

    const fimSemana = Math.min(semanaIni + 168 * 3_600_000, fim);
    return {
      cabecalho: this.base.cabecalho(ctx),
      safra: null,
      areaHa: areas.length ? arred(areas.reduce((s, x) => s + x, 0), 1) : null,
      tarifaKwh,
      linhas,
      energiaPorPosto: porPosto,
      linhaDoTempo: algumaFonte
        ? {
            inicio: semana,
            dias: Array.from({ length: 7 }, (_, i) => somarDias(semana, i)).map((d) => ({ data: d, temPonta: this.base.ehDiaUtil(d) })),
            pontaInicioH: this.horaDecimal(ponta?.inicio ?? PONTA_PADRAO.inicio),
            pontaFimH: this.horaDecimal(ponta?.fim ?? PONTA_PADRAO.fim),
            pivos: linhaTempo.map((l) => ({ ...l, segmentos: l.segmentos.filter((s) => s.inicioH < (fimSemana - semanaIni) / 3_600_000) })),
          }
        : null,
      // Lâmina por setor exige o ângulo do pivô no histórico, que o NexON não recebe.
      setores: null,
      ocorrencias: ocorrencias.sort((a, b) => a.inicio.localeCompare(b.inicio)).slice(0, 200),
      chamados: chamados.bloco,
    };
  }

  private horaDecimal(hhmm: string): number {
    const [h, m] = hhmm.split(':').map(Number);
    return arred(h + (m || 0) / 60, 2);
  }

  private janelaPonta(gravado: unknown): JanelaPonta | null {
    const j = janelaOuPadrao(gravado, PONTA_PADRAO);
    return { ativo: j.ativo, inicio: j.inicio, fim: j.fim, dias: j.dias };
  }

  /** Motivo de uma parada fora de comando: alarme do pivô/medidor 30 min em volta, ou genérico. */
  private motivoParada(t: number, alertas: Array<{ equipamento_id: string; created_at: Date; regra: string | null; mensagem: string | null; origem: string | null }>, ids: Array<string | null>): string {
    const perto = alertas.find((a) => ids.includes(a.equipamento_id) && a.origem !== 'comunicacao' && Math.abs(new Date(a.created_at).getTime() - t) <= 30 * 60_000);
    return perto ? perto.regra || perto.mensagem || 'Alarme' : 'Parada sem comando';
  }

  /** R$/kWh: usuário que vê R$ nos pivôs e tarifa da concessionária da instalação. */
  private async tarifa(ctx: ContextoRelatorio, ids: string[]): Promise<number | null> {
    if (!(await this.base.podeVerValores(ids, ctx.user))) return null;
    try {
      const u = await this.configs.unidade(ctx.unidade.id);
      const t = await this.configs.tarifa(u, ids.map((id) => ({ id, nome: '', potenciaKw: null })), null);
      return t !== null ? Math.round(t * 10000) / 10000 : null;
    } catch (e) {
      this.logger.warn(`[irrigacao] tarifa: ${(e as Error)?.message}`);
      return null;
    }
  }

  // ───────────────────────── Leituras ─────────────────────────

  private async lerConfigs(ids: string[]): Promise<Map<string, ConfigPivo>> {
    try {
      const rows = await this.prisma.$queryRaw<ConfigPivo[]>`
        SELECT TRIM(equipamento_id) AS id, parametros, bloqueio_ponta, TRIM(motobomba_equipamento_id) AS motobomba_equipamento_id
        FROM pivo_config WHERE equipamento_id = ANY(${ids}::bpchar[])`;
      return new Map(rows.map((r) => [r.id, r]));
    } catch (e) {
      this.logger.warn(`[irrigacao] pivo_config: ${(e as Error)?.message}`);
      return new Map();
    }
  }

  private async programacoes(ids: string[]): Promise<Map<string, ProgramacaoPivo[]>> {
    const out = new Map<string, ProgramacaoPivo[]>();
    try {
      const rows = await this.prisma.$queryRaw<Array<ProgramacaoPivo & { id: string }>>`
        SELECT TRIM(equipamento_id) AS id, ativo, dias, modo, angulo_inicial::float8 AS angulo_inicial,
               angulo_final::float8 AS angulo_final, duracao_min, sentido, velocidade::float8 AS velocidade, com_agua
        FROM pivo_programacoes WHERE equipamento_id = ANY(${ids}::bpchar[]) AND deleted_at IS NULL`;
      for (const r of rows) out.set(r.id, [...(out.get(r.id) ?? []), { ...r, dias: (r.dias ?? []).map(Number) }]);
    } catch (e) {
      this.logger.warn(`[irrigacao] pivo_programacoes: ${(e as Error)?.message}`);
    }
    return out;
  }

  private async sequencias(ids: string[], ini: Date, fim: Date): Promise<Map<string, Sequencia[]>> {
    const out = new Map<string, Sequencia[]>();
    try {
      // Pega também a última de antes do período (a irrigação que já vinha rodando).
      const rows = await this.prisma.$queryRaw<Sequencia[]>`
        SELECT TRIM(equipamento_id) AS equipamento_id, acao, status, erro, irrigacao, created_at, finished_at
        FROM pivo_sequencias
        WHERE equipamento_id = ANY(${ids}::bpchar[]) AND status NOT IN ('agendada', 'cancelada')
          AND created_at < ${fim} AND created_at >= ${new Date(ini.getTime() - 7 * 86_400_000)}
        ORDER BY created_at`;
      for (const r of rows) out.set(r.equipamento_id, [...(out.get(r.equipamento_id) ?? []), r]);
    } catch (e) {
      this.logger.warn(`[irrigacao] pivo_sequencias: ${(e as Error)?.message}`);
    }
    return out;
  }

  /** Instantes de comando enviados ao pivô (trilha de comando em logs_mqtt). */
  private async comandos(ids: string[], ini: Date, fim: Date): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    const rows = await this.prisma.$queryRaw<Array<{ id: string; t: Date }>>`
      SELECT TRIM(equipamento_id) AS id, created_at AS t FROM logs_mqtt
      WHERE tipo = 'comando' AND equipamento_id = ANY(${ids}::bpchar[])
        AND created_at >= ${new Date(ini.getTime() - 3_600_000)} AND created_at < ${fim}`;
    for (const r of rows) out.set(r.id, [...(out.get(r.id) ?? []), new Date(r.t).getTime()]);
    return out;
  }

  /** Área (ha) e cultura cadastradas nos dados técnicos do pivô (campos area*, cultura*). */
  private async dadosTecnicos(ids: string[]): Promise<Map<string, { area: number | null; cultura: string | null }>> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; campo: string; valor: string | null }>>`
      SELECT TRIM(equipamento_id) AS id, lower(campo) AS campo, valor FROM equipamentos_dados_tecnicos
      WHERE equipamento_id = ANY(${ids}::bpchar[]) AND (lower(campo) LIKE 'area%' OR lower(campo) LIKE 'área%' OR lower(campo) LIKE 'cultura%')`;
    const out = new Map<string, { area: number | null; cultura: string | null }>();
    for (const r of rows) {
      const cur = out.get(r.id) ?? { area: null, cultura: null };
      if (r.campo.startsWith('cultura')) cur.cultura = r.valor?.trim() || cur.cultura;
      else {
        const n = numOuNull(String(r.valor ?? '').replace(',', '.'));
        if (n !== null && n > 0) cur.area = n;
      }
      out.set(r.id, cur);
    }
    return out;
  }
}
