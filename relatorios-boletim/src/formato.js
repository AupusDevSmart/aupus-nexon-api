/**
 * Formatação numérica no padrão brasileiro e cálculo de variações.
 */

/** 1234.5 -> "1.234,5" */
export function fmt(valor, casas = 1) {
  if (valor === null || valor === undefined || Number.isNaN(valor)) return '—';
  return new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: casas,
    maximumFractionDigits: casas,
  }).format(valor);
}

/** Variação percentual. Devolve { texto, classe } — classe alimenta o selo colorido. */
export function variacaoPct(atual, anterior) {
  if (!anterior) return { texto: '—', classe: 'neutro' };
  const delta = ((atual - anterior) / anterior) * 100;
  const sinal = delta >= 0 ? '+' : '−';
  return {
    texto: `${sinal}${fmt(Math.abs(delta), 1)}%`,
    classe: delta >= 0 ? 'pos' : 'neg',
  };
}

/** Variação em pontos percentuais — para disponibilidade e performance ratio. */
export function variacaoPp(atual, anterior) {
  const delta = atual - anterior;
  const sinal = delta >= 0 ? '+' : '−';
  return {
    texto: `${sinal}${fmt(Math.abs(delta), 2)} p.p.`,
    classe: delta >= 0 ? 'pos' : 'neg',
  };
}

/**
 * Para indicadores em que cair é bom (alarmes): verde quando reduz.
 * Ao acrescentar novos indicadores, escolha o comparador com esta semântica em mente.
 */
export function variacaoInvertida(atual, anterior) {
  if (!anterior) return { texto: '—', classe: 'neutro' };
  const delta = ((atual - anterior) / anterior) * 100;
  const sinal = delta >= 0 ? '+' : '−';
  return {
    texto: `${sinal}${fmt(Math.abs(delta), 1)}%`,
    classe: delta > 0 ? 'neg' : 'pos',
  };
}

/** Escapa texto vindo do payload antes de injetar no HTML. */
export function esc(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
