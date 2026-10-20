import { ForbiddenException } from '@nestjs/common';
import { SemOperadorGuard } from './sem-operador.guard';

const ctx = (user: any) => ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as any;

describe('SemOperadorGuard (PER-21/22)', () => {
  const guard = new SemOperadorGuard();

  it('operador leva 403 com a mensagem neutra (não diz se o recurso existe)', () => {
    expect(() => guard.canActivate(ctx({ id: 'op1', role: 'operador' }))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx({ id: 'op1', role: 'Operador' }))).toThrow('Recurso fora do escopo do usuario');
  });

  it('demais papéis passam (o escopo por planta segue no service)', () => {
    for (const role of ['super_admin', 'admin', 'analista', 'analista_operacao', 'gerente', 'proprietario', 'propietario']) {
      expect(guard.canActivate(ctx({ id: 'x', role }))).toBe(true);
    }
  });

  it('sem usuário (rota pública ou chamada interna) não decide nada', () => {
    expect(guard.canActivate(ctx(undefined))).toBe(true);
  });
});
