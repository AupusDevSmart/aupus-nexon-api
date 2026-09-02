import { SetMetadata } from '@nestjs/common';

/**
 * Chave para metadata de rotas públicas
 */
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Decorator para marcar rotas como públicas (sem autenticação)
 * Uso: @Public()
 *
 * Rotas marcadas com @Public() não requerem token JWT
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
