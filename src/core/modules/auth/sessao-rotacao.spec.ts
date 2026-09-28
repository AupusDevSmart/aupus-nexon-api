import { avaliarRefresh, GRACA_ROTACAO_MS, hashJti, novoJti, SessaoParaRotacao } from './sessao-rotacao';

describe('sessao-rotacao', () => {
  const agora = new Date('2026-09-28T12:00:00Z');
  const atual = 'jti-atual';
  const anterior = 'jti-anterior';
  const sessao = (o: Partial<SessaoParaRotacao> = {}): SessaoParaRotacao => ({
    refresh_jti_hash: hashJti(atual),
    refresh_jti_anterior_hash: hashJti(anterior),
    rotacionado_em: new Date(agora.getTime() - 10_000),
    expira_em: new Date(agora.getTime() + 60 * 60 * 1000),
    revoked_at: null,
    ...o,
  });

  it('jti atual → ok', () => {
    expect(avaliarRefresh(sessao(), atual, agora)).toBe('ok');
  });

  it('jti anterior dentro da graça (refresh concorrente) → ok_graca', () => {
    expect(avaliarRefresh(sessao(), anterior, agora)).toBe('ok_graca');
  });

  it('jti anterior fora da graça → reuso', () => {
    const s = sessao({ rotacionado_em: new Date(agora.getTime() - GRACA_ROTACAO_MS - 1) });
    expect(avaliarRefresh(s, anterior, agora)).toBe('reuso');
  });

  it('jti desconhecido ou ausente → reuso', () => {
    expect(avaliarRefresh(sessao(), 'outro', agora)).toBe('reuso');
    expect(avaliarRefresh(sessao(), null, agora)).toBe('reuso');
  });

  it('sessão revogada, vencida ou inexistente → revogada', () => {
    expect(avaliarRefresh(sessao({ revoked_at: agora }), atual, agora)).toBe('revogada');
    expect(avaliarRefresh(sessao({ expira_em: agora }), atual, agora)).toBe('revogada');
    expect(avaliarRefresh(null, atual, agora)).toBe('revogada');
  });

  it('hash é estável e o jti novo é aleatório', () => {
    expect(hashJti('a')).toBe(hashJti('a'));
    expect(hashJti('a')).toHaveLength(64);
    expect(novoJti()).not.toBe(novoJti());
  });
});
