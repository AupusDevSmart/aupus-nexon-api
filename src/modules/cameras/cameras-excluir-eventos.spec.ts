import { ForbiddenException } from '@nestjs/common';
import { CamerasEventosService } from './cameras-eventos.service';

/* eslint-disable @typescript-eslint/no-explicit-any */
const camera = { id: 'c1', nome: 'Portão', ip: '192.168.1.60', unidade_id: 'u1' };
const evento = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  camera_id: 'c1',
  unidade_id: 'u1',
  tipo: 'pessoa',
  inicio_em: new Date('2026-11-16T12:00:00Z'),
  alerta: true,
  snapshot_path: `eventos/${id}.jpg`,
  clipe_path: `eventos/${id}.mp4`,
  camera,
  ...extra,
});

function montar(linhas = [evento('e1'), evento('e2', { clipe_path: null })]) {
  const prisma: any = {
    cameras_eventos: {
      findMany: jest.fn().mockResolvedValue(linhas),
      deleteMany: jest.fn().mockResolvedValue({ count: linhas.length }),
    },
  };
  const scope: any = { assertEntityInScope: jest.fn().mockResolvedValue(undefined) };
  const storage: any = { remover: jest.fn().mockResolvedValue(undefined) };
  const auditoria: any = {
    contextoUnidade: jest.fn().mockResolvedValue({ unidade: { id: 'u1', nome: 'UFV' }, planta: { id: 'p1', nome: 'Planta' } }),
    registrar: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new CamerasEventosService(prisma, scope, storage, {} as any, auditoria, {} as any);
  return { svc, prisma, storage, auditoria, scope };
}

const admin: any = { id: 'a1', nome: 'Admin', role: 'super_admin' };

describe('CamerasEventosService.excluir', () => {
  it('admin apaga eventos, foto e clipe, com um audit log por câmera', async () => {
    const m = montar();
    const r = await m.svc.excluir({ ids: ['e1', ' e2 ', 'e1'] }, admin);
    expect(r).toEqual({ excluidos: 2 });
    expect(m.prisma.cameras_eventos.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['e1', 'e2'] } } });
    expect(m.storage.remover.mock.calls.map((c: any[]) => c[0])).toEqual(['eventos/e1.jpg', 'eventos/e1.mp4', 'eventos/e2.jpg', null]);
    expect(m.scope.assertEntityInScope).toHaveBeenCalledWith('unidade', 'u1', admin);
    expect(m.auditoria.registrar).toHaveBeenCalledTimes(1);
    const [acao, reg] = m.auditoria.registrar.mock.calls[0];
    expect(acao).toBe('camera_evento_exclusao');
    expect(reg.mensagem).toContain('2 evento(s) apagado(s) da câmera "Portão" (192.168.1.60) — UFV (Planta)');
    expect(reg.extra.eventos.map((e: any) => e.id)).toEqual(['e1', 'e2']);
  });

  it('quem não é admin recebe 403 e nada é apagado', async () => {
    for (const role of ['proprietario', 'operador', 'analista', 'gerente']) {
      const m = montar();
      await expect(m.svc.excluir({ ids: ['e1'] }, { id: 'x', role } as any)).rejects.toBeInstanceOf(ForbiddenException);
      expect(m.prisma.cameras_eventos.deleteMany).not.toHaveBeenCalled();
    }
  });

  it('id que não existe: nada a apagar, sem audit log', async () => {
    const m = montar([]);
    expect(await m.svc.excluir({ ids: ['zz'] }, admin)).toEqual({ excluidos: 0 });
    expect(m.auditoria.registrar).not.toHaveBeenCalled();
  });
});
