/**
 * Contas do relatório de consumo (NEXON-33) — lógica PURA, testada em consumo.spec.ts.
 *
 * Entrada: blocos de 15 min do medidor da instalação (o mesmo Bloco15 do resumo do medidor,
 * medidor-resumo.util.ts): kW de consumo/injeção e kvar indutivo/capacitivo; `t` = fim do bloco.
 */

import { arred } from './disponibilidade';
import { diaLocal, horaLocal, somarMeses } from './periodo';
import { percentil } from './pivo-operacao';

export interface Bloco {
  t: number;
  kWc: number;
  kWi: number;
  kvarInd: number;
  kvarCap: number;
}

export const FP_REFERENCIA = 0.92;
const KW_MIN_FP = 0.5;

/** Hora local (0–23) em que o bloco aconteceu (t é o fim da janela). */
export function horaDoBloco(t: number): number {
  return Math.floor(horaLocal(t - 60_000)) % 24;
}

/**
 * Intervalos de 15 min com FP abaixo de 0,92 — mesmas regras do reativo excedente (REN 1000
 * art. 297): só blocos com consumo; indutivo conta das 06h às 24h, capacitivo das 00h às 06h.
 */
export function intervalosFpBaixo(blocos: Bloco[], limite = FP_REFERENCIA, hora: (t: number) => number = horaDoBloco): number {
  let n = 0;
  for (const b of blocos) {
    const kWc = Math.max(0, b.kWc || 0);
    if (kWc < KW_MIN_FP) continue;
    const q = Math.max(0, b.kvarInd || 0) - Math.max(0, b.kvarCap || 0);
    const madrugada = hora(b.t) < 6;
    const conta = q >= 0 ? !madrugada : madrugada;
    if (!conta) continue;
    if (kWc / Math.sqrt(kWc ** 2 + q ** 2) < limite) n++;
  }
  return n;
}

/** Parcela indutiva do reativo (%). Sem reativo → null. */
export function reativoIndutivoPct(blocos: Bloco[]): number | null {
  let ind = 0;
  let cap = 0;
  for (const b of blocos) {
    ind += Math.max(0, b.kvarInd || 0);
    cap += Math.max(0, b.kvarCap || 0);
  }
  return ind + cap > 0 ? arred((ind / (ind + cap)) * 100, 1) : null;
}

/** Carga base = P10 da demanda de consumo nos blocos medidos (o "piso" da instalação). */
export function cargaBaseKw(blocos: Bloco[]): number | null {
  const p = percentil(blocos.map((b) => Math.max(0, b.kWc || 0)), 10);
  return p === null ? null : arred(p, 1);
}

/** Blocos com demanda acima da contratada + tolerância. Sem contratada → null. */
export function ultrapassagens(blocos: Bloco[], contratadaKw: number | null, toleranciaPct = 5): number | null {
  if (!contratadaKw || contratadaKw <= 0) return null;
  const lim = contratadaKw * (1 + toleranciaPct / 100);
  return blocos.filter((b) => (b.kWc || 0) > lim).length;
}

/**
 * Curva típica: kW médio por hora (24 posições) em dia útil e em fim de semana/feriado.
 * Hora sem bloco medido → null.
 */
export function curvaTipica(blocos: Bloco[], diaUtil: (dia: string) => boolean): { diaUtil: Array<number | null>; fimDeSemana: Array<number | null> } | null {
  if (!blocos.length) return null;
  const soma = { u: new Array(24).fill(0), f: new Array(24).fill(0) };
  const n = { u: new Array(24).fill(0), f: new Array(24).fill(0) };
  for (const b of blocos) {
    const h = horaDoBloco(b.t);
    const k = diaUtil(diaLocal(b.t - 60_000)) ? 'u' : 'f';
    soma[k][h] += Math.max(0, b.kWc || 0);
    n[k][h] += 1;
  }
  const media = (k: 'u' | 'f') => soma[k].map((s: number, h: number) => (n[k][h] ? arred(s / n[k][h], 1) : null));
  return { diaUtil: media('u'), fimDeSemana: media('f') };
}

/** 12 meses terminando em `mes` (mais antigo primeiro); mês sem leitura → null. */
export function demanda12m(mes: string, porMes: Map<string, number>): Array<{ mes: string; maxKw: number | null }> {
  const out: Array<{ mes: string; maxKw: number | null }> = [];
  for (let i = 11; i >= 0; i--) {
    const m = somarMeses(mes, -i);
    const v = porMes.get(m);
    out.push({ mes: m, maxKw: v === undefined || v === null ? null : arred(v, 1) });
  }
  return out;
}

export type Posto = 'ponta' | 'foraPonta' | 'reservado';

/** Soma kWh de consumo por posto tarifário (o classificador decide o posto de cada bloco). */
export function energiaPorPosto(blocos: Array<{ t: number; kWc: number }>, posto: (t: number) => Posto): { pontaKwh: number; foraPontaKwh: number; reservadoKwh: number } | null {
  if (!blocos.length) return null;
  const r = { pontaKwh: 0, foraPontaKwh: 0, reservadoKwh: 0 };
  for (const b of blocos) {
    const kwh = Math.max(0, b.kWc || 0) * 0.25;
    const p = posto(b.t);
    if (p === 'ponta') r.pontaKwh += kwh;
    else if (p === 'reservado') r.reservadoKwh += kwh;
    else r.foraPontaKwh += kwh;
  }
  return { pontaKwh: arred(r.pontaKwh, 1), foraPontaKwh: arred(r.foraPontaKwh, 1), reservadoKwh: arred(r.reservadoKwh, 1) };
}

/** Maior demanda de consumo do período (bloco de 15 min). */
export function demandaMaxima(blocos: Bloco[]): { kw: number; t: number } | null {
  let m: { kw: number; t: number } | null = null;
  for (const b of blocos) if ((b.kWc || 0) > 0 && (!m || b.kWc > m.kw)) m = { kw: b.kWc, t: b.t };
  return m;
}

/** "tarifa verde A4" / "tarifa convencional B3" (o NexON precifica todo grupo A como verde). */
export function modalidadeTarifaria(grupo: string | null, subgrupo: string | null): string | null {
  const g = String(grupo ?? '').trim().toUpperCase();
  const s = String(subgrupo ?? '').trim();
  if (g === 'A') return `tarifa verde${s ? ` ${s.toUpperCase().replace(/VERDE|AZUL/g, '').trim()}` : ''}`;
  if (g === 'B') return `tarifa convencional${s ? ` ${s.toUpperCase()}` : ' B'}`;
  return null;
}
