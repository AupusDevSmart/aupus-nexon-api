import {
  bloqueioVigente,
  dentroDaJanela,
  ehComandoDePartida,
  janelaValida,
  JanelaComAtivo,
  MomentoLocal,
} from '../../shared/util/janela-horario';

/**
 * Regras de bloqueio do acionar (apps NexON v2) — lógica PURA, testada em
 * restricoes-comando.spec.ts. O service só carrega os dados e aplica.
 *
 * Ordem: permissão da instalação → janela do operador → horário de ponta.
 */
export type CodigoBloqueio = 'SEM_PERMISSAO_UNIDADE' | 'COMANDO_FORA_JANELA' | 'COMANDO_BLOQUEADO_PONTA';

export interface Bloqueio {
  code: CodigoBloqueio;
  message: string;
}

export interface ContextoComando {
  /**
   * Permissão por instalação do usuário. `null` = usuário sem nenhuma linha em
   * usuario_unidade_permissoes (modelo antigo: vale só a permission do papel).
   * Com linhas: `comandar` da unidade do equipamento (false se a unidade não está lá).
   */
  comandarNaUnidade: boolean | null;
  /** usuarios.cmd_janela (null = sem restrição). */
  janelaOperador: unknown;
  /** pivo_config.bloqueio_ponta do equipamento (null = sem config). */
  bloqueioPonta: Partial<JanelaComAtivo> | null;
  /** Nome do ponto acionado ("Ligar pivô", "Parar"...). */
  nomePonto: string;
  agora: MomentoLocal;
}

export function avaliarRestricoes(ctx: ContextoComando): Bloqueio | null {
  if (ctx.comandarNaUnidade === false) {
    return { code: 'SEM_PERMISSAO_UNIDADE', message: 'Sem permissão para comandar nesta instalação' };
  }
  if (janelaValida(ctx.janelaOperador) && !dentroDaJanela(ctx.janelaOperador, ctx.agora)) {
    const j = ctx.janelaOperador;
    return {
      code: 'COMANDO_FORA_JANELA',
      message: `Fora da janela de comando do operador (${j.inicio}–${j.fim})`,
    };
  }
  if (ehComandoDePartida(ctx.nomePonto) && bloqueioVigente(ctx.bloqueioPonta, ctx.agora)) {
    return {
      code: 'COMANDO_BLOQUEADO_PONTA',
      message: `Bloqueado no horário de ponta (${ctx.bloqueioPonta!.inicio}–${ctx.bloqueioPonta!.fim})`,
    };
  }
  return null;
}
