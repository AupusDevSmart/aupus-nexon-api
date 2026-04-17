/**
 * Helpers para extracao de campos JSON e avaliacao de condicoes.
 */

export interface CampoMqtt {
  path: string;
  tipo: string;
  ultimoValor: number | string | boolean;
}

/**
 * Percorre recursivamente um objeto JSON e retorna todos os campos
 * com valores numericos em dot notation.
 */
export function extrairCamposNumericos(
  obj: any,
  prefixo = '',
): CampoMqtt[] {
  const campos: CampoMqtt[] = [];

  if (!obj || typeof obj !== 'object') return campos;

  for (const key of Object.keys(obj)) {
    const path = prefixo ? `${prefixo}.${key}` : key;
    const valor = obj[key];

    if (typeof valor === 'number' && !isNaN(valor)) {
      campos.push({ path, tipo: 'number', ultimoValor: valor });
    } else if (typeof valor === 'object' && valor !== null && !Array.isArray(valor)) {
      campos.push(...extrairCamposNumericos(valor, path));
    }
  }

  return campos.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Extrai um valor de um objeto JSON usando dot notation.
 */
export function getValueByPath(obj: any, path: string): any {
  return path.split('.').reduce((acc, key) => acc?.[key], obj);
}

/**
 * Avalia uma condicao comparando valor lido com valor da regra.
 */
export function avaliarCondicao(
  valorLido: number,
  operador: string,
  valorRegra: number,
): boolean {
  switch (operador) {
    case '<':
      return valorLido < valorRegra;
    case '>':
      return valorLido > valorRegra;
    case '<=':
      return valorLido <= valorRegra;
    case '>=':
      return valorLido >= valorRegra;
    case '==':
      return valorLido === valorRegra;
    case '!=':
      return valorLido !== valorRegra;
    default:
      return false;
  }
}
