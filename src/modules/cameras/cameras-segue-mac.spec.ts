import { CamerasAgenteService } from './cameras-agente.service';

/* eslint-disable @typescript-eslint/no-explicit-any */
function montar(cams: any[]) {
  const prisma: any = {
    cameras: {
      findMany: jest.fn().mockResolvedValue(cams),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const auditoria: any = {
    contextoUnidade: jest.fn().mockResolvedValue({ unidade: { id: 'u1', nome: 'UFV' }, planta: null }),
    registrar: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new CamerasAgenteService(prisma, {} as any, {} as any, {} as any, {} as any, auditoria, {} as any);
  return { svc: svc as any, prisma, auditoria };
}
const agente: any = { id: 'ag1', nome: 'Pi' };

describe('câmera segue o MAC', () => {
  it('guarda o MAC quando a descoberta está no mesmo IP', async () => {
    const m = montar([{ id: 'c1', nome: 'Portão', ip: '192.168.100.60', mac: null, unidade_id: 'u1' }]);
    await m.svc.seguirMac(agente, [{ ip: '192.168.100.60', mac: 'CC:81:30:2A:75:46' }]);
    expect(m.prisma.cameras.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { mac: 'cc:81:30:2a:75:46' } });
    expect(m.auditoria.registrar).not.toHaveBeenCalled();
  });

  it('rede nova: mesmo MAC em outro IP troca o IP e registra na auditoria', async () => {
    const m = montar([{ id: 'c1', nome: 'Portão', ip: '192.168.100.60', mac: 'cc:81:30:2a:75:46', unidade_id: 'u1' }]);
    await m.svc.seguirMac(agente, [
      { ip: '192.168.1.41', mac: '54:ba:d9:66:16:a4' },
      { ip: '192.168.1.118', mac: 'cc:81:30:2a:75:46' },
    ]);
    expect(m.prisma.cameras.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { ip: '192.168.1.118' } });
    const [acao, reg] = m.auditoria.registrar.mock.calls[0];
    expect(acao).toBe('camera_ip_atualizado');
    expect(reg.extra).toMatchObject({ ip_anterior: '192.168.100.60', ip_novo: '192.168.1.118' });
  });

  it('canais do mesmo gravador (NVR) mudam de IP juntos', async () => {
    const m = montar([
      { id: 'c1', nome: 'NVR canal 1', ip: '192.168.1.30', mac: 'dd:dd:dd:dd:dd:dd', unidade_id: 'u1' },
      { id: 'c2', nome: 'NVR canal 2', ip: '192.168.1.30', mac: 'dd:dd:dd:dd:dd:dd', unidade_id: 'u1' },
    ]);
    await m.svc.seguirMac(agente, [{ ip: '10.0.0.5', mac: 'dd:dd:dd:dd:dd:dd' }]);
    expect(m.prisma.cameras.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { ip: '10.0.0.5' } });
    expect(m.prisma.cameras.update).toHaveBeenCalledWith({ where: { id: 'c2' }, data: { ip: '10.0.0.5' } });
    expect(m.auditoria.registrar.mock.calls[1][1].extra).toMatchObject({ ip_anterior: '192.168.1.30', ip_novo: '10.0.0.5' });
  });

  it('não troca para IP que outra câmera do agente já usa', async () => {
    const m = montar([
      { id: 'c1', nome: 'A', ip: '192.168.1.10', mac: 'aa:aa:aa:aa:aa:aa', unidade_id: 'u1' },
      { id: 'c2', nome: 'B', ip: '192.168.1.20', mac: 'bb:bb:bb:bb:bb:bb', unidade_id: 'u1' },
    ]);
    await m.svc.seguirMac(agente, [{ ip: '192.168.1.20', mac: 'aa:aa:aa:aa:aa:aa' }]);
    expect(m.prisma.cameras.update).not.toHaveBeenCalled();
  });
});
