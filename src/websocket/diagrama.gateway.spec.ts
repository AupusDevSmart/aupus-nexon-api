import { DiagramaGateway, tokenDoHandshake } from './diagrama.gateway';

const sock = (handshake: any, extra: any = {}) =>
  ({ handshake, data: {}, rooms: new Set<string>(), emit: jest.fn(), disconnect: jest.fn(), join: jest.fn(), leave: jest.fn(), ...extra }) as any;

describe('DiagramaGateway (NEXON-20)', () => {
  it('lê o token de auth.token, ?token= ou Authorization', () => {
    expect(tokenDoHandshake(sock({ auth: { token: 'a' } }))).toBe('a');
    expect(tokenDoHandshake(sock({ auth: {}, query: { token: 'b' } }))).toBe('b');
    expect(tokenDoHandshake(sock({ auth: {}, query: {}, headers: { authorization: 'Bearer c' } }))).toBe('c');
    expect(tokenDoHandshake(sock({ auth: {}, query: {}, headers: {} }))).toBeNull();
  });

  const montar = (verify: jest.Mock, status = 'Ativo', assert = jest.fn()) => {
    const prisma: any = { usuarios: { findFirst: jest.fn().mockResolvedValue({ status }) } };
    const scope: any = { assertEntityInScope: assert, acessoPorEquipamento: jest.fn().mockResolvedValue(null) };
    const config: any = { get: () => 'segredo' };
    return new DiagramaGateway({ on: jest.fn() } as any, { verifyAsync: verify } as any, config, prisma, scope);
  };

  it('sem token ou com token inválido: derruba a conexão', async () => {
    const g = montar(jest.fn().mockRejectedValue(new Error('jwt expired')));
    const s1 = sock({ auth: {} });
    await g.handleConnection(s1);
    expect(s1.disconnect).toHaveBeenCalledWith(true);
    const s2 = sock({ auth: { token: 'x' } });
    await g.handleConnection(s2);
    expect(s2.disconnect).toHaveBeenCalledWith(true);
  });

  it('usuário inativo: derruba', async () => {
    const g = montar(jest.fn().mockResolvedValue({ sub: 'u1', role: 'admin' }), 'Inativo');
    const s = sock({ auth: { token: 'x' } });
    await g.handleConnection(s);
    expect(s.disconnect).toHaveBeenCalled();
  });

  it('equipamento fora do escopo: não entra na sala', async () => {
    const assert = jest.fn().mockRejectedValue(new Error('fora'));
    const g = montar(jest.fn().mockResolvedValue({ sub: 'u1', role: 'proprietario' }), 'Ativo', assert);
    const s = sock({ auth: { token: 'x' } });
    await g.handleConnection(s);
    expect(s.disconnect).not.toHaveBeenCalled();
    const r = await g.handleSubscribeEquipamento({ equipamentoId: 'eq1' }, s);
    expect(r.event).toBe('subscribe_negado');
    expect(s.join).not.toHaveBeenCalled();
  });

  it('equipamento no escopo: entra na sala', async () => {
    const g = montar(jest.fn().mockResolvedValue({ sub: 'u1', role: 'proprietario' }), 'Ativo', jest.fn().mockResolvedValue(undefined));
    const s = sock({ auth: { token: 'x' } });
    await g.handleConnection(s);
    const r = await g.handleSubscribeEquipamento({ equipamentoId: ' eq1 ' }, s);
    expect(r.event).toBe('subscribed');
    expect(s.join).toHaveBeenCalledWith('equipamento:eq1');
  });
});
