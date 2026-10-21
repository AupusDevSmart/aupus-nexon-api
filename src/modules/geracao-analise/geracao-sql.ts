import { Prisma } from '@/core';

/** Texto do JSON → numeric só quando for número (um "N/A" não pode derrubar a consulta). */
export function sqlNum(expr: string): Prisma.Sql {
  return Prisma.raw(`(CASE WHEN (${expr}) ~ '^\\s*-?[0-9]+(\\.[0-9]+)?([eE][-+]?[0-9]+)?\\s*$' THEN (${expr})::numeric END)`);
}

/**
 * Chave de dedup do inversor (alias `e` = equipamentos): o broker grava uma linha por
 * equipamento inscrito no mesmo tópico MQTT — mesma chave = mesmo inversor físico.
 */
export const SQL_CHAVE_INVERSOR = `COALESCE(NULLIF(TRIM(e.topico_mqtt), ''), TRIM(e.id))`;

/** Potência ativa (kW) de uma linha de equipamentos_dados. */
export const POTENCIA_KW = Prisma.sql`COALESCE(potencia_ativa_kw,
  ${sqlNum("dados->'power'->>'active_total'")} / 1000.0,
  ${sqlNum("dados->>'potencia_kw'")},
  ${sqlNum("dados->>'active_power'")} / 1000.0)`;

/**
 * daily_yield (kWh) da linha, só a partir das 04:00 locais: inversor que zera tarde ainda
 * manda o total de ontem de madrugada (mesma regra do boletim diário). Faixa válida 0–20 000
 * kWh por inversor (teto anti-glitch do boletim) aplicada no agregado.
 */
export const YIELD_KWH = Prisma.sql`(CASE WHEN extract(hour FROM timestamp_dados - interval '3 hours') >= 4
  THEN ${sqlNum("COALESCE(dados->'energy'->>'daily_yield', dados->>'daily_yield')")} END)`;
export const YIELD_MAX_KWH = 20000;

/**
 * Só linhas da TON: o fallback de nuvem do Fusion grava em equipamentos_dados com
 * fonte = 'NUVEM_FUSION' e não pode contar como TON. MOCK também fica de fora.
 */
export const FILTRO_TON = Prisma.sql`COALESCE(fonte, '') <> 'NUVEM_FUSION' AND COALESCE(qualidade, '') <> 'MOCK'`;

/**
 * Coluna nova ainda sem o SQL aplicado (NEXON-37): o código degrada em vez de dar 500 e
 * tenta de novo a cada 10 min (o SQL pode ser aplicado com a API no ar).
 */
export class ColunaOpcional {
  private ausenteAte = 0;
  constructor(private readonly colunas: RegExp) {}

  disponivel(): boolean {
    return Date.now() >= this.ausenteAte;
  }

  /** true quando o erro é "coluna não existe" de uma das colunas: marca ausente e o chamador degrada. */
  ausente(e: unknown): boolean {
    const msg = String((e as Error)?.message ?? e ?? '');
    if (!this.colunas.test(msg) || !/(does not exist|não existe|42703)/i.test(msg)) return false;
    this.ausenteAte = Date.now() + 10 * 60_000;
    return true;
  }
}
