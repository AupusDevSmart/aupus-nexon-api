/**
 * Mirror backend do mapeamento categoria -> fluxo de energia.
 *
 * FONTE DA VERDADE: AupusNexOn/src/features/supervisorio/utils/categoria-fluxo.ts
 * (front). Mantenha este arquivo em SINCRONIA com aquele — ha um teste de
 * paridade (categoria-fluxo.backend.spec.ts) que falha se divergirem.
 *
 * Usado pelo COA (coa.service.ts) pra calcular a "Energia Hoje" por unidade
 * seguindo a configuracao do grafico de demanda (mesmos equipamentos + sinal
 * por categoria), em vez de agregar todos os equipamentos.
 *
 * O sinal replica AupusNexOn/src/hooks/useDemandaAgregada.ts (paraInput):
 *   NEUTRO / AMBIGUO-sem-fluxo_manual -> excluido (0)
 *   CONSUMO -> -1
 *   GERACAO / BIDIRECIONAL -> +1
 * AMBIGUO entra como excluido porque fluxo_manual nao e persistido (nem no
 * grafico, que tambem o perde no reload) — paridade exata.
 */
export type FluxoEnergia =
  | 'GERACAO'
  | 'CONSUMO'
  | 'BIDIRECIONAL'
  | 'NEUTRO'
  | 'AMBIGUO';

export const CATEGORIA_FLUXO: Record<string, FluxoEnergia> = {
  // Inequivocos — geracao
  'Inversor PV': 'GERACAO',
  'Módulos PV': 'GERACAO',

  // Bidirecional — ponto de conexao com a rede (importa e exporta)
  'Gateway': 'BIDIRECIONAL',

  // Inequivocos — consumo
  'Carregador Elétrico': 'CONSUMO',
  'Motor Elétrico': 'CONSUMO',
  'Inversor Frequência': 'CONSUMO',
  'Pivô': 'CONSUMO',
  'Power Meter': 'CONSUMO',

  // Ambiguos — admin decide caso a caso (sem fluxo_manual persistido -> excluido)
  'Medidor SSU': 'AMBIGUO',

  // Neutros — nao somam ao agregado
  'Banco Capacitor': 'NEUTRO',
  'Relê Proteção': 'NEUTRO',
  'RTU': 'NEUTRO',
  'SoftStarter': 'NEUTRO',
  'Transformador de Corrente (TC)': 'NEUTRO',
  'Transformador de Potencial (TP)': 'NEUTRO',
  'Transformador de Potência': 'NEUTRO',
  'Disjuntor BT': 'NEUTRO',
  'Disjuntor MT': 'NEUTRO',
  'Chave': 'NEUTRO',
  'TON': 'NEUTRO',
};

/**
 * Sinal do equipamento no agregado de energia, derivado da categoria.
 * Retorna 0 quando o equipamento NAO entra (NEUTRO, AMBIGUO sem decisao, ou
 * categoria desconhecida).
 */
export function sinalAgregado(categoriaNome: string | null | undefined): -1 | 0 | 1 {
  const fluxo = categoriaNome ? CATEGORIA_FLUXO[categoriaNome] : undefined;
  if (!fluxo || fluxo === 'NEUTRO' || fluxo === 'AMBIGUO') return 0;
  return fluxo === 'CONSUMO' ? -1 : 1;
}

/**
 * Pares (nome_categoria, sinal) apenas das categorias que SOMAM (sinal != 0).
 * Material pra montar a tabela VALUES do SQL do COA (categoria -> sinal).
 */
export const CATEGORIA_SINAL_PAIRS: ReadonlyArray<readonly [string, -1 | 1]> =
  Object.keys(CATEGORIA_FLUXO)
    .map((nome) => [nome, sinalAgregado(nome)] as const)
    .filter((par): par is readonly [string, -1 | 1] => par[1] !== 0);
