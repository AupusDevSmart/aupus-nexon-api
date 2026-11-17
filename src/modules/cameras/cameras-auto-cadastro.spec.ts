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
