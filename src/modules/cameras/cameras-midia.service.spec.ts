import { ForbiddenException } from '@nestjs/common';
import { CamerasMidiaService } from './cameras-midia.service';

function montar(opts: { camera?: any; scopeOk?: boolean; usuario?: any; papelSpatie?: string | null } = {}) {
  const prisma: any = {
    cameras: { findFirst: jest.fn().mockResolvedValue(opts.camera ?? null) },
    cameras_agentes: { findFirst: jest.fn().mockResolvedValue(null) },
    // Usuário do token de mídia é recarregado do banco (ativo + papel atual).
    usuarios: { findFirst: jest.fn().mockResolvedValue('usuario' in opts ? opts.usuario : { id: 'u1', role: 'operador' }) },
    model_has_roles: {
      findFirst: jest.fn().mockResolvedValue(opts.papelSpatie ? { roles: { name: opts.papelSpatie } } : null),
    },
  };
  const scope: any = {
    assertEntityInScope: jest.fn().mockImplementation(async () => {
      if (opts.scopeOk === false) throw new ForbiddenException('Recurso fora do escopo do usuario');
    }),
  };
  return { service: new CamerasMidiaService(prisma, scope), prisma, scope };
}

const agora = new Date('2026-11-07T12:00:00Z');

beforeAll(() => {
  process.env.JWT_SECRET = 'segredo-de-teste';
  delete process.env.MIDIA_TOKEN_SECRET;
  process.env.MIDIA_AUTH_LOCAL_ONLY = 'true';
});

describe('CamerasMidiaService · token de mídia', () => {
  it('gera, verifica e vale 2 h', () => {
    const { service } = montar();
    const { token, valido_ate } = service.gerarTokenMidia({ id: 'u1 ', role: 'operador' }, agora);
    expect(valido_ate).toBe('2026-11-07T14:00:00.000Z');
    expect(service.verificarTokenMidia(token, agora)).toEqual({ u: 'u1', r: 'operador' });
    expect(service.verificarTokenMidia(token, new Date('2026-11-07T13:59:59Z'))).not.toBeNull();
  });

  it('recusa expirado, assinatura mexida e lixo', () => {
    const { service } = montar();
    const { token } = service.gerarTokenMidia({ id: 'u1', role: 'admin' }, agora);
    expect(service.verificarTokenMidia(token, new Date('2026-11-07T14:00:01Z'))).toBeNull();
    const [payload, sig] = token.split('.');
    expect(service.verificarTokenMidia(`${payload}.${sig.slice(0, -2)}xx`, agora)).toBeNull();
    const outroPayload = Buffer.from(JSON.stringify({ u: 'u2', r: 'admin', e: agora.getTime() + 99999 })).toString('base64url');
    expect(service.verificarTokenMidia(`${outroPayload}.${sig}`, agora)).toBeNull();
    expect(service.verificarTokenMidia('lixo', agora)).toBeNull();
    expect(service.verificarTokenMidia('', agora)).toBeNull();
  });

  it('token de publicação do agente: 30 min, prefixo pub_, não serve como token de mídia', () => {
    const { service } = montar();
    const pub = service.gerarTokenPublicar('ag1', agora);
    expect(pub.startsWith('pub_')).toBe(true);
    expect(service.verificarTokenPublicar(pub, agora)).toEqual({ a: 'ag1' });
    expect(service.verificarTokenPublicar(pub, new Date('2026-11-07T12:30:01Z'))).toBeNull();
    expect(service.verificarTokenPublicar(pub.slice(4), agora)).toBeNull();
    expect(service.verificarTokenMidia(pub.slice(4), agora)).toBeNull();
  });
});

describe('CamerasMidiaService · senha da câmera', () => {
  it('cifra e decifra ida e volta, com iv diferente a cada vez', () => {
    const { service } = montar();
    const a = service.cifrar('p@ss:w/rd');
    const b = service.cifrar('p@ss:w/rd');
    expect(a).not.toBe(b);
    expect(a.startsWith('v1.')).toBe(true);
    expect(service.decifrar(a)).toBe('p@ss:w/rd');
    expect(service.decifrar(b)).toBe('p@ss:w/rd');
  });

  it('valor estranho ou adulterado vira vazio', () => {
    const { service } = montar();
    expect(service.decifrar(null)).toBe('');
    expect(service.decifrar('senha-em-claro')).toBe('');
    const [v, iv, tag, ct] = service.cifrar('abc').split('.');
    expect(service.decifrar(`${v}.${iv}.${tag}.${ct === 'AAAA' ? 'BBBB' : 'AAAA'}`)).toBe('');
  });

  it('token do agente: nxcam_ aleatório e hash sha256 hex', () => {
    const { service } = montar();
    const { token, hash } = service.gerarTokenAgente();
    expect(token.startsWith('nxcam_')).toBe(true);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(service.hashToken(token)).toBe(hash);
    expect(service.gerarTokenAgente().token).not.toBe(token);
  });
});

describe('CamerasMidiaService · auth do MediaMTX', () => {
  const agenteRow = (hash: string) => ({ id: 'ag1', unidade_id: 'u1', planta_id: 'p1', nome: 'Agente', token_hash: hash });

  it('publish com token do agente dono da câmera', async () => {
    const { service, prisma } = montar({ camera: { agente_id: 'ag1' } });
    const { token, hash } = service.gerarTokenAgente();
    prisma.cameras_agentes.findFirst.mockImplementation(async ({ where }: any) => (where.token_hash === hash ? agenteRow(hash) : null));
    expect(await service.autenticarMediaMtx({ action: 'publish', user: 'agente', password: token, path: 'cam-c1', ip: '10.0.0.9' }, '127.0.0.1')).toBe(true);
    expect(await service.autenticarMediaMtx({ action: 'publish', user: 'agente', password: 'nxcam_errado_'.padEnd(40, 'x'), path: 'cam-c1' }, '127.0.0.1')).toBe(false);
    expect(await service.autenticarMediaMtx({ action: 'publish', user: 'outro', password: token, path: 'cam-c1' }, '127.0.0.1')).toBe(false);
    expect(await service.autenticarMediaMtx({ action: 'publish', user: 'agente', password: token, path: 'qualquer' }, '127.0.0.1')).toBe(false);
  });

  it('publish com publicar_token do agente dono; de outro agente não', async () => {
    const { service } = montar({ camera: { agente_id: 'ag1' } });
    const bom = service.gerarTokenPublicar('ag1');
    const deOutro = service.gerarTokenPublicar('ag2');
    expect(await service.autenticarMediaMtx({ action: 'publish', user: 'agente', password: bom, path: 'cam-c1' }, '::1')).toBe(true);
    expect(await service.autenticarMediaMtx({ action: 'publish', user: 'agente', password: deOutro, path: 'cam-c1' }, '::1')).toBe(false);
  });

  it('câmera sem agente não recebe publicação', async () => {
    const { service } = montar({ camera: { agente_id: null } });
    expect(await service.autenticarMediaMtx({ action: 'publish', user: 'agente', password: service.gerarTokenPublicar('ag1'), path: 'cam-c1' }, '127.0.0.1')).toBe(false);
  });

  it('read/playback com token de mídia na query e usuário que vê a unidade', async () => {
    const { service, scope } = montar({ camera: { unidade_id: 'u1 ' } });
    const { token } = service.gerarTokenMidia({ id: 'u1', role: 'operador' });
    expect(await service.autenticarMediaMtx({ action: 'read', protocol: 'hls', path: 'cam-c1', query: `token=${token}` }, '127.0.0.1')).toBe(true);
    expect(scope.assertEntityInScope).toHaveBeenCalledWith('unidade', 'u1', { id: 'u1', role: 'operador' });
    expect(await service.autenticarMediaMtx({ action: 'playback', path: 'cam-c1', query: `a=1&token=${token}` }, '::ffff:127.0.0.1')).toBe(true);
    expect(await service.autenticarMediaMtx({ action: 'read', path: 'cam-c1', query: '' }, '127.0.0.1')).toBe(false);
    expect(await service.autenticarMediaMtx({ action: 'read', path: 'cam-c1', query: 'token=lixo' }, '127.0.0.1')).toBe(false);
  });

  it('read de quem não vê a unidade, ação desconhecida e origem remota → recusa', async () => {
    const fora = montar({ camera: { unidade_id: 'u1' }, scopeOk: false });
    const { token } = fora.service.gerarTokenMidia({ id: 'u9', role: 'operador' });
    expect(await fora.service.autenticarMediaMtx({ action: 'read', path: 'cam-c1', query: `token=${token}` }, '127.0.0.1')).toBe(false);

    const { service } = montar({ camera: { unidade_id: 'u1', agente_id: 'ag1' } });
    expect(await service.autenticarMediaMtx({ action: 'api', path: 'cam-c1', query: `token=${token}` }, '127.0.0.1')).toBe(false);
    expect(await service.autenticarMediaMtx({ action: 'read', path: 'cam-c1', query: `token=${token}` }, '10.0.0.5')).toBe(false);

    process.env.MIDIA_AUTH_LOCAL_ONLY = 'false';
    const ok = montar({ camera: { unidade_id: 'u1' } });
    const t2 = ok.service.gerarTokenMidia({ id: 'u1', role: 'admin' }).token;
    expect(await ok.service.autenticarMediaMtx({ action: 'read', path: 'cam-c1', query: `token=${t2}` }, '10.0.0.5')).toBe(true);
    process.env.MIDIA_AUTH_LOCAL_ONLY = 'true';
  });

  it('monta a URL HLS com o token', () => {
    process.env.MIDIA_PUBLIC_URL = 'https://api.exemplo/midia/';
    const { service } = montar();
    expect(service.hlsUrl('cam-c1', 'a.b')).toBe('https://api.exemplo/midia/hls/cam-c1/index.m3u8?token=a.b');
    delete process.env.MIDIA_PUBLIC_URL;
  });

  it('token de mídia de usuário inativo ou apagado não vale, e o papel vem do banco', async () => {
    const inativo = montar({ camera: { unidade_id: 'u1 ' }, usuario: null });
    const { token } = inativo.service.gerarTokenMidia({ id: 'u1', role: 'admin' });
    expect(await inativo.service.usuarioDoTokenMidia(token)).toBeNull();
    expect(await inativo.service.autenticarMediaMtx({ action: 'read', path: 'cam-c1', query: `token=${token}` }, '127.0.0.1')).toBe(false);
    expect(inativo.scope.assertEntityInScope).not.toHaveBeenCalled();

    const rebaixado = montar({ camera: { unidade_id: 'u1 ' }, usuario: { id: 'u1                        ', role: 'vendedor' }, papelSpatie: 'operador' });
    const t2 = rebaixado.service.gerarTokenMidia({ id: 'u1', role: 'admin' }).token;
    expect(await rebaixado.service.usuarioDoTokenMidia(t2)).toEqual({ id: 'u1', role: 'operador' });
    expect(await rebaixado.service.autenticarMediaMtx({ action: 'read', path: 'cam-c1', query: `token=${t2}` }, '127.0.0.1')).toBe(true);
    expect(rebaixado.scope.assertEntityInScope).toHaveBeenCalledWith('unidade', 'u1', { id: 'u1', role: 'operador' });
  });
});
