import { DEPENDENCIAS, Recurso, ehRecurso } from './recursos';

export interface Elo {
  recurso: Recurso;
  registro_id: string;
  /** Como chamar isto na tela: "o proprietário", "a planta". */
  comoChamar: string;
  /** Nome legivel do registro, para a confirmacao nao mostrar um id cru. */
  nome: string;
  /** True quando ja esta compartilhado — entra na lista so como contexto. */
  ja_compartilhado: boolean;
}

export interface Cadeia {
  /** O que o usuario pediu para compartilhar. */
  alvo: Elo;
  /**
   * O que precisa ir JUNTO, em ordem de dependencia — o mais basico primeiro.
   *
   * A ordem importa na hora de vincular: mandar a planta antes do dono dela
   * faz o receptor recusar por dependencia ausente, o evento entra em retry e
   * so passa quando o dono chegar. Funciona, mas gasta um ciclo de backoff a
   * toa e polui a auditoria com uma recusa que era evitavel.
   */
  faltando: Elo[];
}

type Tx = any;

/**
 * Descobre tudo que precisa atravessar a fronteira junto com um registro.
 *
 * Sobe a hierarquia — equipamento -> instalacao -> planta -> proprietario — e
 * para em cada nivel que JA esta compartilhado, porque dali para cima o outro
 * lado ja tem o que precisa.
 *
 * Existe para a tela poder pedir consentimento sobre o conjunto INTEIRO antes
 * de qualquer coisa sair. A alternativa que descartamos era cascatear sozinho:
 * um clique em "compartilhar equipamento" copiaria instalacao, planta e um
 * USUARIO para o outro produto sem ninguem ver. Recusar tambem nao serve com
 * 443 equipamentos — viraria um quebra-cabeca de ordem manual.
 *
 * Nao decide nada: so descreve. Quem vincula e o `OutboxService`, depois do
 * usuario confirmar.
 */
export async function resolverCadeia(
  tx: Tx,
  recurso: Recurso,
  registroId: string,
): Promise<Cadeia> {
  const id = registroId?.trim();

  const alvo = await descrever(tx, recurso, id, 'este registro');
  if (!alvo) throw new Error(`${recurso} ${id} nao existe`);

  const faltando: Elo[] = [];
  // Guarda o que ja foi visitado: uma planta pode ser alcancada por dois
  // caminhos (a instalacao E o equipamento pai), e listar duas vezes o mesmo
  // usuario na confirmacao daria a impressao de que sao duas coisas.
  const vistos = new Set<string>([`${recurso}:${id}`]);

  await subir(tx, recurso, id, faltando, vistos);

  // Mais basico primeiro: o proprietario antes da planta, a planta antes da
  // instalacao. `subir` produz de dentro para fora, entao inverter da a ordem
  // segura de vinculacao.
  faltando.reverse();

  return { alvo, faltando };
}

async function subir(
  tx: Tx,
  recurso: Recurso,
  registroId: string,
  acc: Elo[],
  vistos: Set<string>,
): Promise<void> {
  const linha = await tx[recurso].findUnique({ where: { id: registroId } });
  if (!linha) return;

  for (const dep of DEPENDENCIAS[recurso]) {
    const alvoId = linha[dep.campo]?.trim?.();
    if (!alvoId) continue;

    // Dependencia para tabela que nao e recurso sincronizavel (tipos de
    // equipamento, por exemplo) nao entra na cadeia: nao ha o que compartilhar,
    // e o catalogo ja e igual nos dois lados. Se um dia divergir, o receptor
    // recusa com mensagem propria.
    if (!ehRecurso(dep.tabela)) continue;

    const chave = `${dep.tabela}:${alvoId}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);

    const elo = await descrever(tx, dep.tabela, alvoId, dep.comoChamar);
    if (!elo) continue;

    // Ja compartilhado: o outro lado tem este registro, entao a cadeia acima
    // dele tambem foi resolvida quando ELE foi compartilhado. Parar aqui evita
    // percorrer a hierarquia inteira toda vez.
    if (elo.ja_compartilhado) continue;

    acc.push(elo);
    await subir(tx, dep.tabela, alvoId, acc, vistos);
  }
}

/** Nome legivel varia por tabela; `usuarios` usa `nome`, mas nem todo model usaria. */
async function descrever(
  tx: Tx,
  recurso: Recurso,
  registroId: string,
  comoChamar: string,
): Promise<Elo | null> {
  const linha = await tx[recurso].findUnique({
    where: { id: registroId },
    select: { id: true, nome: true },
  });
  if (!linha) return null;

  const vinculo = await tx.sincronizacao_vinculos.findUnique({
    where: { recurso_registro_id: { recurso, registro_id: registroId } },
    select: { ativo: true },
  });

  return {
    recurso,
    registro_id: registroId,
    comoChamar,
    nome: linha.nome ?? registroId,
    ja_compartilhado: vinculo?.ativo === true,
  };
}
