/**
 * Capacidades por modelo de TON — espelho backend do TON_CAPS do frontend
 * (AupusNexOn/public/iot-diagram.v2.js, fonte canônica das contagens).
 *
 * Regra do briefing TON-V2 (§2 opção B / §4.2): diferenças entre modelos são
 * DADOS, nunca ramificação — proibido comparar tipo por igualdade exata em
 * expressão (ex.: `tipo === 'ton3' || tipo === 'ton4'` deixaria os *v2 de fora
 * em silêncio).
 *
 * Chaves em minúsculas como no diagrama ('ton1'..'ton4v2');
 * `equipamentos.tipo_equipamento` guarda o mesmo valor em MAIÚSCULAS
 * (iot.service.ensureTonEquipamentos grava `tipo.toUpperCase()`).
 */
export interface TonCaps {
  lora: boolean;
  comando: boolean;
  versao: 1 | 2;
  bi_count: number;
  bo_count: number;
  pwm_count: number;
}

export const TON_CAPS: Record<string, TonCaps> = {
  ton1: { lora: false, comando: false, versao: 1, bi_count: 6, bo_count: 0, pwm_count: 0 },
  ton2: { lora: true, comando: false, versao: 1, bi_count: 6, bo_count: 0, pwm_count: 0 },
  ton3: { lora: false, comando: true, versao: 1, bi_count: 6, bo_count: 6, pwm_count: 0 },
  ton4: { lora: true, comando: true, versao: 1, bi_count: 6, bo_count: 6, pwm_count: 0 },
  ton1v2: { lora: false, comando: false, versao: 2, bi_count: 8, bo_count: 0, pwm_count: 8 },
  ton2v2: { lora: true, comando: false, versao: 2, bi_count: 8, bo_count: 0, pwm_count: 8 },
  ton3v2: { lora: false, comando: true, versao: 2, bi_count: 8, bo_count: 8, pwm_count: 8 },
  ton4v2: { lora: true, comando: true, versao: 2, bi_count: 8, bo_count: 8, pwm_count: 8 },
};

/** Aceita 'ton4v2', 'TON4V2', com espaços — ou null (equipamento legado). */
export function tonCapsForTipo(tipo?: string | null): TonCaps | null {
  if (!tipo) return null;
  return TON_CAPS[String(tipo).trim().toLowerCase()] ?? null;
}

/** Quantidade de BIs (entradas d1..dN) do modelo. Legado/desconhecido = 6. */
export function tonBiCount(tipoEquipamento?: string | null): number {
  return tonCapsForTipo(tipoEquipamento)?.bi_count ?? 6;
}

/**
 * Máximo de BOs (relés) configuráveis no modelo. Modelos v1 e legado/desconhecido
 * mantêm o comportamento histórico (6 — a v1 nunca bloqueou por modelo, nem em
 * ton1/ton2); os v2 usam o dado real (8 nos ton3v2/ton4v2, 0 nos sem relé).
 */
export function tonBoMax(tipoEquipamento?: string | null): number {
  const caps = tonCapsForTipo(tipoEquipamento);
  if (!caps) return 6;
  return caps.versao === 2 ? caps.bo_count : 6;
}

/**
 * Número de entradas ANALÓGICAS (AI) configuráveis. Hoje 2 pra todos os modelos:
 * v1 tem AN1/AN2 (IO6/7, com ADC nativo); v2 idem (AN_C 4-20mA em IO39/40 tem
 * ressalva de ADC — ver base de conhecimento TON2). Ajustar por modelo se mudar.
 */
export function tonAiCount(_tipoEquipamento?: string | null): number {
  return 2;
}
