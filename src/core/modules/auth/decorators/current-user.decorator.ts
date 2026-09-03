import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Decorator para extrair o usuário atual do request
 * Uso: @CurrentUser() user: any
 *
 * Extrai os dados do usuário que foram injetados pela JwtStrategy
 */
export const CurrentUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
