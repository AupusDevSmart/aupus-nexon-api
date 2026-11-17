import { CamerasPareamentoService } from './cameras-pareamento.service';

/* eslint-disable @typescript-eslint/no-explicit-any */
function montar(opts: { chave?: any; reservado?: number; falhaUnica?: boolean; autor?: any; foraDoEscopo?: boolean } = {}) {
  const prisma: any = {
    cameras_pareamentos: {
      updateMany: jest.fn().mockImplementation(async () => {
        if (opts.falhaUnica) throw new Error('unique');
        return { count: opts.reservado ?? 1 };
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    usuarios: { findFirst: jest.fn().mockResolvedValue(opts.autor === undefined ? { id: 'a1', role: 'super_admin', nome: 'Admin' } : opts.autor) },
  };
  const scope: any = { assertEntityInScope: jest.fn().mockImplementation(async () => { if (opts.foraDoEscopo) throw new Error('fora'); }) };
  const midia: any = { lerVinculo: jest.fn().mockReturnValue(opts.chave === undefined ? { un: 'u1', by: 'a1', n: 'f'.repeat(24) } : opts.chave), cifrar: (s: string) => `c:${s}` };
  const agentes: any = { exigirCadastroTecnico: jest.fn(), inserirAgente: jest.fn().mockResolvedValue({ agente: { id: 'ag9', nome: 'nexon-cam' }, token: 'nxcam_x' }) };
  const auditoria: any = {
    contextoUnidade: jest.fn().mockResolvedValue({ unidade: { id: 'u1', nome: 'UFV' }, planta: { id: 'p1', nome: 'P' } }),
    registrar: jest.fn(),
  };
  const svc = new CamerasPareamentoService(prisma, scope, midia, agentes, auditoria) as any;
  return { svc, prisma, agentes, auditoria };
}
const p = { id: 'pe1', codigo: '123456', host: 'nexon-cam', mac: 'aa', versao: '0.4.3', ip_publico: '1.2.3.4', ip_local: '192.168.1.5' };

describe('vínculo automático pelo instalador', () => {
  it('chave válida: reserva com o nonce, cria o agente na usina e audita via instalador', async () => {
    const m = montar();
    await m.svc.vincularPeloInstalador(p, 'vin.x', undefined, new Date());
    expect(m.prisma.cameras_pareamentos.updateMany.mock.calls[0][0].data.vinculo_nonce).toBe('f'.repeat(24));
    expect(m.agentes.inserirAgente).toHaveBeenCalledWith('u1', 'p1', 'nexon-cam', expect.anything());
    expect(m.prisma.cameras_pareamentos.update.mock.calls[0][0].data).toMatchObject({ agente_id: 'ag9', token_cifrado: 'c:nxcam_x' });
    const [acao, reg] = m.auditoria.registrar.mock.calls[0];
    expect(acao).toBe('camera_agente_pareado');
    expect(reg.extra.via).toBe('instalador');
  });

  it('chave inválida ou já usada: não cria agente e registra a recusa', async () => {
    for (const m of [montar({ chave: null }), montar({ falhaUnica: true }), montar({ autor: null }), montar({ foraDoEscopo: true })]) {
      await m.svc.vincularPeloInstalador(p, 'vin.x', undefined, new Date());
      expect(m.agentes.inserirAgente).not.toHaveBeenCalled();
      expect(m.auditoria.registrar.mock.calls[0][0]).toBe('camera_pareamento_falha');
    }
  });
});
