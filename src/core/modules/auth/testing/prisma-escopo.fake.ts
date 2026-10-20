/**
 * Prisma falso, só com o que o escopo por planta e a trilha de exportação leem.
 * Duas plantas (P1 do proprietário "dono1", P2 de "dono2"), uma unidade e um
 * equipamento em cada, e o operador "op1" vinculado só à P1 (vínculo com
 * "dono1" liberando o E1, como a migração de planta_operadores deixa).
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
  /** operador_vinculo_equipamentos achatado: operador → equipamentos liberados. */
  vinculo_equipamentos: [{ operador_id: 'op1', equipamento_id: 'E1', ver_rs: false }],
  /** operador_vinculo_unidades com ver_geracao. */
  vinculo_ver_geracao: [] as Array<{ operador_id: string; unidade_id: string }>,
  anexos_equipamentos: [
    { id: 'AX1', equipamento_id: 'E1', nome_original: 'manual-um.pdf', deleted_at: null },
    { id: 'AX2', equipamento_id: 'E2', nome_original: 'manual.pdf', deleted_at: null },
  ],
  anexos_unidades: [
    { id: 'AU1', unidade_id: 'U1', nome_original: 'laudo.pdf', deleted_at: null },
    { id: 'AU2', unidade_id: 'U2', nome_original: 'laudo-dois.pdf', deleted_at: null },
  ],
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
    anexos_equipamentos: {
      findFirst: jest.fn(async ({ where }: any) => FIXTURE.anexos_equipamentos.find((a) => casa(a, where)) ?? null),
    },
    anexos_unidades: {
      findFirst: jest.fn(async ({ where }: any) => FIXTURE.anexos_unidades.find((a) => casa(a, where)) ?? null),
    },
    $executeRaw: jest.fn(async () => 1),
    // Só as duas consultas do acesso do operador (PermissionScopeService.getAcessoOperador).
    $queryRaw: jest.fn(async (strings: TemplateStringsArray | string[], ...values: any[]) => {
      const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
      const operador = String(values[0] ?? '').trim();
      if (sql.includes('WITH RECURSIVE lib')) {
        return FIXTURE.vinculo_equipamentos
          .filter((v) => v.operador_id === operador)
          .map((v) => {
            const e = comUnidade(FIXTURE.equipamentos.find((x) => x.id === v.equipamento_id));
            return { id: e.id, planta_id: e.planta_id ?? e.unidade?.planta_id ?? null, unidade_id: e.unidade_id, ver_rs: v.ver_rs };
          });
      }
      if (sql.includes('operador_vinculo_unidades')) {
        return FIXTURE.vinculo_ver_geracao.filter((v) => v.operador_id === operador).map((v) => ({ unidade_id: v.unidade_id }));
      }
      return [];
    }),
  };
}
