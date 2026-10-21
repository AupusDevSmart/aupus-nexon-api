/**
 * Fonte da geração (NEXON-37): escolha, por unidade e por dia BRT, entre a TON (inversores no
 * broker) e a nuvem do provedor (Fusion/iSolar/Deye). Funções PURAS, testadas em
 * geracao-fonte.spec.ts. Regra e contrato em docs/GERACAO-ANALISE.md, seção "Fonte da geração".
 */
import { inicioDoDiaUtc, diaLocal } from './geracao-datas';

export const FONTES_GERACAO = ['automatico', 'ton', 'nuvem'] as const;
export type FonteGeracaoConfig = (typeof FONTES_GERACAO)[number];

export type FonteDia = 'ton' | 'nuvem' | 'manual';
export type FontePeriodo = FonteDia | 'mista';
export type MotivoFonte =
  | 'manual'
  | 'fixada'
  | 'fixada_sem_dado'
  | 'so_ton'
  | 'so_nuvem'
  | 'sem_dados'
  | 'nuvem_zerada'
  | 'concordam'
  | 'ton_incompleta'
  | 'divergem';

/** Diferença relativa até a qual TON e nuvem "concordam". */
export const LIMIAR_CONCORDAM = 0.05;
/** Fração dos blocos de 15 min do período solar que cada inversor precisa ter para a TON valer completa. */
export const COBERTURA_MINIMA_TON = 0.7;
/** Período solar (hora local): 06:00–18:00. */
export const SOLAR_INICIO_H = 6;
export const SOLAR_FIM_H = 18;
const BLOCOS_SOLARES_DIA = (SOLAR_FIM_H - SOLAR_INICIO_H) * 4;

/** Valor gravado/recebido → fonte da config (desconhecido ou ausente = automatico). */
export function normalizarFonteGeracao(v: unknown): FonteGeracaoConfig {
  const s = String(v ?? '').trim().toLowerCase();
  return (FONTES_GERACAO as readonly string[]).includes(s) ? (s as FonteGeracaoConfig) : 'automatico';
}

export interface EntradaFonte {
  config: FonteGeracaoConfig;
  /** Σ kWh dos inversores no dia (só linhas da TON); null = nenhum inversor com leitura. */
  kwhTon: number | null;
  tonCompleta: boolean;
  /** kWh do dia na nuvem; null = sem linha. */
  kwhNuvem: number | null;
  nuvemCompleta: boolean;
  /** Lançamento manual/BDO do dia; null = não há. */
  kwhManual: number | null;
}

export interface EscolhaFonte {
  fonte: FonteDia | null;
  motivo: MotivoFonte;
  /** kWh da fonte escolhida (null quando nenhuma tem dado). */
  kwh: number | null;
  /** |ton − nuvem| / max(ton, nuvem) × 100, quando as duas têm dado. */
  divergenciaPct: number | null;
}

/** Divergência relativa (0–1) entre TON e nuvem; null sem as duas. */
export function divergencia(ton: number | null, nuvem: number | null): number | null {
  if (ton == null || nuvem == null) return null;
  const max = Math.max(Math.abs(ton), Math.abs(nuvem));
  return max > 0 ? Math.abs(ton - nuvem) / max : 0;
}

/**
 * Regra da escolha (ordem importa):
 * 1. manual → manual (vence até fonte fixada);
 * 2. fixada (ton|nuvem) → ela; sem dado nela e com dado na outra → a outra (fixada_sem_dado);
 * 3. só uma tem dado → ela; nenhuma → null (sem_dados);
 * 4. nuvem = 0 e TON > 0 → ton (nuvem_zerada);
 * 5. divergência ≤ 5% → ton (concordam);
 * 6. TON incompleta e nuvem completa → nuvem (ton_incompleta);
 * 7. senão → ton (divergem).
 */
export function escolherFonte(e: EntradaFonte): EscolhaFonte {
  const div = divergencia(e.kwhTon, e.kwhNuvem);
  const divergenciaPct = div == null ? null : Math.round(div * 1000) / 10;
  const r = (fonte: FonteDia | null, motivo: MotivoFonte): EscolhaFonte => ({
    fonte,
    motivo,
    kwh: fonte === 'ton' ? e.kwhTon : fonte === 'nuvem' ? e.kwhNuvem : fonte === 'manual' ? e.kwhManual : null,
    divergenciaPct,
  });

  if (e.kwhManual != null) return r('manual', 'manual');

  const temTon = e.kwhTon != null;
  const temNuvem = e.kwhNuvem != null;

  if (e.config === 'ton' || e.config === 'nuvem') {
    const fixada = e.config;
    const outra: FonteDia = fixada === 'ton' ? 'nuvem' : 'ton';
    const temFixada = fixada === 'ton' ? temTon : temNuvem;
    const temOutra = fixada === 'ton' ? temNuvem : temTon;
    if (temFixada) return r(fixada, 'fixada');
    if (temOutra) return r(outra, 'fixada_sem_dado');
    return r(null, 'sem_dados');
  }

  if (!temTon && !temNuvem) return r(null, 'sem_dados');
  if (!temNuvem) return r('ton', 'so_ton');
  if (!temTon) return r('nuvem', 'so_nuvem');

  const ton = e.kwhTon as number;
  const nuvem = e.kwhNuvem as number;
  if (nuvem === 0 && ton > 0) return r('ton', 'nuvem_zerada');
  if ((div as number) <= LIMIAR_CONCORDAM) return r('ton', 'concordam');
  if (!e.tonCompleta && e.nuvemCompleta) return r('nuvem', 'ton_incompleta');
  return r('ton', 'divergem');
}

// ── TON do dia ──────────────────────────────────────────────────────────────

/**
 * Blocos de 15 min do período solar (06–18 h local) que já começaram no dia.
 * Dia passado = 48; hoje = até agora; futuro = 0.
 */
export function blocosSolares(dia: string, agora: Date): number {
  const hoje = diaLocal(agora);
  if (dia < hoje) return BLOCOS_SOLARES_DIA;
  if (dia > hoje) return 0;
  const ini = inicioDoDiaUtc(dia).getTime() + SOLAR_INICIO_H * 3_600_000;
  const min = Math.floor((agora.getTime() - ini) / 60_000);
  return Math.max(0, Math.min(BLOCOS_SOLARES_DIA, Math.floor(min / 15)));
}

/** Leitura de UM inversor num dia. */
export interface TonInversorDia {
  /** MAX(daily_yield) válido do dia (kWh); null = o inversor não manda daily_yield. */
  yieldKwh: number | null;
  /** Σ potência média × 0,25 h dos blocos com leitura (fallback sem daily_yield). */
  integralKwh: number;
  /** Blocos de 15 min com leitura dentro do período solar. */
  blocosSolares: number;
}

export interface TonDia {
  kwh: number | null;
  completa: boolean;
}

/**
 * kWh e completude da TON no dia. `leituras` = só os inversores que tiveram leitura;
 * `nInversores` = todos os configurados (inversor sem leitura = TON incompleta).
 */
export function agregarTonDia(leituras: TonInversorDia[], nInversores: number, solares: number): TonDia {
  if (!leituras.length) return { kwh: null, completa: false };
  const kwh = leituras.reduce((s, l) => s + (l.yieldKwh ?? l.integralKwh), 0);
  const minimo = COBERTURA_MINIMA_TON * solares;
  const completa = nInversores > 0 && leituras.length >= nInversores && leituras.every((l) => l.blocosSolares >= minimo);
  return { kwh, completa };
}

// ── Período ─────────────────────────────────────────────────────────────────

export interface DiaFonte extends EscolhaFonte {
  data: string;
  kwhTon: number | null;
  kwhNuvem: number | null;
  kwhManual: number | null;
}

/** Fonte de um conjunto de dias: a única usada, 'mista' se mais de uma, null sem dado. */
export function fonteDoGrupo(dias: Array<Pick<DiaFonte, 'fonte'>>): FontePeriodo | null {
  const usadas = new Set(dias.map((d) => d.fonte).filter((f): f is FonteDia => f != null));
  if (!usadas.size) return null;
  if (usadas.size > 1) return 'mista';
  return [...usadas][0];
}

/** Selo curto que web e apps mostram perto do total. null = período sem dado. */
export function seloFonte(escolhida: FontePeriodo | null, divergem: boolean): string | null {
  if (divergem) return 'Fontes divergem — usando TON';
  switch (escolhida) {
    case 'ton': return 'Fonte: TON';
    case 'nuvem': return 'Fonte: nuvem';
    case 'manual': return 'Fonte: manual';
    case 'mista': return 'Fontes: TON e nuvem';
    default: return null;
  }
}

const somaOuNull = (vals: Array<number | null>): number | null => {
  const v = vals.filter((x): x is number => x != null);
  return v.length ? v.reduce((s, x) => s + x, 0) : null;
};

export interface ResumoFontes {
  escolhida: FontePeriodo | null;
  divergem: boolean;
  selo: string | null;
  kwh: number | null;
  kwhTon: number | null;
  kwhNuvem: number | null;
}

/** Resumo de um período (ou de um ponto do gráfico) a partir dos dias. */
export function resumirFontes(dias: DiaFonte[]): ResumoFontes {
  const escolhida = fonteDoGrupo(dias);
  const divergem = dias.some((d) => d.motivo === 'divergem');
  return {
    escolhida,
    divergem,
    selo: seloFonte(escolhida, divergem),
    kwh: somaOuNull(dias.map((d) => d.kwh)),
    kwhTon: somaOuNull(dias.map((d) => d.kwhTon)),
    kwhNuvem: somaOuNull(dias.map((d) => d.kwhNuvem)),
  };
}
