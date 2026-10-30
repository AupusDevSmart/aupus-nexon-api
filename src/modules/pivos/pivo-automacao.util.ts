import { dentroDaJanela, JanelaComAtivo, MomentoLocal, parseHHMM } from '../../shared/util/janela-horario';

/**
 * Automação do pivô — lógica PURA, testada em pivo-automacao.util.spec.ts.
 *
 * O que vem da ficha web/app ("Irrigação avançada" e "Programação de horários") e o
 * servidor executa sozinho: início agendado, parada por voltas/tempo/percurso,
 * programação semanal e pausa/retomada no horário de ponta.
 */

export type Direcao = 'Avanço' | 'Reverso';
export interface FaixaCanhao { id?: string; liga: number; desliga: number }
export interface ConfigIrrigacao { direcao: Direcao; percentual: number; semAgua: boolean; canhao: boolean; faixasCanhao?: FaixaCanhao[] }
export type Parada = { tipo: 'semParar' } | { tipo: 'porAngulo'; angulo: number } | { tipo: 'porVoltas'; voltas: number } | { tipo: 'porTempo'; minutos: number };
export interface Irrigacao {
  modo: 'simples' | 'angulo' | 'segmentos' | 'programacao';
  config: ConfigIrrigacao;
  parada: Parada;
  /** ISO; futuro = início agendado. */
  inicio?: string | null;
  anguloFinal?: number | null;
  segmento?: number | null;
  /** Programação que originou (origem 'programacao'). */
  programacao?: { id: string; nome: string } | null;
}

export type OrigemSequencia = 'manual' | 'agendada' | 'programacao' | 'ponta' | 'ponta_retomada' | 'parada';

const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));
const norm360 = (g: number) => ((g % 360) + 360) % 360;

/** Valida e normaliza o que veio do front. Inválido → null (vale "Ligar" simples). */
export function normalizarIrrigacao(raw: unknown): Irrigacao | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, any>;
  const c = (r.config ?? {}) as Record<string, any>;
  const config: ConfigIrrigacao = {
    direcao: c.direcao === 'Avanço' ? 'Avanço' : 'Reverso',
    percentual: clamp(Math.round(Number(c.percentual) || 100), 1, 100),
    semAgua: c.semAgua === true,
    canhao: c.canhao === true && c.semAgua !== true,
    faixasCanhao: Array.isArray(c.faixasCanhao)
      ? c.faixasCanhao.slice(0, 8).map((f: any) => ({ liga: norm360(Number(f?.liga) || 0), desliga: norm360(Number(f?.desliga) || 0) }))
      : [],
  };
  const p = (r.parada ?? {}) as Record<string, any>;
  let parada: Parada = { tipo: 'semParar' };
  if (p.tipo === 'porVoltas' && Number(p.voltas) > 0) parada = { tipo: 'porVoltas', voltas: clamp(Number(p.voltas), 0.1, 50) };
  else if (p.tipo === 'porAngulo' && Number.isFinite(Number(p.angulo))) parada = { tipo: 'porAngulo', angulo: norm360(Number(p.angulo)) };
  else if (p.tipo === 'porTempo' && Number(p.minutos) > 0) parada = { tipo: 'porTempo', minutos: clamp(Math.round(Number(p.minutos)), 1, 7 * 1440) };
  const modo = ['simples', 'angulo', 'segmentos', 'programacao'].includes(r.modo) ? r.modo : 'simples';
  if (modo === 'angulo' && Number.isFinite(Number(r.anguloFinal)) && parada.tipo === 'semParar') {
    parada = { tipo: 'porAngulo', angulo: norm360(Number(r.anguloFinal)) };
  }
  const ini = r.inicio ? new Date(r.inicio) : null;
  return {
    modo,
    config,
    parada,
    inicio: ini && !Number.isNaN(ini.getTime()) ? ini.toISOString() : null,
    anguloFinal: Number.isFinite(Number(r.anguloFinal)) ? norm360(Number(r.anguloFinal)) : null,
    segmento: Number.isFinite(Number(r.segmento)) ? Number(r.segmento) : null,
    programacao: r.programacao?.id ? { id: String(r.programacao.id), nome: String(r.programacao.nome ?? '') } : null,
  };
}

/** Valor gravado (Avanço/Reverso = girar_direita/girar_esquerda) → texto mostrado. */
export const DIRECAO_LABEL: Record<Direcao, string> = { 'Avanço': 'Direita', 'Reverso': 'Esquerda' };

/** "Esquerda · 60% · Molhado · canhão" (texto da trilha e dos registros). */
export function resumoIrrigacao(i: Irrigacao | null | undefined): string {
  if (!i) return 'última configuração';
  const c = i.config;
  const partes = [DIRECAO_LABEL[c.direcao] ?? c.direcao, c.semAgua ? 'Seco' : `${c.percentual}% · Molhado`];
  if (c.canhao) partes.push('canhão');
  const p = i.parada;
  partes.push(
    p.tipo === 'porVoltas' ? `${p.voltas} volta${p.voltas === 1 ? '' : 's'}`
      : p.tipo === 'porAngulo' ? `para em ${p.angulo}°`
        : p.tipo === 'porTempo' ? `${p.minutos} min`
          : 'sem parada',
  );
  return partes.join(' · ');
}

/**
 * Quando parar (ms a partir do giro confirmado). Voltas e tempo saem do tempo de
 * volta a 100% (parâmetro do pivô) corrigido pelo percentímetro; por ângulo só com
 * o ângulo atual lido (sem leitura → null: a parada fica por conta do ângulo lido
 * no tick ou do operador).
 */
export function duracaoParadaMs(i: Irrigacao, tempoVolta100h: number, anguloAtual: number | null): number | null {
  const p = i.parada;
  if (p.tipo === 'porTempo') return p.minutos * 60000;
  const fator = i.config.semAgua ? 1 : 100 / Math.max(1, i.config.percentual);
  const horasPorVolta = Math.max(0.1, tempoVolta100h) * fator;
  if (p.tipo === 'porVoltas') return Math.round(p.voltas * horasPorVolta * 3600000);
  if (p.tipo === 'porAngulo' && anguloAtual != null) {
    let delta = i.config.direcao === 'Reverso' ? norm360(anguloAtual - p.angulo) : norm360(p.angulo - anguloAtual);
    if (delta <= 0) delta = 360;
    return Math.round((delta / 360) * horasPorVolta * 3600000);
  }
  return null;
}

/** Ângulo já chegou ao destino? (tolerância de 2°, olhando o sentido do giro). */
export function chegouNoAngulo(direcao: Direcao, alvo: number, anterior: number, atual: number, tol = 2): boolean {
  const d = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
  if (d(atual, alvo) <= tol) return true;
  // passou do alvo entre duas leituras
  const andou = direcao === 'Avanço' ? norm360(atual - anterior) : norm360(anterior - atual);
  const ate = direcao === 'Avanço' ? norm360(alvo - anterior) : norm360(anterior - alvo);
  return andou > 0 && andou < 180 && ate <= andou;
}

export interface ProgramacaoExec {
  id: string; nome: string; ativo: boolean; hora_inicio: string; dias: number[];
  modo: 'percurso' | 'tempo'; angulo_inicial: number | null; angulo_final: number | null; duracao_min: number | null;
  sentido: 'horario' | 'anti_horario'; velocidade: number | null; com_agua: boolean;
  ultima_execucao_em: Date | null;
}

/**
 * A programação dispara agora? Dispara no minuto de hora_inicio (ou até `folgaMin`
 * depois, para tolerar servidor reiniciando), nos dias marcados, uma vez por dia.
 */
export function programacaoDisparaAgora(p: ProgramacaoExec, agora: MomentoLocal, agoraMs: number, folgaMin = 5): boolean {
  if (!p.ativo) return false;
  const ini = parseHHMM(p.hora_inicio);
  if (ini === null) return false;
  if (!(p.dias ?? []).map(Number).includes(agora.diaSemana)) return false;
  const passou = agora.minutos - ini;
  if (passou < 0 || passou > folgaMin) return false;
  // já rodou hoje (últimas 20 h)?
  if (p.ultima_execucao_em && agoraMs - new Date(p.ultima_execucao_em).getTime() < 20 * 3600000) return false;
  return true;
}

/** Programação → irrigação que o servidor envia. */
export function irrigacaoDaProgramacao(p: ProgramacaoExec): Irrigacao {
  const config: ConfigIrrigacao = {
    direcao: p.sentido === 'horario' ? 'Avanço' : 'Reverso',
    percentual: clamp(Math.round(Number(p.velocidade) || 100), 1, 100),
    semAgua: p.com_agua === false,
    canhao: false,
    faixasCanhao: [],
  };
  let parada: Parada = { tipo: 'semParar' };
  if (p.modo === 'tempo' && p.duracao_min) parada = { tipo: 'porTempo', minutos: p.duracao_min };
  else if (p.modo === 'percurso' && p.angulo_final != null) parada = { tipo: 'porAngulo', angulo: Number(p.angulo_final) };
  return { modo: 'programacao', config, parada, inicio: null, programacao: { id: p.id, nome: p.nome } };
}

export function dentroDaPonta(j: JanelaComAtivo | null | undefined, agora: MomentoLocal): boolean {
  return !!j && j.ativo === true && dentroDaJanela(j, agora);
}
