import { CallHandler, ExecutionContext, ForbiddenException, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { extrairClienteInfo } from '../../common/cliente-info';
import { AuditoriaAcessosService } from '../usuarios/auditoria-acessos.service';

const METODOS_DE_ACAO = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Tentativa negada (403) de comando, parâmetro ou cadastro vai para a
 * auditoria (spec NEXON-20, PER-43). Só métodos de ação: leitura negada é
 * ruído (lista que o front chama sem saber o papel).
 */
export async function registrarAcessoNegado(
  auditoria: AuditoriaAcessosService | undefined,
  req: any,
  motivo: string,
): Promise<void> {
  if (!auditoria || !req || !METODOS_DE_ACAO.has(String(req.method).toUpperCase())) return;
  const rota = `${req.method} ${req.route?.path ?? String(req.originalUrl ?? req.url ?? '').split('?')[0]}`;
  const params = (req.params ?? {}) as Record<string, string>;
  const objetoId = params.id ?? params.equipamentoId ?? params.pontoId ?? params.setpointId ?? null;
  const tipo = /equipamento|pivo|carregador|setpoint|pontos|cmd|ocpp|bomba/i.test(rota) ? 'equipamento'
    : /usuario/i.test(rota) ? 'usuario' : /planta/i.test(rota) ? 'planta' : /unidade/i.test(rota) ? 'unidade' : 'rota';
  await auditoria.registrar({
    autorId: req.user?.id ?? null,
    autorNome: req.user?.nome ?? null,
    alvoUsuarioId: tipo === 'usuario' ? objetoId : null,
    acao: 'acesso_negado',
    mensagem: `Negado: ${rota} — ${motivo}`.slice(0, 500),
    detalhes: { metodo: req.method, rota, params, papel: req.user?.role ?? null, motivo },
    dispositivo: extrairClienteInfo(req).dispositivo,
    objetoTipo: tipo,
    objetoId,
    resultado: 'negado',
    rota,
  });
}

/** Pega o 403 lançado DENTRO do handler/serviço (o do guard é gravado no próprio guard). */
@Injectable()
export class AcessoNegadoInterceptor implements NestInterceptor {
  constructor(private readonly auditoria: AuditoriaAcessosService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((err) => {
        if (err instanceof ForbiddenException && context.getType() === 'http') {
          void registrarAcessoNegado(this.auditoria, context.switchToHttp().getRequest(), err.message);
        }
        return throwError(() => err);
      }),
    );
  }
}
