import { PermissionScopeService } from '../auth/permission-scope.service';
import { FIXTURE, prismaEscopoFake } from '../auth/testing/prisma-escopo.fake';
import { UnidadesService } from '../unidades/unidades.service';
import { EquipamentosService } from '../equipamentos/equipamentos.service';
import { PlantasService } from './plantas.service';

/**
 * Recorte do operador nas listas e totais (PER-21e/23/24). Fixture: "op1" tem
 * só o E1 liberado (U1, P1). O escopo vem do PermissionScopeService de verdade
 * sobre o Prisma falso; o Prisma do service só grava o `where` que recebeu.
 */
const OP1 = { id: 'op1', role: 'operador' };
const DONO1 = { id: 'dono1', role: 'proprietario' };
const ADMIN = { id: 'adm', role: 'admin' };

function prismaQueGrava() {
  const chamadas: Record<string, any[]> = {};
  const grava = (nome: string, resposta: any) =>
    jest.fn(async (args: any) => {
      (chamadas[nome] ??= []).push(args);
      return typeof resposta === 'function' ? resposta(args) : resposta;
    });
  const prisma: any = {
    unidades: {
      findMany: grava('unidades.findMany', []),
      count: grava('unidades.count', 0),
      findFirst: grava('unidades.findFirst', { id: 'U1', nome: 'Unidade Um', planta_id: 'P1', planta: { id: 'P1' } }),
    },
    plantas: { findFirst: grava('plantas.findFirst', { id: 'P1' }) },
    equipamentos: {
      findMany: grava('equipamentos.findMany', []),
      count: grava('equipamentos.count', 0),
      groupBy: grava('equipamentos.groupBy', []),
      aggregate: grava('equipamentos.aggregate', { _sum: { valor_contabil: null } }),
    },
  };
  return { prisma, chamadas };
}

const scope = () => new PermissionScopeService(prismaEscopoFake() as any);
const temFiltroId = (where: any, ids: string[]) =>
  JSON.stringify(where).includes(JSON.stringify({ id: { in: ids } }));

describe('Recorte do operador em instalações e equipamentos', () => {
  it('lista de instalações: operador só vê as que têm equipamento liberado', async () => {
    const { prisma, chamadas } = prismaQueGrava();
    await new UnidadesService(prisma, scope()).findAll({} as any, OP1);
    const where = chamadas['unidades.findMany'][0].where;
    expect(temFiltroId(where, ['U1'])).toBe(true);
    // contagem de equipamentos só dos liberados
    expect(chamadas['unidades.findMany'][0].include._count.select.equipamentos.where.id).toEqual({ in: ['E1'] });
    expect(chamadas['unidades.count'][0].where).toBe(where);
  });

  it('proprietário e admin: sem recorte por equipamento', async () => {
    for (const user of [DONO1, ADMIN]) {
      const { prisma, chamadas } = prismaQueGrava();
      await new UnidadesService(prisma, scope()).findAll({} as any, user);
      expect(temFiltroId(chamadas['unidades.findMany'][0].where, ['U1'])).toBe(false);
      expect(chamadas['unidades.findMany'][0].include._count.select).toEqual({ equipamentos: true });
    }
  });

  it('instalações da planta e estatísticas: só liberados, sem rótulo do corte', async () => {
    const { prisma, chamadas } = prismaQueGrava();
    const svc = new UnidadesService(prisma, scope());
    await svc.findByPlanta('P1', OP1);
    expect(chamadas['unidades.findMany'][0].where.id).toEqual({ in: ['U1'] });
    await svc.getEstatisticas('U1', OP1);
    expect(chamadas['equipamentos.count'][0].where.id).toEqual({ in: ['E1'] });
    expect(chamadas['equipamentos.groupBy'].every((c: any) => c.where.id?.in?.[0] === 'E1')).toBe(true);
  });

  it('planta → instalações (rota de plantas): mesmo recorte', async () => {
    const { prisma, chamadas } = prismaQueGrava();
    const svc = new PlantasService(prisma, scope());
    await svc.findUnidadesByPlanta('P1', undefined, undefined, null, OP1);
    const arg = chamadas['unidades.findMany'][0];
    expect(arg.where.id).toEqual({ in: ['U1'] });
    expect(arg.include._count.select.equipamentos.where.id).toEqual({ in: ['E1'] });
  });

  it('lista de equipamentos: operador só os liberados; admin sem filtro', async () => {
    const op = prismaQueGrava();
    await new EquipamentosService(op.prisma, scope()).findAll({ unidade_id: 'U1' } as any, OP1);
    expect(op.chamadas['equipamentos.findMany'][0].where.AND).toContainEqual({ id: { in: ['E1'] } });

    const adm = prismaQueGrava();
    await new EquipamentosService(adm.prisma, scope()).findAll({ unidade_id: 'U1' } as any, ADMIN);
    expect(temFiltroId(adm.chamadas['equipamentos.findMany'][0].where, ['E1'])).toBe(false);
  });

  it('lista de equipamentos esconde pai e filhos fora do liberado', async () => {
    const { prisma } = prismaQueGrava();
    prisma.equipamentos.findMany = jest.fn(async () => [
      {
        id: 'E1', diagrama_id: null,
        equipamento_pai: { id: 'E9', nome: 'Pai não liberado' },
        equipamentos_filhos: [{ id: 'E2', nome: 'Filho de outro' }],
      },
    ]);
    const r = await new EquipamentosService(prisma, scope()).findAll({} as any, OP1);
    expect(r.data[0].equipamento_pai).toBeNull();
    expect(r.data[0].equipamentos_filhos).toEqual([]);
    expect(r.data[0].totalComponentes).toBe(0);
  });

  it('estatísticas da instalação por equipamento: totais só dos liberados', async () => {
    const { prisma, chamadas } = prismaQueGrava();
    await new EquipamentosService(prisma, scope()).getEstatisticasUnidade('U1', OP1);
    expect(chamadas['equipamentos.count'].every((c: any) => c.where.id?.in?.[0] === 'E1')).toBe(true);
    // Valor contábil (R$) só soma o que tem "Ver R$": op1 libera E1 sem a permissão extra.
    expect(chamadas['equipamentos.aggregate'][0].where.id).toEqual({ in: [] });
  });

  it('fixture coerente: op1 libera só E1', () => {
    expect(FIXTURE.vinculo_equipamentos).toEqual([{ operador_id: 'op1', equipamento_id: 'E1', ver_rs: false }]);
  });
});
