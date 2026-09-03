import { SetMetadata } from '@nestjs/common';

/**
 * Chave para metadata de permissões
 */
export const PERMISSIONS_KEY = 'permissions';

/**
 * Decorator para exigir permissões específicas em uma rota
 * Uso: @Permissions('Dashboard', 'Usuarios')
 *
 * O usuário deve ter pelo menos uma das permissões listadas
 */
export const Permissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
