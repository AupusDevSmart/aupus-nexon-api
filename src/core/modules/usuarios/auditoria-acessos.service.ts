import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { novoId26 } from '../../common/cliente-info';

export interface RegistroAcesso {
  autorId: string | null;
  alvoUsuarioId: string | null;
  acao: 'convite' | 'convite_reenviado' | 'permissoes';
  mensagem: string;
  detalhes?: Record<string, unknown>;
  plantaIds?: string[];
  unidadeIds?: string[];
  dispositivo?: string | null;
}

/**
 * Trilha de ACESSO (auditoria_acessos) — aparece em GET /logs-mqtt?tipo=acesso
 * ("Permissões alteradas", com autor e horário). Falha ao gravar só loga: a
 * mudança de permissão já foi feita e não deve voltar atrás por causa da trilha.
 */
@Injectable()
export class AuditoriaAcessosService {
  private readonly logger = new Logger(AuditoriaAcessosService.name);

  constructor(private readonly prisma: PrismaService) {}

  async registrar(r: RegistroAcesso): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        INSERT INTO auditoria_acessos
          (id, autor_id, alvo_usuario_id, acao, mensagem, detalhes, planta_ids, unidade_ids, dispositivo, created_at)
        VALUES
          (${novoId26()}, ${r.autorId?.trim() ?? null}, ${r.alvoUsuarioId?.trim() ?? null}, ${r.acao},
           ${r.mensagem.slice(0, 500)}, ${JSON.stringify(r.detalhes ?? {})}::jsonb,
           ${(r.plantaIds ?? []).map((x) => x.trim())}::text[], ${(r.unidadeIds ?? []).map((x) => x.trim())}::text[],
           ${r.dispositivo ?? null}, now())`;
    } catch (e) {
      this.logger.warn(`[auditoria] acesso não registrado (${r.acao}): ${(e as Error).message}`);
    }
  }
}
