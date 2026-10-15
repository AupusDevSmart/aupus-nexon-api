import { ForbiddenException } from '@nestjs/common';
import { PermissionScopeService, isPapelSemEscopo, normalizarPapel } from './permission-scope.service';
import { prismaEscopoFake } from './testing/prisma-escopo.fake';

describe('PermissionScopeService — default-deny', () => {
  let prisma: ReturnType<typeof prismaEscopoFake>;
  let scope: PermissionScopeService;

  beforeEach(() => {
    prisma = prismaEscopoFake();
    scope = new PermissionScopeService(prisma as any);
  });

  it.each(['super_admin', 'admin', 'gerente', 'analista', ' Admin '])('papel administrativo %p vê tudo (escopo nulo)', async (role) => {
    expect(await scope.getScope({ id: 'adm', role })).toBeNull();
  });

  it('operador vê só as plantas vinculadas', async () => {
    expect(await scope.getScope({ id: 'op1', role: 'operador' })).toEqual(['P1']);
  });

  it("proprietario e o typo 'propietario' veem só as plantas dele", async () => {
    expect(await scope.getScope({ id: 'dono1', role: 'proprietario' })).toEqual(['P1']);
    expect(await scope.getScope({ id: 'dono2', role: 'propietario' })).toEqual(['P2']);
  });

  it.each(['cativo', 'associado', 'consultor', 'aupus', null, ''])('papel %p sem vínculo não vê nada', async (role) => {
    expect(await scope.getScope({ id: 'ninguem', role })).toEqual([]);
  });

  it('papel desconhecido com vínculo vê só o vínculo (dono ∪ operador)', async () => {
    expect(await scope.getScope({ id: 'dono1', role: 'cativo' })).toEqual(['P1']);
    expect(await scope.getScope({ id: 'op1', role: 'associado' })).toEqual(['P1']);
  });

  it('chamada interna sem usuário continua sem filtro', async () => {
    expect(await scope.getScope(undefined)).toBeNull();
  });

  it('normaliza papel', () => {
    expect(normalizarPapel(' PROPIETARIO ')).toBe('proprietario');
    expect(isPapelSemEscopo('super_admin')).toBe(true);
    expect(isPapelSemEscopo('cativo')).toBe(false);
  });

  describe('assertEntityInScope', () => {
    it('admin acessa equipamento e unidade de qualquer planta', async () => {
      const admin = { id: 'adm', role: 'admin' };
      await expect(scope.assertEntityInScope('equipamento', 'E2', admin)).resolves.toBeUndefined();
      await expect(scope.assertEntityInScope('unidade', 'U1', admin)).resolves.toBeUndefined();
    });

    it('proprietário acessa o seu (via unidade) e recebe 403 no de outra planta', async () => {
      const dono = { id: 'dono1', role: 'proprietario' };
      await expect(scope.assertEntityInScope('equipamento', 'E1', dono)).resolves.toBeUndefined();
      await expect(scope.assertEntityInScope('equipamento', 'E2', dono)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(scope.assertEntityInScope('unidade', 'U2', dono)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('papel desconhecido sem vínculo recebe 403 em tudo', async () => {
      const cativo = { id: 'ninguem', role: 'cativo' };
      await expect(scope.assertEntityInScope('equipamento', 'E1', cativo)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(scope.assertEntityInScope('unidade', 'U1', cativo)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
