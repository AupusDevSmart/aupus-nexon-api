/**
 * Calibração do ângulo do pivô (NEXON-103) — lógica PURA, testada em
 * pivo-calibracao.util.spec.ts.
 *
 * O encoder entrega uma contagem bruta que não é o azimute. A calibração associa
 * UMA leitura do encoder (`bruto_cal`) ao azimute real do braço medido em campo
 * (`az_cal`, do centro até a ponta, 0° = norte verdadeiro, crescendo no horário):
 *
 *   ângulo = ( az_cal + s · (bruto − bruto_cal) · 360/resolução ) mod 360
 *
 * com s = +1 quando a contagem AUMENTA com o pivô andando no sentido horário e
 * s = −1 quando diminui. Com encoder de 360 posições (o do piloto) o fator é 1 e a
 * fórmula fica igual à da spec.
 *
 * Na TON a conta é a mesma, escrita como resolução + sentido + zero (`pivo enc`,
 * ver zeroDaCalibracao): a placa calcula sozinha, sem internet.
 */
import { norm180, norm360 } from './pivo-posicao.util';

export type Sentido = 1 | -1;

export interface PontoGeo {
  lat: number;
  lon: number;
}

export interface Calibracao {
  az_cal: number;
  bruto_cal: number;
  sentido: Sentido;
}

/** Centro e ponta mais perto que isto: o azimute fica na mão do erro do GPS. */
export const DISTANCIA_MIN_M = 50;
/** "Ler encoder" faz este tanto de leituras seguidas… */
export const LEITURAS_CALIBRACAO = 5;
/** …e elas podem variar no máximo isto (em contagens), já contando a virada da volta. */
export const VARIACAO_MAX_LEITURAS = 1;

const rad = (g: number) => (g * Math.PI) / 180;
const graus = (r: number) => (r * 180) / Math.PI;
const arred = (v: number, casas: number) => Math.round(v * 10 ** casas) / 10 ** casas;

export function coordenadaValida(p: Partial<PontoGeo> | null | undefined): p is PontoGeo {
  return !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon)
    && Math.abs(p.lat as number) <= 90 && Math.abs(p.lon as number) <= 180;
}

/** Azimute do braço (centro → ponta): 0° = norte verdadeiro, horário, 0 a 359,99. */
export function azimute(centro: PontoGeo, ponta: PontoGeo): number {
  const lat1 = rad(centro.lat), lat2 = rad(ponta.lat);
  const dLon = rad(ponta.lon - centro.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const az = arred(norm360(graus(Math.atan2(y, x))), 2);
  return az >= 360 ? 0 : az;
}

/** Distância entre os dois pontos, em metros (haversine, raio médio da Terra). */
export function distanciaM(a: PontoGeo, b: PontoGeo): number {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const naVolta = (bruto: number, resolucao: number) => ((Math.round(bruto) % resolucao) + resolucao) % resolucao;

/** Ângulo em operação (seção 4.3 da spec), 0 a 359,99. */
export function anguloCalibrado(bruto: number, cal: Calibracao, resolucao: number): number {
  const passo = 360 / resolucao;
  const a = arred(norm360(cal.az_cal + cal.sentido * (naVolta(bruto, resolucao) - naVolta(cal.bruto_cal, resolucao)) * passo), 2);
  return a >= 360 ? 0 : a;
}

/**
 * A mesma calibração no formato que a TON e o pivo-posicao.util já usam
 * (resolução, invertido, zero): zero = az_cal − s · bruto_cal · 360/resolução.
 * Zero em −180 a 180, duas casas (é o que vai no `pivo enc`).
 */
export function zeroDaCalibracao(cal: Calibracao, resolucao: number): { zero: number; invertido: boolean } {
  const z = arred(norm180(cal.az_cal - cal.sentido * naVolta(cal.bruto_cal, resolucao) * (360 / resolucao)), 2);
  return { zero: Object.is(z, -0) ? 0 : z, invertido: cal.sentido === -1 };
}

/** Menor diferença b − a numa volta de `volta` posições (ou graus): −volta/2 a volta/2. */
export function deltaCircular(a: number, b: number, volta = 360): number {
  let d = (b - a) % volta;
  if (d > volta / 2) d -= volta;
  if (d <= -volta / 2) d += volta;
  return d;
}

export interface LeituraEncoder {
  valida: boolean;
  /** Contagem aceita (a mais repetida; empate = a primeira lida). */
  valor: number | null;
  leituras: number[];
  motivo: string | null;
}

/**
 * As 5 leituras seguidas do "Ler encoder": aceita só se vieram todas, sem erro, e
 * iguais ou variando no máximo ±1. A virada 359 → 0 conta como 1 (com a resolução);
 * sem resolução compara direto.
 */
export function avaliarLeituras(leituras: number[], resolucao: number | null, erros = 0): LeituraEncoder {
  const ls = leituras.filter((v) => Number.isFinite(v) && v >= 0).map((v) => Math.round(v));
  const base = { valida: false, valor: null, leituras: ls };
  if (erros > 0 || ls.length < LEITURAS_CALIBRACAO) {
    return { ...base, motivo: ls.length ? `Encoder falhou em ${Math.max(erros, LEITURAS_CALIBRACAO - ls.length)} de ${LEITURAS_CALIBRACAO} leituras` : 'Encoder sem resposta' };
  }
  let maior = 0;
  for (const a of ls) for (const b of ls) {
    const d = Math.abs(resolucao ? deltaCircular(naVolta(a, resolucao), naVolta(b, resolucao), resolucao) : b - a);
    if (d > maior) maior = d;
  }
  if (maior > VARIACAO_MAX_LEITURAS) {
    return { ...base, motivo: `Leitura instável: variou ${maior} posições em ${LEITURAS_CALIBRACAO} leituras (o pivô está parado?)` };
  }
  const conta = new Map<number, number>();
  for (const v of ls) conta.set(v, (conta.get(v) ?? 0) + 1);
  let valor = ls[0];
  for (const v of ls) if ((conta.get(v) ?? 0) > (conta.get(valor) ?? 0)) valor = v;
  return { valida: true, valor, leituras: ls, motivo: null };
}

/**
 * Ack do `pivo encler`: "pivo_el <v1> <v2> <v3> <v4> <v5>" (todas boas) ou
 * "pivo_el_erro <quantas leu antes de falhar>".
 */
export function lerAckEncoder(msg: string): { leituras: number[]; erros: number } | null {
  const m = String(msg ?? '').trim();
  const erro = /^pivo_el_erro\s+(\d+)/.exec(m);
  if (erro) return { leituras: [], erros: Math.max(1, LEITURAS_CALIBRACAO - Number(erro[1])) };
  if (!/^pivo_el(\s+\d+)+$/.test(m)) return null;
  const leituras = m.split(/\s+/).slice(1).map(Number);
  return { leituras, erros: 0 };
}

// ============================================================================
// Alarmes (seção 7 da spec) — acompanhamento amostra a amostra, sem banco
// ============================================================================

/** Ângulo andando mais que isto no sentido contrário ao do comando = sentido invertido. */
export const SENTIDO_INVERTIDO_GRAUS = 2;
/** Pivô girando com o ângulo parado por este tempo = travado (padrão; `travado_min` da Configuração). */
export const TRAVADO_MIN_PADRAO = 10;
export const TRAVADO_MIN_FAIXA = { min: 1, max: 240 } as const;

export interface AcompanhaSentido {
  dir: 'D' | 'E';
  ultimo: number;
  /** Soma dos passos desde que este comando começou (+ = horário). A virada 359→0 soma +1. */
  acumulado: number;
}

/**
 * Sentido invertido: com o comando Direita ativo o ângulo tem de AUMENTAR (Esquerda,
 * diminuir). Soma os passos curtos entre amostras — ruído de ±1 se anula e a virada
 * 359 → 0 não vira salto. Passou de 2° no sentido contrário: alarme.
 */
export function passoSentido(
  ant: AcompanhaSentido | null,
  dir: 'D' | 'E' | null,
  angulo: number | null,
): { estado: AcompanhaSentido | null; invertido: boolean; contrario: number } {
  if (!dir || angulo == null) return { estado: null, invertido: false, contrario: 0 };
  if (!ant || ant.dir !== dir) return { estado: { dir, ultimo: angulo, acumulado: 0 }, invertido: false, contrario: 0 };
  const acumulado = ant.acumulado + deltaCircular(ant.ultimo, angulo);
  const contrario = dir === 'D' ? -acumulado : acumulado;
  return { estado: { dir, ultimo: angulo, acumulado }, invertido: contrario > SENTIDO_INVERTIDO_GRAUS, contrario: arred(Math.max(0, contrario), 1) };
}

export interface AcompanhaTravado {
  /** Ângulo de referência: o da última vez que o pivô andou de verdade. */
  ref: number;
  desde: number;
}

/**
 * Menor movimento que conta como "andou": um passo do encoder (360/resolução), com
 * piso de 0,3° — em encoder fino o ruído de uma contagem não pode zerar o relógio.
 */
export function passoMinimoGraus(resolucao: number | null): number {
  return Math.max(0.3, resolucao ? 360 / resolucao : 1);
}

/**
 * Prazo do "pivô travado" (ms): o configurado, mas nunca menor que o DOBRO do tempo
 * que o pivô leva para andar um passo do encoder na velocidade atual. A 10 % com
 * volta de 21 h, 1° leva 35 min: 10 min fixos alarmariam com o pivô andando.
 */
export function prazoTravadoMs(minutos: number, resolucao: number | null, tempoVolta100h: number | null, percentual: number | null): number {
  const base = Math.max(TRAVADO_MIN_FAIXA.min, Math.min(TRAVADO_MIN_FAIXA.max, Number.isFinite(minutos) && minutos > 0 ? minutos : TRAVADO_MIN_PADRAO)) * 60_000;
  if (!tempoVolta100h || !percentual || percentual <= 0) return base;
  const voltaMs = (tempoVolta100h * 3_600_000) / (percentual / 100);
  return Math.max(base, 2 * voltaMs * (passoMinimoGraus(resolucao) / 360));
}

/** Pivô travado: girando (contator de força ligado) e o ângulo parado além do prazo. */
export function passoTravado(
  ant: AcompanhaTravado | null,
  girando: boolean,
  angulo: number | null,
  agora: number,
  prazoMs: number,
  resolucao: number | null,
): { estado: AcompanhaTravado | null; travado: boolean; paradoMs: number } {
  if (!girando || angulo == null) return { estado: null, travado: false, paradoMs: 0 };
  if (!ant || Math.abs(deltaCircular(ant.ref, angulo)) >= passoMinimoGraus(resolucao)) {
    return { estado: { ref: angulo, desde: agora }, travado: false, paradoMs: 0 };
  }
  const paradoMs = agora - ant.desde;
  return { estado: ant, travado: paradoMs >= prazoMs, paradoMs };
}
