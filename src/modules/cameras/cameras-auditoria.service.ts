import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/core';
import { AuditoriaAcessosService, type AcaoAuditoria } from '@/core/modules/usuarios/auditoria-acessos.service';
import { normalizarPapel } from '@/core/modules/auth/permission-scope.service';
import type { ClienteInfo } from '@/core/common/cliente-info';
import type { ContextoUnidade, NomeId, Usuario } from './cameras.tipos';

export interface RegistroCamera {
  mensagem: string;
  user?: Usuario | null;
  cliente?: ClienteInfo | null;
  unidade?: NomeId | null;
  planta?: NomeId | null;
  camera?: { id: string; nome: string; ip?: string | null; unidade_id?: string | null } | null;
  objetoTipo?: string;
  objetoId?: string | null;
  resultado?: 'ok' | 'negado' | 'erro';
  extra?: Record<string, unknown>;
}

const t = (v: string | null | undefined) => (v ? v.trim() : null);

/**
 * Trilha das câmeras em auditoria_acessos (acao camera_*). Mensagem sempre com câmera, unidade e
 * planta para a busca; detalhes com ip da câmera, quem, de onde (ip/dispositivo) e resultado.
 * Nunca lança: a ação já aconteceu.
 */
@Injectable()
export class CamerasAuditoriaService {
  private readonly logger = new Logger(CamerasAuditoriaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaAcessosService,
  ) {}

  /** Unidade + planta com ids sem padding; unidade inexistente/excluída → tudo null. */
  async contextoUnidade(unidadeId: string | null | undefined): Promise<ContextoUnidade> {
    const id = t(unidadeId);
    if (!id) return { unidade: null, planta: null };
    const u = await this.prisma.unidades.findFirst({
      where: { id, deleted_at: null },
      select: { id: true, nome: true, planta: { select: { id: true, nome: true } } },
    });
    if (!u) return { unidade: null, planta: null };
    return {
      unidade: { id: u.id.trim(), nome: u.nome },
      planta: u.planta ? { id: u.planta.id.trim(), nome: u.planta.nome } : null,
    };
  }

  async registrar(acao: AcaoAuditoria, r: RegistroCamera): Promise<void> {
    try {
      const user = r.user ?? undefined;
      await this.auditoria.registrar({
        autorId: t(user?.id),
        autorNome: user?.nome ?? null,
        alvoUsuarioId: null,
        acao,
        mensagem: r.mensagem,
        plantaIds: r.planta ? [r.planta.id] : [],
        unidadeIds: r.unidade ? [r.unidade.id] : r.camera?.unidade_id ? [r.camera.unidade_id] : [],
        dispositivo: r.cliente?.dispositivo ?? null,
        objetoTipo: r.objetoTipo ?? (r.camera ? 'camera' : 'unidade'),
        objetoId: r.objetoId ?? r.camera?.id ?? r.unidade?.id ?? null,
        resultado: r.resultado ?? 'ok',
        detalhes: {
          usuario: user
            ? {
                id: t(user.id),
                nome: user.nome ?? null,
                email: user.email ?? null,
                papel: user.role ? normalizarPapel(user.role) : null,
                via_token_midia: user.viaTokenMidia ?? false,
              }
            : null,
          camera: r.camera ? { id: r.camera.id, nome: r.camera.nome, ip: r.camera.ip ?? null } : null,
          unidade: r.unidade ?? null,
          planta: r.planta ?? null,
          ...(r.extra ?? {}),
          ip: r.cliente?.ip ?? null,
          dispositivo: r.cliente?.dispositivo ?? null,
          user_agent: r.cliente?.userAgent ?? null,
        },
      });
    } catch (e) {
      this.logger.warn(`[auditoria] ${acao} não registrado: ${(e as Error).message}`);
    }
  }
}
