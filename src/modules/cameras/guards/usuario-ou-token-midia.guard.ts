import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CamerasMidiaService } from '../cameras-midia.service';

/**
 * Para <img>, <video> e HLS, que não mandam header: aceita o JWT normal OU `?token=` (token de
 * mídia, 2 h). Com `?token=`, o usuário é recarregado do banco (ativo, papel atual) e o service
 * aplica o mesmo assertEntityInScope. A rota precisa de @Public() para o JwtAuthGuard global não recusar antes.
 */
@Injectable()
export class UsuarioOuTokenMidiaGuard extends AuthGuard('jwt') {
  constructor(private readonly midia: CamerasMidiaService) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const token = typeof req.query?.token === 'string' ? req.query.token.trim() : '';
    if (token) {
      // Usuário recarregado do banco: token de quem foi desativado ou trocou de papel não vale mais.
      const usuario = await this.midia.usuarioDoTokenMidia(token);
      if (!usuario) throw new UnauthorizedException('Token de mídia inválido, expirado ou de usuário inativo');
      req.user = { id: usuario.id, role: usuario.role, viaTokenMidia: true };
      return true;
    }
    return (await super.canActivate(context)) as boolean;
  }
}
