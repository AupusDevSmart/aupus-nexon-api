import { Injectable, Logger } from '@nestjs/common';
import { AuditoriaAcessosService } from '@/core/modules/usuarios/auditoria-acessos.service';
import { normalizarPapel } from '@/core/modules/auth/permission-scope.service';
import type { ClienteInfo } from '@/core/common/cliente-info';
import type { ContextoCarregador } from './carregador-ocpp.repositorio';

export type AcaoCarregador = 'carregador_comando' | 'carregador_config' | 'carregador_ocpp';

export interface RegistroCarregador {
  /** O que aconteceu, sem o nome do carregador (entra sozinho na mensagem). */
  mensagem: string;
  user?: { id?: string; nome?: string | null; email?: string | null; role?: string | null } | null;
  cliente?: ClienteInfo | null;
  contexto?: ContextoCarregador | null;
  resultado?: 'ok' | 'negado' | 'erro';
  /** Comando, morador, resposta do carregador, antes → depois... vai em `detalhes`. */
  extra?: Record<string, unknown>;
}

const t = (v: string | null | undefined) => (v ? String(v).trim() : null);

/**
 * Trilha do carregador em `auditoria_acessos` (ações `carregador_*`), a mesma tabela dos
 * comandos de câmera e da calibração do pivô: aparece em `/logs-mqtt?tipo=acesso`.
 *
 * A mensagem leva sempre carregador, instalação e planta (é por elas que se busca); os
 * detalhes levam quem, com que papel, de onde (aparelho e IP), o comando OCPP, a resposta
 * do carregador e o antes → depois. Nunca lança: a ação já aconteceu.
 */
@Injectable()
export class CarregadorAuditoriaService {
  private readonly logger = new Logger(CarregadorAuditoriaService.name);

  constructor(private readonly auditoria: AuditoriaAcessosService) {}

  async registrar(acao: AcaoCarregador, r: RegistroCarregador): Promise<void> {
    try {
      const c = r.contexto ?? null;
      const onde = c ? [c.nome, c.unidade?.nome, c.planta?.nome].filter(Boolean).join(' · ') : '';
      await this.auditoria.registrar({
        autorId: t(r.user?.id),
        autorNome: r.user?.nome ?? r.user?.email ?? null,
        alvoUsuarioId: null,
        acao,
        mensagem: onde ? `${r.mensagem} · ${onde}` : r.mensagem,
        plantaIds: c?.planta ? [c.planta.id] : [],
        unidadeIds: c?.unidade ? [c.unidade.id] : [],
        dispositivo: r.cliente?.dispositivo ?? null,
        objetoTipo: 'carregador',
        objetoId: c?.id ?? null,
        resultado: r.resultado ?? 'ok',
        detalhes: {
          usuario: r.user
            ? { id: t(r.user.id), nome: r.user.nome ?? null, email: r.user.email ?? null, papel: r.user.role ? normalizarPapel(r.user.role) : null }
            : null,
          carregador: c ? { id: c.id, nome: c.nome } : null,
          unidade: c?.unidade ?? null,
          planta: c?.planta ?? null,
          cliente: r.cliente ? { plataforma: r.cliente.plataforma, aparelho: r.cliente.aparelho, ip: r.cliente.ip } : null,
          ...(r.extra ?? {}),
        },
      });
    } catch (e) {
      this.logger.warn(`auditoria do carregador não gravada: ${e instanceof Error ? e.message : e}`);
    }
  }
}
