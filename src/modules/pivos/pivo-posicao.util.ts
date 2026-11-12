/**
 * Posição do pivô pelo encoder absoluto (ex.: Hohner Série 67) — lógica PURA,
 * testada em pivo-posicao.util.spec.ts.
 *
 * A TON lê a contagem bruta do encoder (catálogo `encoder_posicao`, campo
 * `posicao`) e publica como um dispositivo Modbus qualquer. Aqui ela vira ângulo:
 *   1. só a parte de uma volta: bruto mod resolução (encoder multivolta soma as voltas);
 *   2. em graus: × 360 / resolução;
 *   3. sentido: encoder montado ao contrário → 360 − ângulo;
 *   4. zero: + correção do ângulo zero (Configuração do pivô), normalizado em 0–360.
 * O encoder fica no centro do pivô, uma volta do eixo = uma volta do pivô.
 */

export interface ParametrosEncoder {
  /** Equipamento do encoder (criado pelo diagrama IoT). null = pivô sem encoder. */
  equipamentoId: string | null;
  /** Posições por volta (360, 2048, 4096, 8192…), do código de compra. */
  resolucao: number | null;
  /** Encoder conta ao contrário do sentido de Avanço. */
  invertido: boolean;
  /** Correção do ângulo zero (°), −180 a 180. */
  zero: number;
}

/** Faixa aceita da resolução: até 2^24, o maior inteiro exato no float da TON. */
export const RESOLUCAO_MIN = 16;
export const RESOLUCAO_MAX = 16_777_216;

export const norm360 = (g: number): number => ((g % 360) + 360) % 360;
export const norm180 = (g: number): number => {
  const n = norm360(g);
  return n > 180 ? n - 360 : n;
};
const arred = (v: number, casas: number): number => Math.round(v * 10 ** casas) / 10 ** casas;

/** pivo_config.parametros → parâmetros do encoder (campos ausentes/ruins viram null/padrão). */
export function parametrosEncoder(p: Record<string, unknown> | null | undefined): ParametrosEncoder {
  const id = typeof p?.encoder_equipamento_id === 'string' ? p.encoder_equipamento_id.trim() : '';
  const r = Number(p?.encoder_resolucao);
  const z = Number(p?.correcao_angulo_zero);
  return {
    equipamentoId: id || null,
    resolucao: Number.isInteger(r) && r >= RESOLUCAO_MIN && r <= RESOLUCAO_MAX ? r : null,
    invertido: p?.encoder_invertido === true,
    zero: Number.isFinite(z) ? z : 0,
  };
}

/** Contagem bruta do JSON publicado pela TON (`posicao`; aceita `pos`). null se não houver. */
export function brutoDoEncoder(dados: unknown): number | null {
  const d = (dados ?? {}) as Record<string, unknown>;
  const v = d.posicao ?? d.pos;
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/**
 * Contagem bruta → ângulo do pivô.
 * `anguloSemZero` = ângulo antes da correção do zero (é o que o botão "Zerar aqui" usa).
 */
export function anguloDoEncoder(
  bruto: number,
  cfg: Pick<ParametrosEncoder, 'resolucao' | 'invertido' | 'zero'>,
): { angulo: number; anguloSemZero: number } | null {
  if (cfg.resolucao == null || !Number.isFinite(bruto)) return null;
  const volta = ((Math.round(bruto) % cfg.resolucao) + cfg.resolucao) % cfg.resolucao;
  let g = (volta * 360) / cfg.resolucao;
  if (cfg.invertido) g = norm360(360 - g);
  const semZero = arred(norm360(g), 2);
  return { angulo: arred(norm360(g + cfg.zero), 2), anguloSemZero: semZero };
}

/** Correção que faz a posição atual virar 0° (−180 a 180, uma casa). */
export function zeroParaAqui(anguloSemZero: number): number {
  const z = arred(norm180(-anguloSemZero), 1);
  return Object.is(z, -0) ? 0 : z;
}

/**
 * A TON que lê um encoder: aquela cujo Tópico Base é o começo do tópico do encoder
 * (`<base da TON>/<Nome>_<end>/data`). Com mais de uma candidata vale a de tópico mais longo
 * (satélite debaixo do gateway). null = encoder sem tópico ou de TON que não existe mais.
 */
export function tonDoEncoder<T extends { topico: string }>(topicoEncoder: string | null | undefined, tons: T[]): T | null {
  const t = (topicoEncoder ?? '').trim();
  if (!t) return null;
  let melhor: T | null = null;
  for (const ton of tons) {
    const base = (ton.topico ?? '').trim();
    if (base && t.startsWith(`${base}/`) && (!melhor || base.length > melhor.topico.trim().length)) melhor = ton;
  }
  return melhor;
}
