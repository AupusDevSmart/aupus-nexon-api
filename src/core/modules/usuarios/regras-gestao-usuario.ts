import { Papel, podeCadastrar, ROTULO_PAPEL } from '../auth/papeis';

/**
 * Quem pode ver, editar, desativar e excluir quem (spec NEXON-20, seção 3 e
 * PER-11). Lógica PURA, testada em regras-gestao-usuario.spec.ts.
 *
 * - Quem cadastra um papel também edita e desativa usuários desse papel.
 * - Proprietário só mexe em operador ligado a ele (vínculo ou criado por ele).
 * - Ninguém troca o próprio papel nem se desativa/exclui (só Admin troca o próprio).
 * - super_admin só é alterado (e atribuído) por super_admin; senha e exclusão de
 *   outro admin também só por super_admin (senão um admin entra na conta do outro).
 * - Operador que atende OUTRO proprietário: o proprietário não mexe no cadastro
 *   dele (nome, e-mail, senha, ativação) — só no próprio vínculo. Senão um
 *   proprietário redefine a senha e entra com os equipamentos dos outros.
 */
export type AcaoGestao = 'ver' | 'editar' | 'senha' | 'desativar' | 'excluir';

export interface CasoGestao {
  autor: Papel;
  /** Role crua do autor (para a regra do super_admin). */
  autorRole?: string | null;
  acao: AcaoGestao;
  /** O alvo é o próprio autor. */
  proprio: boolean;
  alvo: Papel;
  alvoRole?: string | null;
  /** Operador com vínculo ativo com o autor, ou criado por ele. */
  alvoLigadoAoAutor: boolean;
  /** Papel novo pedido (troca de papel); undefined = não troca. */
  novoPapel?: Papel;
  /** Nome cru do papel pedido (para barrar super_admin). */
  novoRoleName?: string | null;
  /** Operador com vínculo ativo com outro proprietário além do autor. */
  alvoTemOutroDono?: boolean;
}

/** null = pode; texto = motivo da recusa (vai no 403). */
export function avaliarGestao(c: CasoGestao): string | null {
  const trocaPapel = c.novoPapel !== undefined && c.novoPapel !== c.alvo;
  const autorSuper = String(c.autorRole ?? '').toLowerCase() === 'super_admin';

  if (String(c.novoRoleName ?? '').toLowerCase() === 'super_admin' && !autorSuper) {
    return 'Apenas super_admin atribui o papel super_admin';
  }

  if (c.proprio) {
    if (c.acao === 'desativar' || c.acao === 'excluir') return 'Você não pode desativar nem excluir o próprio usuário';
    if (trocaPapel && c.autor !== 'admin') return 'Você não pode trocar o próprio papel';
    if (trocaPapel && !podeCadastrar(c.autor, c.novoPapel!)) return mensagemPapel(c.novoPapel!);
    return null;
  }

  const alvoRole = String(c.alvoRole ?? '').toLowerCase();
  if (alvoRole === 'super_admin' && c.acao !== 'ver' && !autorSuper) {
    return 'Apenas super_admin altera outro super_admin';
  }
  if (alvoRole === 'admin' && (c.acao === 'senha' || c.acao === 'excluir') && !autorSuper) {
    return 'Apenas super_admin redefine a senha ou exclui outro admin';
  }

  if (c.acao === 'ver') {
    if (c.autor === 'admin' || c.autor === 'analista_automacao' || c.autor === 'analista_operacao') return null;
    if (c.autor === 'proprietario' && c.alvo === 'operador' && c.alvoLigadoAoAutor) return null;
    return 'Usuário fora do escopo';
  }

  if (!podeCadastrar(c.autor, c.alvo)) return mensagemPapel(c.alvo);
  if (c.autor === 'proprietario' && !c.alvoLigadoAoAutor) return 'Usuário fora do escopo';
  if (c.autor === 'proprietario' && c.alvoTemOutroDono) {
    return 'Este operador também atende outro proprietário: só a equipe Aupus altera o cadastro dele. Você ajusta só o acesso dele aos seus equipamentos';
  }
  if (trocaPapel && !podeCadastrar(c.autor, c.novoPapel!)) return mensagemPapel(c.novoPapel!);
  return null;
}

export function mensagemPapel(p: Papel): string {
  return `Seu perfil não pode cadastrar nem alterar usuários do papel ${ROTULO_PAPEL[p]}`;
}

/**
 * Permissões diretas (model_has_permissions): ninguém concede o que não tem
 * (PER-3). Admin concede qualquer uma. Devolve as que faltam ao autor.
 */
export function permissoesAlemDoAutor(autor: Papel, doAutor: string[] | undefined, pedidas: string[]): string[] {
  if (autor === 'admin') return [];
  const tem = new Set(doAutor ?? []);
  return pedidas.filter((p) => !tem.has(p));
}
