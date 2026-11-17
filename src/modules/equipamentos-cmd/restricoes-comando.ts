import {
  bloqueioVigente,
  dentroDaJanela,
  ehComandoDePartida,
  janelaValida,
  JanelaComAtivo,
  MomentoLocal,
} from '../../shared/util/janela-horario';
import { isGlobal, Papel } from '../../core/modules/auth/papeis';

/**
 * Regras de bloqueio do acionar (apps NexON v2) — lógica PURA, testada em
 * restricoes-comando.spec.ts. O service só carrega os dados e aplica.
 *
 * Ordem: permissão da instalação → janela do operador → horário de ponta.
 */
export type CodigoBloqueio = 'SEM_PERMISSAO_UNIDADE' | 'COMANDO_FORA_JANELA' | 'COMANDO_BLOQUEADO_PONTA' | 'COMANDO_BLOQUEADO_REMOTO';

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
  /**
   * Chave Local/Remoto do pivô (ponto de status "Remoto", BI07): 1 = REMOTO, 0 = LOCAL,
   * null = sem leitura, undefined = equipamento sem o ponto ligado a uma BI (sem trava).
   */
  remoto?: 0 | 1 | null;
}

/** Comando que PÕE o pivô para funcionar (bomba, giro, ligar) — o que o REMOTO bloqueia. */
export function ehPartidaPivo(nomePonto: unknown): boolean {
  const n = String(nomePonto ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/deslig|parar|stop/.test(n)) return false;
  return /bomb|girar|ligar/.test(n) || ehComandoDePartida(nomePonto);
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
  if (ctx.remoto !== undefined && ehPartidaPivo(ctx.nomePonto)) {
    if (ctx.remoto === 1) return { code: 'COMANDO_BLOQUEADO_REMOTO', message: 'Pivô travado no LOCAL (chave Local/Remoto do painel): o NexON não liga. Ligue pelo painel ou mude a chave.' };
    if (ctx.remoto === null) return { code: 'COMANDO_BLOQUEADO_REMOTO', message: 'Sem leitura da chave Local/Remoto do pivô: não dá para confirmar que está em LOCAL.' };
  }
  if (ehComandoDePartida(ctx.nomePonto) && bloqueioVigente(ctx.bloqueioPonta, ctx.agora)) {
    return {
      code: 'COMANDO_BLOQUEADO_PONTA',
      message: `Bloqueado no horário de ponta (${ctx.bloqueioPonta!.inicio}–${ctx.bloqueioPonta!.fim})`,
    };
  }
  return null;
}

/**
 * Permissão por instalação (usuario_unidade_permissoes, legado v2) só restringe
 * quem não é Admin/analista/proprietário: esses comandam tudo do próprio escopo
 * (NEXON-20, 6.2). O operador continua sujeito a ela, além do equipamento liberado.
 */
export function sujeitoPermissaoPorUnidade(papel: Papel): boolean {
  return !isGlobal(papel) && papel !== 'proprietario';
}

/** Medidor (código do tipo MEDIDOR*, inclusive o da concessionária): sem comando (6.2). */
export function ehMedidor(codigoTipo: string | null | undefined): boolean {
  return /^MEDIDOR/i.test(String(codigoTipo ?? '').trim());
}
