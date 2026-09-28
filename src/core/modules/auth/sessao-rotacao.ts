import { createHash, randomBytes } from 'crypto';

/**
 * Regras PURAS de rotação do refresh token (sem banco) — testadas em
 * sessao-rotacao.spec.ts.
 *
 * O refresh token carrega { sid, jti }. A sessão guarda sha256(jti) atual e o
 * anterior (com a hora da rotação). Cada refresh gera um jti novo.
 */

/** Janela em que o jti ANTERIOR ainda é aceito (refresh concorrente). */
export const GRACA_ROTACAO_MS = 60 * 1000;

/** Refresh token: 7 dias (igual ao legado). */
export const VALIDADE_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessaoParaRotacao {
  refresh_jti_hash: string;
  refresh_jti_anterior_hash: string | null;
  rotacionado_em: Date | null;
  expira_em: Date;
  revoked_at: Date | null;
}

export type ResultadoRefresh =
  /** jti atual — rotaciona normalmente. */
  | 'ok'
  /** jti anterior dentro da graça — emite tokens de novo, sem tratar como ataque. */
  | 'ok_graca'
  /** sessão encerrada (revogada ou vencida) → 401. */
  | 'revogada'
  /**
   * jti velho fora da graça (token já trocado) → 401. A sessão NÃO é revogada:
   * app que perdeu a corrida de dois refresh simultâneos só precisa logar de
   * novo, sem derrubar os outros aparelhos.
   */
  | 'reuso';

export function hashJti(jti: string): string {
  return createHash('sha256').update(jti).digest('hex');
}

export function novoJti(): string {
  return randomBytes(24).toString('base64url');
}

export function avaliarRefresh(
  sessao: SessaoParaRotacao | null,
  jti: string | undefined | null,
  agora: Date = new Date(),
): ResultadoRefresh {
  if (!sessao || sessao.revoked_at) return 'revogada';
  if (new Date(sessao.expira_em).getTime() <= agora.getTime()) return 'revogada';
  if (!jti) return 'reuso';
  const h = hashJti(jti);
  if (h === sessao.refresh_jti_hash) return 'ok';
  if (
    sessao.refresh_jti_anterior_hash &&
    h === sessao.refresh_jti_anterior_hash &&
    sessao.rotacionado_em &&
    agora.getTime() - new Date(sessao.rotacionado_em).getTime() <= GRACA_ROTACAO_MS
  ) {
    return 'ok_graca';
  }
  return 'reuso';
}
