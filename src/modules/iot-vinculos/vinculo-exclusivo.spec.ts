import { VinculosMirrorService } from './vinculos-mirror.service';

describe('vínculo exclusivo: um ponto, uma BO/BI', () => {
  const montar = (devolve: Array<{ ton_id: string }>) => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue(devolve) } as any;
    const svc = new VinculosMirrorService(prisma);
    const resync = jest.spyOn(svc, 'resyncTonCanais').mockResolvedValue(undefined);
    return { prisma, svc, resync };
  };

  it('solta o ponto das outras TONs e refaz o espelho delas', async () => {
    const { prisma, svc, resync } = montar([{ ton_id: 'TONV2 ' }, { ton_id: 'TONV2' }]);
    expect(await svc.liberarPontoDeOutrosCanais('ton_bo', ' P1 ', 'BO_NOVA')).toEqual(['TONV2']);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = (prisma.$queryRaw.mock.calls[0][0] as string[]).join('?');
    expect(sql).toContain('UPDATE ton_bo SET equipamento_ponto_id = NULL');
    expect(prisma.$queryRaw.mock.calls[0].slice(1)).toEqual(['P1', 'BO_NOVA']);
    expect(resync).toHaveBeenCalledWith('TONV2', 'ton_bo');
  });

  it('BI usa a tabela ton_bi', async () => {
    const { prisma, svc } = montar([]);
    await svc.liberarPontoDeOutrosCanais('ton_bi', 'P2', 'BI1');
    expect((prisma.$queryRaw.mock.calls[0][0] as string[]).join('?')).toContain('UPDATE ton_bi');
  });

  it('sem ponto não faz nada', async () => {
    const { prisma, svc, resync } = montar([]);
    expect(await svc.liberarPontoDeOutrosCanais('ton_bo', null, 'X')).toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(resync).not.toHaveBeenCalled();
  });
});
