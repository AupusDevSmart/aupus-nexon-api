import { Transform } from 'class-transformer';

/**
 * Campo opcional de cadastro: texto vazio (ou so espacos) e null vira null.
 *
 * Le o valor como chegou (`obj[key]`), antes da conversao implicita do pipe
 * global (`enableImplicitConversion` em main.ts): num campo numerico ela faz
 * Number("") = 0, e a latitude vazia seria gravada como zero, plotando a
 * instalacao no meio do Atlantico. Booleano num campo numerico vira NaN, que
 * o IsNumber recusa (a conversao fazia true = 1).
 *
 * Com o null, o `@IsOptional()` pula as demais validacoes; no create o campo
 * fica sem valor e no update o valor gravado e apagado. Mesmo nome e mesma
 * regra do `@VazioEhNulo()` do aupus-service-api.
 */
export function VazioEhNulo() {
  return Transform(({ obj, key, value }) => {
    const bruto = (obj as Record<string, unknown>)[key];
    if (bruto === null) return null;
    if (typeof bruto === 'string' && bruto.trim() === '') return null;
    if (typeof bruto === 'boolean' && typeof value === 'number') return Number.NaN;
    return value;
  });
}
