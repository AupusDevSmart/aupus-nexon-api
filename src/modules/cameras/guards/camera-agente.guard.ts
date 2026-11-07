import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { CamerasMidiaService } from '../cameras-midia.service';
import type { AgenteInfo } from '../cameras.tipos';

/**
 * Autentica o AGENTE (máquina), não um usuário: `Authorization: Bearer nxcam_...` → sha256 →
 * cameras_agentes.token_hash (ativo, não excluído) → `req.agente`. Comparação do hash em tempo
 * constante (CamerasMidiaService.agentePorToken), como o TokenServicoGuard da sincronização.
 * O controller do agente é separado do de usuário e marcado @Public() para o JwtAuthGuard global
 * não exigir JWT — quem fecha a porta é este guard.
 */
@Injectable()
export class CameraAgenteGuard implements CanActivate {
  private readonly logger = new Logger(CameraAgenteGuard.name);

  constructor(private readonly midia: CamerasMidiaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const h = req.headers?.authorization;
    const token = typeof h === 'string' && /^Bearer\s+\S+$/i.test(h.trim()) ? h.trim().replace(/^Bearer\s+/i, '') : null;
    if (!token) throw new UnauthorizedException('Token do agente ausente');
    const agente = await this.midia.agentePorToken(token);
    if (!agente) {
      this.logger.warn(`[cameras] token de agente inválido (origem ${req.ip ?? '?'})`);
      throw new UnauthorizedException('Token do agente inválido');
    }
    req.agente = agente;
    return true;
  }
}

/** `@Agente() agente: AgenteInfo` — o agente autenticado pelo CameraAgenteGuard. */
export const Agente = createParamDecorator((_: unknown, ctx: ExecutionContext): AgenteInfo => {
  return ctx.switchToHttp().getRequest().agente;
});
