/**
 * Prisma falso, só com o que o escopo por planta e a trilha de exportação leem.
 * Duas plantas (P1 do proprietário "dono1", P2 de "dono2"), uma unidade e um
 * equipamento em cada, e o operador "op1" vinculado só à P1.
 */
export const FIXTURE = {
  plantas: [
    { id: 'P1', nome: 'Usina Um', proprietario_id: 'dono1', deleted_at: null },
    { id: 'P2', nome: 'Usina Dois', proprietario_id: 'dono2', deleted_at: null },
  ],
  unidades: [
    { id: 'U1', nome: 'Unidade Um', planta_id: 'P1', deleted_at: null },
    { id: 'U2', nome: 'Unidade Dois', planta_id: 'P2', deleted_at: null },
  ],
  equipamentos: [
    { id: 'E1', nome: 'Medidor Um', planta_id: null, unidade_id: 'U1', deleted_at: null },
    { id: 'E2', nome: 'Medidor Dois', planta_id: 'P2', unidade_id: 'U2', deleted_at: null },
  ],
  planta_operadores: [{ usuario_id: 'op1', planta_id: 'P1' }],
};

const casa = (row: any, where: any = {}): boolean =>
  Object.entries(where).every(([k, v]: [string, any]) => {
    if (v && typeof v === 'object' && 'in' in v) return v.in.includes(row[k]);
    return row[k] === v;
  });

const comUnidade = (e: any) => ({
  ...e,
  unidade: FIXTURE.unidades.find((u) => u.id === e.unidade_id) ?? null,
});

export function prismaEscopoFake() {
  return {
    plantas: {
      findMany: jest.fn(async ({ where }: any) => FIXTURE.plantas.filter((p) => casa(p, where))),
      findFirst: jest.fn(async ({ where }: any) => FIXTURE.plantas.find((p) => casa(p, where)) ?? null),
    },
    planta_operadores: {
      findMany: jest.fn(async ({ where }: any) => FIXTURE.planta_operadores.filter((p) => casa(p, where))),
    },
    unidades: {
      findMany: jest.fn(async ({ where }: any) => FIXTURE.unidades.filter((u) => casa(u, where))),
      findFirst: jest.fn(async ({ where }: any) => FIXTURE.unidades.find((u) => casa(u, where)) ?? null),
    },
    equipamentos: {
      findMany: jest.fn(async ({ where }: any) => FIXTURE.equipamentos.filter((e) => casa(e, where)).map(comUnidade)),
      findFirst: jest.fn(async ({ where }: any) => {
        const e = FIXTURE.equipamentos.find((x) => casa(x, where));
        return e ? comUnidade(e) : null;
      }),
    },
    $executeRaw: jest.fn(async () => 1),
    $queryRaw: jest.fn(async () => []),
  };
}
