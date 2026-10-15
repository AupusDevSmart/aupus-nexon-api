/**
 * Resumo do ciclo do medidor da concessionária (modal web NEXON-5) — lógica PURA,
 * testada em medidor-resumo.util.spec.ts.
 *
 * Entrada: blocos de 15 min (potência média do bloco: kW de consumo/injeção e kvar
 * indutivo/capacitivo). kWh/kvarh do bloco = potência × 0,25 h.
 *
 * Regras (ANEEL, REN 1000 — reativo excedente):
 *  - FP do bloco = kW / √(kW² + kvar²), com kvar = |ind − cap|; natureza pelo sinal.
 *  - Só blocos com consumo entram em FP (bloco de pura injeção não tem FP de carga).
 *  - Reativo excedente do bloco com FP < 0,92 = kWh × (0,92 / FP − 1).
 *  - FP médio do ciclo = Σ kWh / √(Σ kWh² + Σ kvarh²) (kvarh resultante).
 */

export interface Bloco15 { t: number; kWc: number; kWi: number; kvarInd: number; kvarCap: number }

export interface ResumoReativo {
  injecao_max: { kw: number; t: number } | null;
  consumo_max: { kw: number; t: number } | null;
  fp_min_ind: { fp: number; t: number } | null;
  fp_min_cap: { fp: number; t: number } | null;
  fp_medio: number | null;
  reativo_max: { kvar: number; t: number; natureza: 'ind' | 'cap' } | null;
  energia_reativa_kvarh: number;
  reativo_excedente_kvarh: number;
  consumo_kwh: number;
  injecao_kwh: number;
  blocos: number;
}

export const FP_LIMITE = 0.92;
/** Consumo mínimo (kW) para o bloco entrar nas contas de FP: ruído de medidor parado fica fora. */
const KW_MIN_FP = 0.5;

export function resumoBlocos(blocos: Bloco15[], limite = FP_LIMITE): ResumoReativo {
  const r: ResumoReativo = {
    injecao_max: null, consumo_max: null, fp_min_ind: null, fp_min_cap: null, fp_medio: null, reativo_max: null,
    energia_reativa_kvarh: 0, reativo_excedente_kvarh: 0, consumo_kwh: 0, injecao_kwh: 0, blocos: blocos.length,
  };
  let sp = 0, sq = 0;
  for (const b of blocos) {
    const kWc = Math.max(0, b.kWc || 0), kWi = Math.max(0, b.kWi || 0);
    const qi = Math.max(0, b.kvarInd || 0), qc = Math.max(0, b.kvarCap || 0);
    r.consumo_kwh += kWc * 0.25;
    r.injecao_kwh += kWi * 0.25;
    r.energia_reativa_kvarh += (qi + qc) * 0.25;
    if (kWi > 0 && (!r.injecao_max || kWi > r.injecao_max.kw)) r.injecao_max = { kw: kWi, t: b.t };
    if (kWc > 0 && (!r.consumo_max || kWc > r.consumo_max.kw)) r.consumo_max = { kw: kWc, t: b.t };
    const q = qi - qc;
    if (Math.abs(q) > 0 && (!r.reativo_max || Math.abs(q) > r.reativo_max.kvar)) {
      r.reativo_max = { kvar: Math.abs(q), t: b.t, natureza: q >= 0 ? 'ind' : 'cap' };
    }
    if (kWc < KW_MIN_FP) continue;
    sp += kWc * 0.25; sq += q * 0.25;
    const fp = kWc / Math.sqrt(kWc ** 2 + q ** 2);
    if (q >= 0) { if (!r.fp_min_ind || fp < r.fp_min_ind.fp) r.fp_min_ind = { fp, t: b.t }; }
    else if (!r.fp_min_cap || fp < r.fp_min_cap.fp) r.fp_min_cap = { fp, t: b.t };
    if (fp < limite) r.reativo_excedente_kvarh += kWc * 0.25 * (limite / fp - 1);
  }
  r.fp_medio = sp > 0 ? sp / Math.sqrt(sp ** 2 + sq ** 2) : null;
  return r;
}
