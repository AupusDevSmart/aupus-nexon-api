/**
 * Datas da análise de geração. Fuso fixo America/Sao_Paulo (UTC−3, sem horário de verão desde
 * 2019), como o resto do NexON. `timestamp_dados` no banco é UTC sem fuso.
 * Dia local = 'YYYY-MM-DD'. Funções puras (testadas em geracao-calculo.spec.ts).
 */

export const OFFSET_BRT_H = -3;
const OFFSET_MS = OFFSET_BRT_H * 3_600_000;

export type Periodo = 'dia' | 'semana' | 'mes' | 'ano' | 'total';
export const PERIODOS: Periodo[] = ['dia', 'semana', 'mes', 'ano', 'total'];

const pad = (n: number) => String(n).padStart(2, '0');

/** Dia local de um instante. */
export function diaLocal(instante: Date): string {
  const d = new Date(instante.getTime() + OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Instante UTC da meia-noite local do dia. */
export function inicioDoDiaUtc(dia: string): Date {
  const [a, m, d] = dia.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d) - OFFSET_MS);
}

export function somarDias(dia: string, n: number): string {
  const [a, m, d] = dia.split('-').map(Number);
  const x = new Date(Date.UTC(a, m - 1, d + n));
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
}

export function diasNoMes(ano: number, mes: number): number {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

/** 0 = segunda … 6 = domingo. */
export function diaDaSemana(dia: string): number {
  const [a, m, d] = dia.split('-').map(Number);
  return (new Date(Date.UTC(a, m - 1, d)).getUTCDay() + 6) % 7;
}

/** Dias de `inicio` a `fim` (inclusive), no máximo `limite` (padrão: pouco mais de um ano). */
export function diasEntre(inicio: string, fim: string, limite = 400): string[] {
  const out: string[] = [];
  for (let d = inicio; d <= fim && out.length < limite; d = somarDias(d, 1)) out.push(d);
  return out;
}

/** 'YYYY-MM-DD HH:MM:SS' em UTC, para comparar com timestamp(0) sem fuso no SQL. */
export function sqlUtc(instante: Date): string {
  return instante.toISOString().slice(0, 19).replace('T', ' ');
}

/** ISO com o fuso local (-03:00) — o que a tela mostra. */
export function isoLocal(instante: Date): string {
  const d = new Date(instante.getTime() + OFFSET_MS);
  return `${d.toISOString().slice(0, 19)}-03:00`;
}

export function horaLocal(instante: Date): string {
  const d = new Date(instante.getTime() + OFFSET_MS);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export interface JanelaPeriodo {
  periodo: Periodo;
  referencia: string;
  inicio: string;
  fim: string;
  /** null no período Total (não há período anterior). */
  anterior: string | null;
  /** null quando o próximo período começa depois de hoje (e no Total). */
  proximo: string | null;
}

/** Primeiro ano do período Total quando não se sabe o primeiro dado. */
export const ANO_MINIMO_TOTAL = 2020;

/**
 * Normaliza o período pedido: semana = segunda a domingo; mês e ano civis; total = de 2020 ao
 * fim do ano corrente (a análise troca o início pelo primeiro ano com dado).
 */
export function janelaDoPeriodo(periodo: Periodo, referencia: string, hoje: string): JanelaPeriodo {
  const [a, m] = referencia.split('-').map(Number);
  let inicio: string;
  let fim: string;
  let anterior: string;
  let proximo: string;
  if (periodo === 'total') {
    return {
      periodo, referencia, inicio: `${ANO_MINIMO_TOTAL}-01-01`, fim: `${hoje.slice(0, 4)}-12-31`, anterior: null, proximo: null,
    };
  }
  if (periodo === 'dia') {
    inicio = fim = referencia;
    anterior = somarDias(referencia, -1);
    proximo = somarDias(referencia, 1);
  } else if (periodo === 'semana') {
    inicio = somarDias(referencia, -diaDaSemana(referencia));
    fim = somarDias(inicio, 6);
    anterior = somarDias(inicio, -7);
    proximo = somarDias(inicio, 7);
  } else if (periodo === 'mes') {
    inicio = `${a}-${pad(m)}-01`;
    fim = `${a}-${pad(m)}-${pad(diasNoMes(a, m))}`;
    const ma = m === 1 ? [a - 1, 12] : [a, m - 1];
    const mp = m === 12 ? [a + 1, 1] : [a, m + 1];
    anterior = `${ma[0]}-${pad(ma[1])}-01`;
    proximo = `${mp[0]}-${pad(mp[1])}-01`;
  } else {
    inicio = `${a}-01-01`;
    fim = `${a}-12-31`;
    anterior = `${a - 1}-01-01`;
    proximo = `${a + 1}-01-01`;
  }
  return { periodo, referencia, inicio, fim, anterior, proximo: proximo > hoje ? null : proximo };
}

export const DIAS_SEMANA = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'];
export const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
