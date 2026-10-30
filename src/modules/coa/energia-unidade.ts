export interface ParcelaInversores {
  kwh: number;
  fator: number;
  chaves: string[];
}

/** Geração, Misto (UFV com carga), UFV ou Solar: mesma regra do web e dos apps. */
export const ehUnidadeGeracao = (tipo?: string | null): boolean => {
  const t = (tipo ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return ['geracao', 'misto', 'ufv', 'solar'].some((p) => t.includes(p));
};

/**
 * Energia do dia de uma unidade no COA.
 *
 * Usina (Geração/Misto): é a geração da fonte escolhida, o mesmo número da análise. Não entra
 * medidor nem perdas da config de demanda, e não depende de quais inversores a config marcou.
 * Só o recorte do operador (PER-24) fica na soma dos inversores liberados.
 * Carga: segue a soma da config de demanda.
 */
export function energiaDaUnidade(args: {
  tipo?: string | null;
  base: number;
  parcela?: ParcelaInversores;
  kwhFonte?: number | null;
  chavesServico: string[];
  operador: boolean;
  semTelemetria: boolean;
  fallback: number;
}): number {
  const { tipo, base, parcela, kwhFonte, chavesServico, operador, semTelemetria, fallback } = args;
  if (semTelemetria && kwhFonte == null) return fallback;
  if (!ehUnidadeGeracao(tipo)) return kwhFonte != null && semTelemetria ? kwhFonte : base;
  const servico = new Set(chavesServico);
  const recortado = operador && !!parcela
    && !(parcela.chaves.length === servico.size && parcela.chaves.every((c) => servico.has(c)));
  if (kwhFonte != null && !recortado) return kwhFonte;
  return parcela && parcela.chaves.length > 0 ? parcela.kwh : base;
}
