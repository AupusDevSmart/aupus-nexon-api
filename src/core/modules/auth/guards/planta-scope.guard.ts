import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionScopeService } from '../permission-scope.service';
import {
  PLANTA_SCOPE_KEY,
  PlantaScopeMetadata,
} from '../decorators/planta-scope.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Guard que aplica `assertEntityInScope` automaticamente em handlers marcados com
 * `@UsePlantaScope(...)`. Deve rodar APOS o JwtAuthGuard (que injeta req.user).
 *
 * Comportamento:
 * - Rotas marcadas com @Public() sao puladas.
 * - Sem @UsePlantaScope -> nao faz nada.
 * - Usuario admin/gerente/analista/super_admin -> passa (scope null).
 * - operador/proprietario -> assertEntityInScope; joga ForbiddenException se fora,
 *   NotFoundException se o id nao existe (para nao vazar existencia).
 */
@Injectable()
export class PlantaScopeGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private scopeService: PermissionScopeService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const meta = this.reflector.getAllAndOverride<PlantaScopeMetadata>(PLANTA_SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!meta) return true;

    const req = context.switchToHttp().getRequest();
    const user = req.user;
    const from = meta.from ?? 'param';
    const name = meta.name ?? 'id';

    const source =
      from === 'param' ? req.params :
      from === 'body' ? req.body :
      req.query;

    const id: string | undefined = source?.[name];
    if (!id) {
      throw new NotFoundException(`${meta.entity} nao encontrado`);
    }

    await this.scopeService.assertEntityInScope(meta.entity, id, user);
    return true;
  }
}
