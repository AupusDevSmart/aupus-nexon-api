import { Recurso } from './recursos';

type Tx = any;

/**
 * O que este backend faz com um registro que acabou de chegar do outro produto.
 *
 * Existe nos dois backends com conteudo DIFERENTE, e e o unico arquivo assim no
 * modulo. E de proposito: cada lado conhece so a propria forma. Um tradutor
 * unico que soubesse dos dois schemas voltaria a acoplar os dois produtos, que
 * e exatamente o que a separacao desfez.
 *
 * Aqui, no NexOn, nao ha nada a fazer — e a assimetria vale ser explicada.
 *
 * O NexOn nao tem a separacao posicao/equipamento: para ele o equipamento e uma
 * coisa so, com categoria derivada do tipo e localizacao na propria linha. O
 * equipamento que vem do Service ja chega assim, porque a linha de la continua
 * carregando `localizacao` e `tipo_equipamento_id` — a posicao virou dona da
 * categoria, mas nao esvaziou o equipamento. As duas colunas que so existem la
 * (`ativo_funcional_id`, `ativo_na_posicao`) nem sao enviadas, e o filtro de
 * entrada descartaria de qualquer jeito.
 *
 * A unica perda conhecida: equipamento do Service SEM `tipo_equipamento_id`
 * chega aqui sem categoria, porque aqui a categoria vem do tipo. Sao 51 dos 254
 * hoje. Nao ha o que inventar — categoria chutada seria pior do que ausente.
 */
export async function aoReceber(
  _tx: Tx,
  _recurso: Recurso,
  _registroId: string,
  _dados: Record<string, any>,
): Promise<void> {
  return;
}
