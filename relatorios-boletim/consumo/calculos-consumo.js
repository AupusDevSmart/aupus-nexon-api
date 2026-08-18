/**
 * Derivações do Relatório de Gestão de Energia — Visão Semanal.
 *
 * A plataforma entrega os valores medidos; participações, totais, médias e a contagem de
 * ultrapassagens saem daqui. Assim um número não contradiz o outro dentro da página.
 */

/** Cor de cada posto tarifário — a mesma nos demais relatórios Aupus. */
export const CORES_POSTO = {
  'Fora de ponta': '#16A34A',
  Ponta: '#F59E0B',
  Reservado: '#2563EB',
};

const SEQUENCIA = ['#16A34A', '#F59E0B', '#2563EB'];

export function corDoPosto(nome, indice = 0) {
  return CORES_POSTO[nome] ?? SEQUENCIA[indice % SEQUENCIA.length];
}

/** "86h 30m" a partir de 86.5 */
export function horas(decimal) {
  const inteiras = Math.floor(decimal);
  const minutos = Math.round((decimal - inteiras) * 60);
  return `${inteiras}h ${String(minutos).padStart(2, '0')}m`;
}

/** Totais e participações dos postos tarifários. */
export function calcularPostos(postos) {
  const soma = (campo) => postos.reduce((s, p) => s + (p[campo] ?? 0), 0);

  const totais = {
    consumo: soma('consumo_kwh'),
    tempo: soma('tempo_horas'),
    custo: soma('custo'),
    acionamentos: soma('acionamentos'),
  };

  const pct = (valor, total) => (total ? (valor / total) * 100 : 0);

  return {
    totais,
    linhas: postos.map((p, i) => ({
      ...p,
      cor: corDoPosto(p.nome, i),
      pctConsumo: pct(p.consumo_kwh, totais.consumo),
      pctTempo: pct(p.tempo_horas, totais.tempo),
      pctCusto: pct(p.custo, totais.custo),
      pctAcionamentos: pct(p.acionamentos, totais.acionamentos),
    })),
  };
}

/**
 * Demanda: quais pontos ultrapassaram e quantos foram.
 * A contagem sai da própria série, então nunca diverge do que o gráfico mostra em vermelho.
 */
export function calcularDemanda(demanda) {
  const contratada = demanda.contratada_kw;
  const pontos = demanda.serie.map((p) => ({ ...p, ultrapassou: p.valor > contratada }));
  const maior = demanda.maior_registrada_kw ?? Math.max(...demanda.serie.map((p) => p.valor));

  return {
    contratada,
    pontos,
    maiorRegistrada: maior,
    ultrapassagens: demanda.ultrapassagens ?? pontos.filter((p) => p.ultrapassou).length,
    maiorUltrapassagemPct: contratada ? (maior / contratada - 1) * 100 : 0,
  };
}

/** Severidade dos alarmes e total de eventos. */
export function calcularEventos(eventos) {
  return {
    linhas: eventos,
    total: eventos.reduce((s, e) => s + e.qtd, 0),
  };
}

/** Reúne tudo o que o componente precisa, já derivado. */
export function derivar(d) {
  const postos = calcularPostos(d.postos);
  const demanda = calcularDemanda(d.demanda);
  const eventos = calcularEventos(d.eventos);

  return {
    postos,
    demanda,
    eventos,
    tempoTotal: horas(postos.totais.tempo),
    mediaDiaria: d.funcionamento.dias ? horas(postos.totais.tempo / d.funcionamento.dias) : '—',
  };
}
