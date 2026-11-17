import { CamerasAgenteService } from './cameras-agente.service';
import { gerarSenhaCamera } from './cameras-regras';

/* eslint-disable @typescript-eslint/no-explicit-any */
function montar(opts: { auto?: boolean; existentes?: any[]; total?: number } = {}) {
  const criadas: any[] = [];
  const prisma: any = {
    cameras: {
      findMany: jest.fn().mockResolvedValue(opts.existentes ?? []),
      count: jest.fn().mockResolvedValue(opts.total ?? 1),
      create: jest.fn().mockImplementation(async ({ data }) => (criadas.push(data), data)),
    },
  };
  const midia: any = { cifrar: jest.fn((s: string) => `cif:${s}`) };
  const config: any = { obter: jest.fn().mockResolvedValue({ auto_cadastrar: opts.auto ?? true }) };
  const auditoria: any = {
    contextoUnidade: jest.fn().mockResolvedValue({ unidade: { id: 'u1', nome: 'UFV' }, planta: { id: 'p1', nome: 'P' } }),
    registrar: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new CamerasAgenteService(prisma, {} as any, midia, {} as any, {} as any, auditoria, config) as any;
  return { svc, prisma, auditoria, criadas };
}
const agente: any = { id: 'ag1', nome: 'Pi', unidade_id: 'u1', planta_id: 'p1' };
const nova = { ip: '192.168.1.13', mac: 'CC:81:30:2A:23:32', fabricante: 'intelbras', modelo: 'VIPC-1230-B-G2', serial: 'X', porta_http: 80, inicializada: false };

describe('cadastro automático de câmera de fábrica', () => {
  it('cadastra com admin, senha forte cifrada e audit automático', async () => {
    const m = montar({ total: 1 });
    await m.svc.autoCadastrar(agente, [nova, { ...nova, ip: '192.168.1.41', mac: '54:ba', inicializada: true }]);
    expect(m.criadas).toHaveLength(1);
    expect(m.criadas[0]).toMatchObject({ nome: 'Câmera 2', ip: '192.168.1.13', mac: 'cc:81:30:2a:23:32', usuario: 'admin', agente_id: 'ag1' });
    expect(m.criadas[0].senha).toMatch(/^cif:[A-Za-z0-9]{16}$/);
    const [acao, reg] = m.auditoria.registrar.mock.calls[0];
    expect(acao).toBe('camera_cadastro');
    expect(reg.extra).toMatchObject({ automatico: true, mac: 'cc:81:30:2a:23:32' });
  });

  it('não cadastra com a opção desligada nem se já existe (IP ou MAC)', async () => {
    const a = montar({ auto: false });
    await a.svc.autoCadastrar(agente, [nova]);
    expect(a.criadas).toHaveLength(0);
    const b = montar({ existentes: [{ ip: '10.0.0.9', mac: 'cc:81:30:2a:23:32' }] });
    await b.svc.autoCadastrar(agente, [nova]);
    expect(b.criadas).toHaveLength(0);
  });

  it('senha gerada passa na regra da Intelbras', () => {
    for (let i = 0; i < 50; i++) {
      const s = gerarSenhaCamera();
      expect(s).toHaveLength(16);
      expect(/[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s)).toBe(true);
    }
  });
});

describe('limites do cadastro automático', () => {
  it('sem fabricante não cadastra; no máximo 4 por vez; para em 64 na usina', async () => {
    const a = montar();
    await a.svc.autoCadastrar(agente, [{ ...nova, fabricante: null }]);
    expect(a.criadas).toHaveLength(0);
    const b = montar({ total: 0 });
    await b.svc.autoCadastrar(agente, Array.from({ length: 10 }, (_, i) => ({ ...nova, ip: `192.168.1.${100 + i}`, mac: `aa:${i}` })));
    expect(b.criadas).toHaveLength(4);
    const c = montar({ total: 64 });
    await c.svc.autoCadastrar(agente, [nova]);
    expect(c.criadas).toHaveLength(0);
  });
});

describe('câmera com a mesma senha de outra da usina', () => {
  it('copia usuário e senha cifrada da câmera de referência e audita a origem', async () => {
    const m = montar({ total: 1 });
    m.prisma.cameras.findFirst = jest
      .fn()
      .mockResolvedValueOnce({ id: 'c1', nome: 'Portão', usuario: 'admin', senha: 'cif:X', agente_id: 'ag1' }) // cameraDoAgente
      .mockResolvedValueOnce(null); // não existe ainda
    m.prisma.cameras_descobertas = {
      findFirst: jest.fn().mockResolvedValue({ ip: '192.168.1.13', mac: 'CC:81:30:2A:23:32', fabricante: 'intelbras', modelo: 'VIPC', serial: 'S', porta_http: 80, porta_rtsp: null }),
    };
    const r = await m.svc.senhaConhecida(agente, '192.168.1.13', 'c1');
    expect(r.cadastrada).toBe(true);
    expect(m.criadas[0]).toMatchObject({ ip: '192.168.1.13', usuario: 'admin', senha: 'cif:X', nome: 'Câmera 2', mac: 'cc:81:30:2a:23:32' });
    expect(m.auditoria.registrar.mock.calls[0][1].extra).toMatchObject({ origem: 'senha_conhecida', senha_de: { id: 'c1' } });
  });
});
