import { ForbiddenException } from '@nestjs/common';
import { CamerasAgenteService } from './cameras-agente.service';

/* eslint-disable @typescript-eslint/no-explicit-any */
function montar() {
  const agora = new Date();
  const prisma: any = {
    cameras_agentes: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'a1', unidade_id: 'u1 ', planta_id: 'p1', nome: 'Raspberry 1', versao: '0.4.4', host: 'pi', ultimo_contato_em: agora, ativo: true, token_gerado_em: null, created_at: agora, updated_at: agora, _count: { cameras: 3 } },
        { id: 'a2', unidade_id: 'u2', planta_id: 'p2', nome: 'Raspberry 2', versao: '0.4.0', host: null, ultimo_contato_em: null, ativo: true, token_gerado_em: null, created_at: agora, updated_at: agora, _count: { cameras: 0 } },
      ]),
    },
    unidades: {
      findMany: jest.fn().mockResolvedValue([{ id: 'u1', nome: 'UFV Aupus II', deleted_at: null, planta: { id: 'p1', nome: 'Planta A' } }]),
    },
  };
  const svc = new CamerasAgenteService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  return { svc, prisma };
}

describe('todos os aparelhos (administrador)', () => {
  it('lista aparelhos de todas as usinas com o nome da usina', async () => {
    const { svc, prisma } = montar();
    const r = await svc.listarTodos({ id: 'x', role: 'super_admin' } as any);
    expect(prisma.cameras_agentes.findMany.mock.calls[0][0].where).toEqual({ deleted_at: null });
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ id: 'a1', unidade_nome: 'UFV Aupus II', planta_nome: 'Planta A', cameras: 3, online: true });
    expect(r[1]).toMatchObject({ id: 'a2', unidade_nome: null, online: false });
  });

  it('recusa quem não é administrador', async () => {
    await expect(montar().svc.listarTodos({ id: 'x', role: 'analista' } as any)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
