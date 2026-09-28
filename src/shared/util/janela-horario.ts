/**
 * Janelas de horário (operador e pivô) — lógica PURA, sem banco.
 *
 * Convenção de dias: ISO-8601, 1 = segunda … 7 = domingo (o mesmo que o app
 * manda em `janela.dias` e `bloqueio_ponta.dias`).
 *
 * Horário SEMPRE em America/Sao_Paulo: a janela é regra de operação da fazenda
 * / da UC, não do servidor (que roda em UTC).
 */

export interface JanelaHorario {
  /** 'HH:MM' */
  inicio: string;
  /** 'HH:MM' — se menor que `inicio`, a janela atravessa a meia-noite. */
  fim: string;
  /** 1..7 (ISO). Vazio = nenhum dia. */
  dias: number[];
}

export interface JanelaComAtivo extends JanelaHorario {
  ativo: boolean;
}

export interface MomentoLocal {
  /** Minutos desde 00:00 no fuso local. */
  minutos: number;
  /** 1 = segunda … 7 = domingo. */
  diaSemana: number;
}

export const FUSO_OPERACAO = 'America/Sao_Paulo';

const DIA_ISO: Record<string, number> = {
  Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
};

/** Converte um instante para minuto-do-dia + dia ISO em America/Sao_Paulo. */
export function momentoEmSaoPaulo(d: Date = new Date()): MomentoLocal {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: FUSO_OPERACAO,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => partes.find((p) => p.type === t)?.value ?? '';
  const hora = Number(get('hour')) % 24;
  const minuto = Number(get('minute'));
  return { minutos: hora * 60 + minuto, diaSemana: DIA_ISO[get('weekday')] ?? 1 };
}

/** 'HH:MM' → minutos. Inválido → null. */
export function parseHHMM(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function janelaValida(j: unknown): j is JanelaHorario {
  if (!j || typeof j !== 'object') return false;
  const o = j as any;
  return (
    parseHHMM(o.inicio) !== null &&
    parseHHMM(o.fim) !== null &&
    Array.isArray(o.dias) &&
    o.dias.every((d: unknown) => Number.isInteger(d) && (d as number) >= 1 && (d as number) <= 7)
  );
}

/**
 * O momento está dentro da janela?
 *
 * - inicio == fim → o dia inteiro (nos dias marcados).
 * - inicio < fim  → [inicio, fim) no mesmo dia.
 * - inicio > fim  → atravessa a meia-noite: [inicio, 24h) no dia marcado e
 *   [0, fim) no dia SEGUINTE a um dia marcado (a janela "pertence" ao dia em
 *   que começou: 22:00–05:00 de sexta cobre a madrugada de sábado).
 */
export function dentroDaJanela(janela: JanelaHorario, agora: MomentoLocal): boolean {
  const ini = parseHHMM(janela.inicio);
  const fim = parseHHMM(janela.fim);
  if (ini === null || fim === null) return false;
  const dias = new Set((janela.dias ?? []).map(Number));
  if (dias.size === 0) return false;

  if (ini === fim) return dias.has(agora.diaSemana);
  if (ini < fim) {
    return dias.has(agora.diaSemana) && agora.minutos >= ini && agora.minutos < fim;
  }
  // Atravessa a meia-noite.
  if (agora.minutos >= ini) return dias.has(agora.diaSemana);
  if (agora.minutos < fim) {
    const ontem = agora.diaSemana === 1 ? 7 : agora.diaSemana - 1;
    return dias.has(ontem);
  }
  return false;
}

/** Bloqueio (ponta/reservado) vale agora? Desligado ou malformado → não bloqueia. */
export function bloqueioVigente(cfg: Partial<JanelaComAtivo> | null | undefined, agora: MomentoLocal): boolean {
  if (!cfg || cfg.ativo !== true) return false;
  if (!janelaValida(cfg)) return false;
  return dentroDaJanela(cfg, agora);
}

/** Minúsculas, sem acento — para casar nomes de ponto/equipamento. */
export function normalizarTexto(s: unknown): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Comando de PARTIDA (ligar/partida) — o único que o bloqueio de ponta barra.
 * Desligar/parar NUNCA é bloqueado: parar um pivô na ponta é justamente o que
 * se quer.
 */
export function ehComandoDePartida(nomePonto: unknown): boolean {
  const n = normalizarTexto(nomePonto);
  if (!n) return false;
  if (/\b(desligar|desliga|desligamento|parar|para|parada|stop|off)\b/.test(n)) return false;
  return /\b(ligar|liga|partida|partir|start|on)\b/.test(n);
}

/** Pivô = tipo/nome contém "pivo"/"pivô"/"irriga". */
export function ehPivo(...textos: unknown[]): boolean {
  return textos.some((t) => /piv[oô]|irriga/.test(normalizarTexto(t)));
}
