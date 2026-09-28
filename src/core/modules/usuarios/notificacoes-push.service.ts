import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export type CategoriaNotificacao = 'alarmes_criticos' | 'alarmes_atencao' | 'comandos' | 'resumo_diario';

/**
 * Envio de push para os apps NexON — AINDA NÃO IMPLEMENTADO.
 *
 * O que já existe: preferências (usuario_notificacoes) e tokens
 * (dispositivos_push), gravados pelos apps em /usuarios/me/notificacoes e
 * /usuarios/me/dispositivos.
 *
 * TODO(push): falta credencial — APNs (.p8 + key id + team id + bundle
 * com.aupusenergia.nexon) e Firebase (service account) para o Android. Com elas:
 *   1. ler os tokens do usuário filtrando pela preferência da categoria;
 *   2. mandar via HTTP/2 (APNs) / FCM v1;
 *   3. apagar token que o provedor devolver como inválido (410 / UNREGISTERED).
 * Pontos de chamada previstos: criação de alerta (regras-logs-mqtt) e resultado
 * de comando (equipamentos-cmd).
 */
@Injectable()
export class NotificacoesPushService {
  private readonly logger = new Logger(NotificacoesPushService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Stub: só registra no log quem receberia. Nunca lança. */
  async enviar(usuarioId: string, categoria: CategoriaNotificacao, titulo: string, _corpo: string): Promise<void> {
    try {
      const tokens = await this.prisma.$queryRaw<Array<{ plataforma: string }>>`
        SELECT d.plataforma FROM dispositivos_push d
        LEFT JOIN usuario_notificacoes n ON TRIM(n.usuario_id) = TRIM(d.usuario_id)
        WHERE TRIM(d.usuario_id) = ${usuarioId.trim()}`;
      this.logger.debug(`[push] (stub, sem credencial) ${categoria} "${titulo}" → ${tokens.length} aparelho(s) de ${usuarioId}`);
    } catch {
      /* tabela ausente: nada a fazer */
    }
  }
}
