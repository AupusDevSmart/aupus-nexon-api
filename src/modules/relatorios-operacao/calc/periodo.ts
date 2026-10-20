/**
 * Período dos relatórios de operação (NEXON-33) — lógica PURA, testada em periodo.spec.ts.
 *
 * Fuso: America/Sao_Paulo (UTC−3 fixo, sem horário de verão desde 2019 — mesma premissa do
 * resumo diário, ADR 0003). No banco `timestamp_dados` e afins são UTC sem fuso.
 */

const OFFSET_MS = -3 * 3_600_000;
const H = 3_600_000;
const pad = (n: number) => String(n).padStart(2, '0');

export interface PeriodoRelatorio {
  mes: string; // 'YYYY-MM'
  /** 1º dia 00:00 de Brasília. */
  inicio: Date;
  /** Fim do período considerado: fim do mês, ou agora no mês corrente. */
  fim: Date;
  /** Primeiro instante do mês seguinte (fim "cheio" do mês). */
  fimMes: Date;
  /** Dias locais [primeiro, último] do período, 'YYYY-MM-DD'. */
  diaInicio: string;
  diaFim: string;
}

/** Meia-noite de Brasília do dia local → instante UTC. */
export function inicioDoDia(dia: string): Date {
  const [a, m, d] = dia.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d) - OFFSET_MS);
}

/** Dia local ('YYYY-MM-DD') de um instante. */
export function diaLocal(t: Date | number): string {
  const d = new Date((typeof t === 'number' ? t : t.getTime()) + OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function somarDias(dia: string, n: number): string {
  const [a, m, d] = dia.split('-').map(Number);
  const x = new Date(Date.UTC(a, m - 1, d + n));
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
}

/** 'YYYY-MM' ± n meses. */
export function somarMeses(mes: string, n: number): string {
  const [a, m] = mes.split('-').map(Number);
  const x = new Date(Date.UTC(a, m - 1 + n, 1));
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}`;
}

/** Dia da semana ISO (1 = segunda … 7 = domingo) de um dia local. */
export function diaSemanaIso(dia: string): number {
  const [a, m, d] = dia.split('-').map(Number);
  const w = new Date(Date.UTC(a, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

/** Instante → ISO com offset de Brasília: '2026-10-20T15:04:05-03:00'. */
export function isoBrt(t: Date | number | null | undefined): string | null {
  if (t === null || t === undefined) return null;
  const ms = typeof t === 'number' ? t : t.getTime();
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + OFFSET_MS);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}-03:00`
  );
}

/** Hora local decimal (0–24) de um instante. */
export function horaLocal(t: number): number {
  const d = new Date(t + OFFSET_MS);
  return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
}

/**
 * Valida 'YYYY-MM' e monta o período. Mês futuro, malformado ou antes de 2020 → null
 * (o controller devolve 400). Mês corrente termina "agora".
 */
export function periodoDoMes(mes: string | null | undefined, agora = new Date()): PeriodoRelatorio | null {
  const m = /^(\d{4})-(\d{2})$/.exec(String(mes ?? '').trim());
  if (!m) return null;
  const ano = Number(m[1]);
  const mm = Number(m[2]);
  if (ano < 2020 || mm < 1 || mm > 12) return null;
  const chave = `${m[1]}-${m[2]}`;
  const inicio = inicioDoDia(`${chave}-01`);
  if (inicio.getTime() > agora.getTime()) return null;
  const fimMes = inicioDoDia(`${somarMeses(chave, 1)}-01`);
  const fim = fimMes.getTime() > agora.getTime() ? new Date(agora.getTime()) : fimMes;
  return {
    mes: chave,
    inicio,
    fim,
    fimMes,
    diaInicio: `${chave}-01`,
    diaFim: diaLocal(fim.getTime() - 1),
  };
}

/** Dias locais do intervalo [inicio, fim] (inclusivo). */
export function diasDe(inicio: string, fim: string): string[] {
  const out: string[] = [];
  for (let d = inicio; d <= fim; d = somarDias(d, 1)) out.push(d);
  return out;
}

/**
 * Semana da linha do tempo: a última semana completa (segunda a domingo) dentro do período.
 * Sem semana completa (começo do mês corrente), os 7 dias a partir do 1º dia do período.
 */
export function semanaDaLinhaDoTempo(p: Pick<PeriodoRelatorio, 'inicio' | 'fim' | 'diaInicio'>): string {
  // último domingo cujo fim (segunda 00:00) já passou dentro do período
  let domingo = diaLocal(p.fim.getTime() - 1);
  while (diaSemanaIso(domingo) !== 7) domingo = somarDias(domingo, -1);
  if (inicioDoDia(somarDias(domingo, 1)).getTime() > p.fim.getTime()) domingo = somarDias(domingo, -7);
  const segunda = somarDias(domingo, -6);
  return segunda >= p.diaInicio ? segunda : p.diaInicio;
}

/** Horas (0..168) de um instante desde o início de uma semana local. */
export function horasDesde(diaInicio: string, t: number): number {
  return (t - inicioDoDia(diaInicio).getTime()) / H;
}
