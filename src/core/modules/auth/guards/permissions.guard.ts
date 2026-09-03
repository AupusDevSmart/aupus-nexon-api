import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Guard de Permissões
 * Verifica se o usuário tem as permissões necessárias para acessar a rota
 *
 * Uso em conjunto com @Permissions() decorator
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Rotas marcadas com @Public() nao passam por validacao de permissao
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    // Buscar permissões requeridas da metadata
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Se não há permissões requeridas, permitir acesso
    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    // Extrair usuário do request (injetado pelo JwtAuthGuard)
    const { user } = context.switchToHttp().getRequest();

    if (!user || !user.permissions) {
      console.log(`❌ [PERMISSIONS GUARD] Usuário sem permissões`);
      return false;
    }

    // Verificar se o usuário tem pelo menos uma das permissões requeridas
    const hasPermission = requiredPermissions.some((permission) =>
      user.permissions.includes(permission),
    );

    if (!hasPermission) {
      console.log(
        `❌ [PERMISSIONS GUARD] Usuário ${user.id} não tem permissão. Requerido: [${requiredPermissions.join(', ')}], Possui: [${user.permissions.join(', ')}]`,
      );
    } else {
      console.log(
        `✅ [PERMISSIONS GUARD] Usuário ${user.id} autorizado para rota`,
      );
    }

    return hasPermission;
  }
}
