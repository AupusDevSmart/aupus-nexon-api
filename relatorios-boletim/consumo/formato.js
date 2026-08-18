/** Formatação pt-BR compartilhada pelo relatório. */

export function num(valor, casas = 0) {
  if (valor === null || valor === undefined || Number.isNaN(valor)) return '—';
  return new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: casas,
    maximumFractionDigits: casas,
  }).format(valor);
}

export function moeda(valor, casas = 2) {
  return `R$ ${num(valor, casas)}`;
}

/** Variação percentual já com sinal. `bomSubir` define a cor. */
export function variacao(atual, anterior, { bomSubir = true, casas = 1 } = {}) {
  if (!anterior) return { texto: '—', classe: 'neutro', delta: 0 };
  const delta = ((atual - anterior) / anterior) * 100;
  const sinal = delta >= 0 ? '+' : '−';
  const subiu = delta >= 0;
  return {
    texto: `${sinal}${num(Math.abs(delta), casas)}%`,
    classe: subiu === bomSubir ? 'pos' : 'neg',
    delta,
  };
}
