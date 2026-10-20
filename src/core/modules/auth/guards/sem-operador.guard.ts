import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { AuditoriaAcessosService } from '../../usuarios/auditoria-acessos.service';
import { registrarAcessoNegado } from '../acesso-negado';
import { papelCanonico } from '../papeis';

/**
 * Rota fechada para operador (PER-21/22): unifilar, comunicação, IoT/gateway e
 * TON são cadastro técnico. 403 sem dizer se o recurso existe — roda antes do
 * service, então nem o 404 de "não encontrado" chega a ele.
 * Usar depois do JwtAuthGuard: `@UseGuards(JwtAuthGuard, SemOperadorGuard)`.
 */
@Injectable()
export class SemOperadorGuard implements CanActivate {
  constructor(@Optional() private readonly auditoria?: AuditoriaAcessosService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const user = req?.user;
    if (user && papelCanonico(user.role) === 'operador') {
      // 403 de guard não passa pelo AcessoNegadoInterceptor: grava aqui (PER-43).
      void registrarAcessoNegado(this.auditoria, req, 'rota fechada para operador').catch(() => undefined);
      throw new ForbiddenException('Recurso fora do escopo do usuario');
    }
    return true;
  }
}
