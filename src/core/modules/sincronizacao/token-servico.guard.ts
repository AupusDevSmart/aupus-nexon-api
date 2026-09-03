import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';

/**
 * Autentica o OUTRO BACKEND, nao um usuario.
 *
 * A rota de recepcao nao pode aceitar JWT de usuario: ela grava por cima de
 * cadastro preservando id e versao, sem passar pelas regras de formulario. Um
 * usuario com token valido nao deve alcancar isso.
 *
 * Por isso o modulo e separado e tem guard proprio. Uma rota assim pendurada
 * dentro de `plantas` herdaria o guard de usuario do controller no dia em que
 * alguem mexesse nos decorators — e ninguem perceberia.
 *
 * Comparacao em tempo constante: comparar segredo com `===` vaza o tamanho do
 * prefixo correto pelo tempo de resposta.
 */
@Injectable()
export class TokenServicoGuard implements CanActivate {
  private readonly logger = new Logger(TokenServicoGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const esperado = process.env.SINCRONIZACAO_TOKEN;

    // Sem segredo configurado a rota fica FECHADA. O contrario — abrir quando
    // falta configuracao — transformaria um `.env` incompleto em porta aberta
    // para escrever em cadastro, e o sintoma seria nenhum.
    if (!esperado) {
      this.logger.error('SINCRONIZACAO_TOKEN nao configurado: recepcao recusada');
      throw new UnauthorizedException('Sincronização não configurada neste servidor');
    }

    const req = context.switchToHttp().getRequest();
    const recebido = req.headers['x-sincronizacao-token'];

    if (typeof recebido !== 'string' || !this.igual(recebido, esperado)) {
      throw new UnauthorizedException('Token de sincronização inválido');
    }
    return true;
  }

  private igual(a: string, b: string): boolean {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    // `timingSafeEqual` exige o mesmo tamanho. Comparar o tamanho antes vaza so
    // o tamanho do segredo, que nao ajuda quem esta tentando adivinhar.
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  }
}
