/**
 * Cálculo da análise de geração (NEXON-16) — funções PURAS, testadas em geracao-calculo.spec.ts.
 * Base: intervalos de 15 min. Ver docs/GERACAO-ANALISE.md.
 */

export const INTERVALO_H = 0.25;
export const INTERVALO_MS = 15 * 60 * 1000;

/** Fração da potência AC a partir da qual a geração é considerada "no teto" (GER tabela 4). */
export const FRACAO_TETO_AC = 0.98;
/** Limitação externa sem registro: esperado precisa passar o real em 10%. */
export const MARGEM_LIMITACAO_EXTERNA = 1.1;
/** Variação máxima (max−min)/média da potência no intervalo para contar como "estável". */
export const VARIACAO_ESTAVEL = 0.02;

/** GER-13: P_esperada = kWp_DC × (G_poa / 1000) × fator_desempenho. Sem limite AC (GER-14). */
export function potenciaEsperadaKw(kwpDc: number, gPoaWm2: number, fatorDesempenho: number): number {
  if (!(kwpDc > 0) || !(gPoaWm2 > 0)) return 0;
  return kwpDc * (gPoaWm2 / 1000) * fatorDesempenho;
}

/** Azimute da spec (0 = norte, sentido horário, 0–359) → Open-Meteo (0 = sul, −90 = leste, 90 = oeste). */
export function azimuteParaOpenMeteo(azimuteNorte: number): number {
  const a = ((((azimuteNorte - 180) % 360) + 540) % 360) - 180;
  return a === 180 ? -180 : a;
}

// ── Estado de cada inversor num intervalo ───────────────────────────────────

export interface InversorIntervalo {
  id: string;
  /** Peso do inversor na usina (potência nominal AC; a fração vem da soma). */
  potenciaNominalKw: number;
  /** Potência média no intervalo (kW); null = sem comunicação. */
  realKw: number | null;
  falha: boolean;
  desligado: boolean;
  /** Registro de limite de potência ativo (< 100%) reportado pelo inversor. */
  limiteAtivo: boolean;
  /** Potência estável no intervalo (variação < 2% com leituras suficientes). */
  estavel: boolean;
}

export interface PerdasIntervalo {
  indisponibilidadeKw: number;
  limitacaoProjetoKw: number;
  limitacaoExternaKw: number;
  /** Inversores considerados indisponíveis neste intervalo. */
  indisponiveis: string[];
}

const ZERO: PerdasIntervalo = { indisponibilidadeKw: 0, limitacaoProjetoKw: 0, limitacaoExternaKw: 0, indisponiveis: [] };

/**
 * Inversor indisponível no intervalo (categoria 1): sem comunicação, ou parado (≈ 0 kW) em falha,
 * desligado, ou com sol que justificaria gerar (disjuntor aberto / sem rede / standby fora de hora).
 */
export function inversorIndisponivel(inv: InversorIntervalo, esperadoDoInversorKw: number): boolean {
  if (inv.realKw == null) return esperadoDoInversorKw > 0;
  // Parado por ordem de limite (ex.: exportação zero) é limitação externa, não indisponibilidade.
  if (inv.limiteAtivo) return false;
  const parado = inv.realKw < Math.max(inv.potenciaNominalKw, 1) * 0.01;
  if (!parado) return false;
  if (inv.falha || inv.desligado) return esperadoDoInversorKw > 0;
  return esperadoDoInversorKw > inv.potenciaNominalKw * 0.1;
}

/**
 * Classifica a perda de UM intervalo (seção 4), só quando P_esperada > P_real.
 * Ordem: indisponibilidade → limitação de projeto → limitação externa. "Outras" sai no total
 * (E_esperada − E_real − categorias), por isso não é calculada aqui.
 *
 * @param potenciaAcKw  potência AC nominal da usina (config ou soma dos inversores)
 */
export function classificarIntervalo(
  esperadoKw: number,
  inversores: InversorIntervalo[],
  potenciaAcKw: number,
): PerdasIntervalo {
  if (!inversores.length || !(esperadoKw > 0)) return ZERO;
  const realKw = inversores.reduce((s, i) => s + Math.max(i.realKw ?? 0, 0), 0);
  const gap = esperadoKw - realKw;
  if (!(gap > 0)) return ZERO;

  const somaNominal = inversores.reduce((s, i) => s + Math.max(i.potenciaNominalKw, 0), 0);
  const fracao = (i: InversorIntervalo) =>
    somaNominal > 0 ? Math.max(i.potenciaNominalKw, 0) / somaNominal : 1 / inversores.length;

  let fracaoIndisp = 0;
  const indisponiveis: string[] = [];
  for (const inv of inversores) {
    if (inversorIndisponivel(inv, esperadoKw * fracao(inv))) {
      fracaoIndisp += fracao(inv);
      indisponiveis.push(inv.id);
    }
  }
  const indisponibilidadeKw = Math.min(gap, esperadoKw * fracaoIndisp);

  // O que sobra é comparado só com os inversores disponíveis.
  const disponiveis = inversores.filter((i) => !indisponiveis.includes(i.id));
  const fracaoDisp = 1 - fracaoIndisp;
  const esperadoDispKw = esperadoKw * fracaoDisp;
  const acDispKw = potenciaAcKw * fracaoDisp;
  const realDispKw = disponiveis.reduce((s, i) => s + Math.max(i.realKw ?? 0, 0), 0);
  const resto = gap - indisponibilidadeKw;

  let limitacaoProjetoKw = 0;
  let limitacaoExternaKw = 0;
  if (disponiveis.length && esperadoDispKw > realDispKw && resto > 0) {
    const diferenca = Math.min(resto, esperadoDispKw - realDispKw);
    if (acDispKw > 0 && realDispKw >= FRACAO_TETO_AC * acDispKw) {
      limitacaoProjetoKw = diferenca;
    } else {
      const registro = disponiveis.some((i) => i.limiteAtivo);
      const estavel =
        realDispKw > 0 &&
        disponiveis.every((i) => i.estavel) &&
        realDispKw < FRACAO_TETO_AC * acDispKw &&
        esperadoDispKw > realDispKw * MARGEM_LIMITACAO_EXTERNA;
      if (registro || estavel) limitacaoExternaKw = diferenca;
    }
  }
  return { indisponibilidadeKw, limitacaoProjetoKw, limitacaoExternaKw, indisponiveis };
}

/** Potência estável: (max − min) / média < 2%, com pelo menos 5 leituras no intervalo. */
export function potenciaEstavel(minKw: number | null, maxKw: number | null, mediaKw: number | null, leituras: number): boolean {
  if (minKw == null || maxKw == null || mediaKw == null || !(mediaKw > 0) || leituras < 5) return false;
  return (maxKw - minKw) / mediaKw < VARIACAO_ESTAVEL;
}

// ── Totais do período ───────────────────────────────────────────────────────

export interface TotaisPerdas {
  esperadoKwh: number;
  /** Energia real só nos intervalos que têm esperado (compara igual com igual). */
  realKwh: number;
  indisponibilidadeKwh: number;
  limitacaoProjetoKwh: number;
  limitacaoExternaKwh: number;
  outrasKwh: number;
}

/** Categoria 4: E_esperada − E_real − (1+2+3), nunca negativa. */
export function outrasPerdas(t: Omit<TotaisPerdas, 'outrasKwh'>): number {
  return Math.max(0, t.esperadoKwh - t.realKwh - t.indisponibilidadeKwh - t.limitacaoProjetoKwh - t.limitacaoExternaKwh);
}

/** GER-16: % do esperado (pode passar de 100). */
export function pctEsperado(realKwh: number, esperadoKwh: number | null): number | null {
  if (esperadoKwh == null || !(esperadoKwh > 0)) return null;
  return (realKwh / esperadoKwh) * 100;
}

/** GER-31: previsão de amanhã = Σ min(P_esperada, P_AC) × 0,25 h. */
export function energiaPrevista(esperadosKw: number[], potenciaAcKw: number | null): number {
  return esperadosKw.reduce((s, p) => s + (potenciaAcKw && potenciaAcKw > 0 ? Math.min(p, potenciaAcKw) : p) * INTERVALO_H, 0);
}

// ── Fechamento do mês (GER-26..29) ──────────────────────────────────────────

export interface EntradaFechamento {
  /** kWh dos dias COMPLETOS do mês corrente (1 … ontem); null = dia sem dados. */
  diasCompletos: Array<number | null>;
  diasDoMes: number;
  /** Dia de hoje (1–31). */
  diaHoje: number;
  /** Média diária do mesmo mês em anos anteriores; null = sem histórico. */
  mediaHistorica: number | null;
}

export interface Fechamento {
  disponivel: boolean;
  motivo: string | null;
  acumuladoKwh: number;
  estimativaKwh: number | null;
  faixaKwh: number | null;
  diasDecorridos: number;
  usaHistorico: boolean;
}

export const DIA_MINIMO_FECHAMENTO = 5;

export function fechamentoDoMes(e: EntradaFechamento): Fechamento {
  const diasDecorridos = Math.max(0, Math.min(e.diaHoje - 1, e.diasDoMes));
  const comDado = e.diasCompletos.slice(0, diasDecorridos).filter((v): v is number => v != null);
  const acumuladoKwh = comDado.reduce((s, v) => s + v, 0);
  const temHistorico = e.mediaHistorica != null && e.mediaHistorica > 0;

  if (e.diaHoje < DIA_MINIMO_FECHAMENTO && !temHistorico) {
    return {
      disponivel: false, motivo: `Disponível a partir do dia ${DIA_MINIMO_FECHAMENTO}`,
      acumuladoKwh, estimativaKwh: null, faixaKwh: null, diasDecorridos, usaHistorico: false,
    };
  }
  if (!comDado.length && !temHistorico) {
    return {
      disponivel: false, motivo: 'Sem dados de geração neste mês',
      acumuladoKwh, estimativaKwh: null, faixaKwh: null, diasDecorridos, usaHistorico: false,
    };
  }

  const mediaCorrente = comDado.length ? acumuladoKwh / comDado.length : null;
  const w = diasDecorridos / e.diasDoMes;
  let media: number;
  if (temHistorico && mediaCorrente != null) media = w * mediaCorrente + (1 - w) * (e.mediaHistorica as number);
  else if (temHistorico) media = e.mediaHistorica as number;
  else media = mediaCorrente as number;

  const diasRestantes = e.diasDoMes - diasDecorridos;
  const estimativaKwh = acumuladoKwh + diasRestantes * media;

  let faixaKwh: number | null = null;
  if (comDado.length >= 2 && mediaCorrente != null) {
    const variancia = comDado.reduce((s, v) => s + (v - mediaCorrente) ** 2, 0) / (comDado.length - 1);
    faixaKwh = Math.sqrt(variancia) * Math.sqrt(diasRestantes);
  }
  return { disponivel: true, motivo: null, acumuladoKwh, estimativaKwh, faixaKwh, diasDecorridos, usaHistorico: temHistorico };
}

// ── Solarímetro GHI → POA (GER-7): Erbs + transposição isotrópica ───────────

const RAD = Math.PI / 180;

/** Vetor do sol (leste, norte, zênite) para um instante UTC. Precisão ~0,5°, suficiente aqui. */
export function vetorSol(instante: Date, latitude: number, longitude: number): { e: number; n: number; u: number; diaDoAno: number } {
  const inicioAno = Date.UTC(instante.getUTCFullYear(), 0, 1);
  const diaDoAno = Math.floor((instante.getTime() - inicioAno) / 86_400_000) + 1;
  const horaUtc = instante.getUTCHours() + instante.getUTCMinutes() / 60 + instante.getUTCSeconds() / 3600;
  const b = (360 / 365) * (diaDoAno - 81) * RAD;
  const equacaoTempoMin = 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
  const declinacao = 23.45 * Math.sin((360 / 365) * (284 + diaDoAno) * RAD) * RAD;
  const horaSolar = horaUtc + longitude / 15 + equacaoTempoMin / 60;
  const angHorario = 15 * (horaSolar - 12) * RAD;
  const lat = latitude * RAD;
  return {
    e: -Math.cos(declinacao) * Math.sin(angHorario),
    n: Math.sin(declinacao) * Math.cos(lat) - Math.cos(declinacao) * Math.cos(angHorario) * Math.sin(lat),
    u: Math.sin(declinacao) * Math.sin(lat) + Math.cos(declinacao) * Math.cos(angHorario) * Math.cos(lat),
    diaDoAno,
  };
}

/** Fração difusa de Erbs a partir do índice de claridade kt. */
export function fracaoDifusaErbs(kt: number): number {
  if (kt <= 0.22) return 1 - 0.09 * kt;
  if (kt <= 0.8) return 0.9511 - 0.1604 * kt + 4.388 * kt ** 2 - 16.638 * kt ** 3 + 12.336 * kt ** 4;
  return 0.165;
}

/**
 * Irradiância global horizontal → plano dos módulos.
 * @param instante meio do intervalo (UTC)
 * @param azimuteNorte 0 = norte, sentido horário (convenção da spec)
 */
export function ghiParaPoa(
  ghi: number, instante: Date, latitude: number, longitude: number, inclinacao: number, azimuteNorte: number, albedo = 0.2,
): number {
  if (!(ghi > 0)) return 0;
  const sol = vetorSol(instante, latitude, longitude);
  const beta = inclinacao * RAD;
  const fatorCeu = (1 + Math.cos(beta)) / 2;
  const fatorSolo = (1 - Math.cos(beta)) / 2;
  if (sol.u < 0.02) return ghi * fatorCeu + ghi * albedo * fatorSolo; // sol rasante: só difusa

  const i0 = 1367 * (1 + 0.033 * Math.cos((360 * sol.diaDoAno) / 365 * RAD));
  const kt = Math.min(1, Math.max(0, ghi / (i0 * sol.u)));
  const dhi = ghi * fracaoDifusaErbs(kt);
  const dni = Math.min((ghi - dhi) / sol.u, i0);
  const alfa = azimuteNorte * RAD;
  const cosIncidencia = sol.e * Math.sin(beta) * Math.sin(alfa) + sol.n * Math.sin(beta) * Math.cos(alfa) + sol.u * Math.cos(beta);
  return Math.max(0, dni * Math.max(0, cosIncidencia) + dhi * fatorCeu + ghi * albedo * fatorSolo);
}
