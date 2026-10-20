/**
 * Operação do pivô a partir da medição de energia (NEXON-33) — lógica PURA, testada em
 * pivo-operacao.spec.ts.
 *
 * O pivô não publica telemetria própria (nem ângulo nem status no histórico): quem mede é o
 * Power Meter do disjuntor que alimenta o pivô (vínculo do IoT). "Irrigando" = potência
 * média do bloco de 15 min acima do limiar de operação daquele medidor.
 */

import { diaLocal, diaSemanaIso, horaLocal } from './periodo';
import { arred, Intervalo } from './disponibilidade';

export const PASSO_MS = 15 * 60_000;

/** Bloco de medição: `t` = fim da janela de 15 min (ms); `kw` = potência média. */
export interface AmostraKw {
  t: number;
  kw: number;
}

export interface Segmento extends Intervalo {
  /** Como terminou: 'parada' = próximo bloco medido abaixo do limiar; 'sem_dado' = faltou leitura ou acabou o período. */
  termino: 'parada' | 'sem_dado';
}

/** Percentil (0–100) com interpolação linear. */
export function percentil(v: number[], p: number): number | null {
  const s = v.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const pos = (p / 100) * (s.length - 1);
  const i = Math.floor(pos);
  return i + 1 < s.length ? s[i] + (s[i + 1] - s[i]) * (pos - i) : s[i];
}

/**
 * Limiar de operação: 10% do P95 das potências positivas do mês (mínimo 1 kW). Sem
 * potência positiva → Infinity (nunca operou). Independe da escala do medidor.
 */
export function limiarOperacao(kws: number[]): number {
  const p95 = percentil(kws.filter((x) => x > 0), 95);
  if (p95 === null || p95 <= 0) return Infinity;
  return Math.max(1, p95 * 0.1);
}

/**
 * Blocos consecutivos acima do limiar viram um segmento [t − 15 min, t do último bloco].
 * Buraco de leitura (> 1,5 passo) fecha o segmento como 'sem_dado' (não é parada).
 */
export function segmentosOperando(amostras: AmostraKw[], limiar: number, passo = PASSO_MS): Segmento[] {
  const ord = [...amostras].sort((a, b) => a.t - b.t);
  const out: Segmento[] = [];
  let atual: Intervalo | null = null;
  let ultimoT = -Infinity;
  for (const a of ord) {
    const continuo = a.t - ultimoT <= passo * 1.5;
    const rodando = a.kw >= limiar;
    if (atual && !continuo) {
      out.push({ ...atual, termino: 'sem_dado' });
      atual = null;
    }
    if (rodando) {
      if (atual) atual.fim = a.t;
      else atual = { ini: a.t - passo, fim: a.t };
    } else if (atual) {
      out.push({ ...atual, termino: 'parada' });
      atual = null;
    }
    ultimoT = a.t;
  }
  if (atual) out.push({ ...atual, termino: 'sem_dado' });
  return out;
}

export function horasDe(segs: Intervalo[], ini = -Infinity, fim = Infinity): number {
  let ms = 0;
  for (const s of segs) {
    const a = Math.max(s.ini, ini);
    const b = Math.min(s.fim, fim);
    if (b > a) ms += b - a;
  }
  return ms / 3_600_000;
}

export interface JanelaPonta {
  ativo: boolean;
  inicio: string; // 'HH:MM'
  fim: string;
  dias: number[]; // ISO 1..7
}

export type MotivoParada = 'comando' | 'ponta' | 'nao_programada';

/**
 * Por que o pivô parou. Comando (trilha de comando ou sequência do NexON) até 15 min antes
 * ou 2 min depois = 'comando'; parada até 15 min em volta do início da ponta num dia de
 * bloqueio ligado = 'ponta'; o resto = não programada.
 */
export function classificarParada(t: number, comandos: number[], ponta: JanelaPonta | null): MotivoParada {
  if (comandos.some((c) => c >= t - 15 * 60_000 && c <= t + 2 * 60_000)) return 'comando';
  if (ponta?.ativo) {
    const [hh, mm] = ponta.inicio.split(':').map(Number);
    const ini = hh + mm / 60;
    const h = horaLocal(t);
    const dia = diaSemanaIso(diaLocal(t));
    if (ponta.dias.includes(dia) && Math.abs(h - ini) <= 0.25) return 'ponta';
  }
  return 'nao_programada';
}

/** Lâmina média aplicada (mm) = lâmina a 100% × horas irrigando ÷ tempo de volta a 100%. */
export function laminaAplicadaMm(horas: number, lamina100: number | null, tempoVolta100: number | null): number | null {
  if (!lamina100 || lamina100 <= 0 || !tempoVolta100 || tempoVolta100 <= 0) return null;
  return arred((lamina100 * horas) / tempoVolta100, 1);
}

/**
 * Voltas = Σ horas × velocidade% ÷ (100 × tempo de volta a 100%). Precisa da velocidade de
 * TODOS os trechos (vem da irrigação enviada pelo NexON); faltando uma → null.
 */
export function voltasPorVelocidade(trechos: Array<{ horas: number; pct: number | null }>, tempoVolta100: number | null): number | null {
  if (!tempoVolta100 || tempoVolta100 <= 0 || !trechos.length) return null;
  if (trechos.some((t) => t.pct === null || !(t.pct > 0))) return null;
  return arred(trechos.reduce((s, t) => s + (t.horas * (t.pct as number)) / 100 / tempoVolta100, 0), 2);
}

export interface ProgramacaoPivo {
  ativo: boolean;
  dias: number[];
  modo: string; // 'percurso' | 'tempo'
  angulo_inicial: number | null;
  angulo_final: number | null;
  duracao_min: number | null;
  sentido: string; // 'horario' | 'anti_horario'
  velocidade: number | null;
  com_agua: boolean;
}

const norm360 = (g: number) => ((g % 360) + 360) % 360;

/**
 * Lâmina programada (mm) nos dias do período pelas programações ativas com água:
 *  - por tempo: lâmina_100 × horas ÷ tempo de volta a 100%;
 *  - por percurso: lâmina_100 × (arco/360) × 100 ÷ velocidade%.
 * Sem programação válida ou sem parâmetros → null.
 */
export function laminaProgramadaMm(progs: ProgramacaoPivo[], dias: string[], lamina100: number | null, tempoVolta100: number | null): number | null {
  if (!lamina100 || lamina100 <= 0 || !tempoVolta100 || tempoVolta100 <= 0) return null;
  let mm = 0;
  let alguma = false;
  for (const p of progs) {
    if (!p.ativo || !p.com_agua) continue;
    let porDia: number | null = null;
    if (p.modo === 'tempo' && p.duracao_min && p.duracao_min > 0) {
      porDia = (lamina100 * (p.duracao_min / 60)) / tempoVolta100;
    } else if (p.modo === 'percurso' && p.angulo_inicial !== null && p.angulo_final !== null) {
      const vel = p.velocidade && p.velocidade > 0 ? Math.min(100, p.velocidade) : 100;
      let arco = p.sentido === 'anti_horario' ? norm360(p.angulo_inicial - p.angulo_final) : norm360(p.angulo_final - p.angulo_inicial);
      if (arco === 0) arco = 360;
      porDia = lamina100 * (arco / 360) * (100 / vel);
    }
    if (porDia === null) continue;
    const vezes = dias.filter((d) => (p.dias ?? []).map(Number).includes(diaSemanaIso(d))).length;
    if (vezes) alguma = true;
    mm += porDia * vezes;
  }
  return alguma ? arred(mm, 1) : null;
}

/** Segmentos em horas desde o início da semana, cortados em [0, 168]. */
export function segmentosNaSemana(segs: Intervalo[], inicioSemanaMs: number): Array<{ inicioH: number; fimH: number }> {
  const out: Array<{ inicioH: number; fimH: number }> = [];
  for (const s of segs) {
    const a = Math.max(0, (s.ini - inicioSemanaMs) / 3_600_000);
    const b = Math.min(168, (s.fim - inicioSemanaMs) / 3_600_000);
    if (b > a) out.push({ inicioH: arred(a, 2), fimH: arred(b, 2) });
  }
  return out;
}
