import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Decorator legado que retorna o ID do proprietario quando o usuario eh dono
 * das proprias plantas (role = 'proprietario'). Para os demais, retorna null.
 *
 * NAO confundir com o RBAC scope por planta (PermissionScopeService): aquele
 * cuida do filtro de operador via planta_operadores. Este decorator existe
 * para o caso especifico de proprietario querer ver SO suas plantas via
 * coluna `plantas.proprietario_id = user.id`.
 *
 * Comportamento:
 * - role === 'proprietario': retorna user.id (filtro ativo na coluna proprietario_id)
 * - qualquer outro role (admin, super_admin, gerente, analista, operador): retorna null
 *
 * IMPORTANTE: para operador, retornar user.id quebrava a listagem porque
 * filtrava plantas onde proprietario_id = <id-do-operador>, e operador nao
 * eh proprietario de nenhuma planta. O scope correto via planta_operadores
 * acontece no service via PermissionScopeService.
 *
 * Uso:
 * @Get()
 * findAll(@UserProprietarioId() proprietarioId: string | null) {
 *   // proprietarioId sera user.id para proprietario, null para os demais.
 * }
 */
export const UserProprietarioId = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): string | null => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      return null;
    }

    const userRole = user.role || '';

    // So aplica o filtro por proprietario_id quando o user EH proprietario.
    if (userRole === 'proprietario') {
      return user.id || user.sub || null;
    }

    return null;
  },
);
