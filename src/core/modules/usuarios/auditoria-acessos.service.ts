import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { novoId26 } from '../../common/cliente-info';

export type AcaoAuditoria =
  | 'convite'
  | 'convite_reenviado'
  | 'permissoes'
  | 'exportacao'
  | 'exportacao_negada'
  | 'configuracao_demanda'
  | 'chamado_aberto'
  | 'chamado_encaminhado'
  | 'chamado_envio'
  | 'chamado_fechado'
  // NEXON-20 (spec de permissões, seção 8)
  | 'usuario_criado'
  | 'usuario_alterado'
  | 'usuario_desativado'
  | 'usuario_reativado'
  | 'usuario_excluido'
  | 'papel_alterado'
  | 'vinculo_criado'
  | 'vinculo_alterado'
  | 'vinculo_removido'
  | 'operador_desativado'
  | 'operador_reativado'
  | 'acesso_negado'
  // NEXON-25 (Configurações › Notificações)
  | 'regra_notificacao'
  // NEXON-31 (unifilar: layout e agrupamentos)
  | 'diagrama_layout'
  // NEXON-37 (config "Usina" da análise de geração, inclusive a fonte da geração)
  | 'usina_config';

export interface RegistroAcesso {
  autorId: string | null;
  alvoUsuarioId: string | null;
  acao: AcaoAuditoria;
  mensagem: string;
  /** Antes → depois e o resto do contexto; vai em `detalhes` (jsonb). */
  detalhes?: Record<string, unknown>;
  plantaIds?: string[];
  unidadeIds?: string[];
  dispositivo?: string | null;
  /** Facilitadores de busca: o que foi mexido (usuario, vinculo, equipamento, rota...). */
  objetoTipo?: string | null;
  objetoId?: string | null;
  /** 'ok' | 'negado' | 'erro'. */
  resultado?: 'ok' | 'negado' | 'erro';
  /** Nomes gravados junto: o log continua legível se o usuário for desativado (PER-44). */
  autorNome?: string | null;
  alvoNome?: string | null;
  rota?: string | null;
}

/**
 * Trilha de ACESSO (auditoria_acessos) — aparece em GET /logs-mqtt?tipo=acesso
 * ("Permissões alteradas", com autor e horário). Também guarda as exportações de
 * dados (acao 'exportacao' / 'exportacao_negada', ver ExportacaoAuditoriaService),
 * cadastro de usuário, papel, vínculo de operador e tentativa negada (403).
 *
 * Tabela só-inserção (trigger do SQL 2026-10-20c): ninguém edita nem exclui.
 * Falha ao gravar só loga: a ação já foi feita e não volta atrás por causa da trilha.
 */
@Injectable()
export class AuditoriaAcessosService {
  private readonly logger = new Logger(AuditoriaAcessosService.name);
  /** false depois que o INSERT com as colunas novas falhou por coluna ausente (SQL não aplicado). */
  private colunasNovas = true;

  constructor(private readonly prisma: PrismaService) {}

  async registrar(r: RegistroAcesso): Promise<void> {
    const id = novoId26();
    const autor = r.autorId?.trim() || null;
    const alvo = r.alvoUsuarioId?.trim() || null;
    const mensagem = r.mensagem.slice(0, 500);
    const detalhes = JSON.stringify(r.detalhes ?? {});
    const plantas = (r.plantaIds ?? []).filter(Boolean).map((x) => x.trim());
    const unidades = (r.unidadeIds ?? []).filter(Boolean).map((x) => x.trim());
    const dispositivo = r.dispositivo?.slice(0, 120) ?? null;
    try {
      if (this.colunasNovas) {
        try {
          await this.prisma.$executeRaw`
            INSERT INTO auditoria_acessos
              (id, autor_id, alvo_usuario_id, acao, mensagem, detalhes, planta_ids, unidade_ids, dispositivo,
               objeto_tipo, objeto_id, resultado, autor_nome, alvo_nome, rota, created_at)
            VALUES
              (${id}, ${autor}, ${alvo}, ${r.acao}, ${mensagem}, ${detalhes}::jsonb,
               ${plantas}::text[], ${unidades}::text[], ${dispositivo},
               ${r.objetoTipo?.slice(0, 40) ?? null}, ${r.objetoId?.trim().slice(0, 60) ?? null},
               ${r.resultado ?? 'ok'}, ${r.autorNome?.slice(0, 255) ?? null}, ${r.alvoNome?.slice(0, 255) ?? null},
               ${r.rota?.slice(0, 255) ?? null}, now())`;
          return;
        } catch (e) {
          if (!/column .* does not exist/i.test((e as Error).message ?? '')) throw e;
          this.colunasNovas = false;
          this.logger.warn('[auditoria] colunas novas ausentes (SQL 2026-10-20c não aplicado): gravando no formato antigo');
        }
      }
      await this.prisma.$executeRaw`
        INSERT INTO auditoria_acessos
          (id, autor_id, alvo_usuario_id, acao, mensagem, detalhes, planta_ids, unidade_ids, dispositivo, created_at)
        VALUES
          (${id}, ${autor}, ${alvo}, ${r.acao}, ${mensagem}, ${detalhes}::jsonb,
           ${plantas}::text[], ${unidades}::text[], ${dispositivo}, now())`;
    } catch (e) {
      this.logger.warn(`[auditoria] acesso não registrado (${r.acao}): ${(e as Error).message}`);
    }
  }
}
