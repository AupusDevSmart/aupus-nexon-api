import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { Sentry } from '../../config/sentry.config';

@Injectable()
export class SentryMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    // Adicionar contexto do usuário se disponível (após autenticação)
    if (req.user) {
      Sentry.setUser({
        id: (req.user as any).id,
        username: (req.user as any).username,
        email: (req.user as any).email,
      });
    }

    // Adicionar tags úteis
    Sentry.setTags({
      method: req.method,
      path: req.path,
    });

    // Adicionar contexto da requisição
    Sentry.setContext('request', {
      method: req.method,
      url: req.url,
      path: req.path,
      query: req.query,
    });

    next();
  }
}
