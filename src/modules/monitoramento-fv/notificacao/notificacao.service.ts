import { Injectable } from '@nestjs/common';
import { PrismaService } from '@aupus/api-shared';
import { NOTIFICACAO_TIPOS, getNotificacaoTipo } from './notificacao-tipos';

/**
 * Serviço de notificações — FASE 0 (scaffold). Só metadados dos tipos + PREVIEW do
 * texto. NÃO envia nada (o dispatcher/WhatsApp é Fase 2, e envio real só com
 * autorização). Ver docs/INTEGRACAO_NEXON_DASHBOARD.md.
 */
@Injectable()
export class NotificacaoService {
  constructor(private readonly prisma: PrismaService) {}

  /** Lista os tipos de notificação registrados (sem o builder). */
  listarTipos() {
    return NOTIFICACAO_TIPOS.map((t) => ({
      id: t.id,
      label: t.label,
      escopo: t.escopo,
      gatilho: t.gatilho,
    }));
  }

  /** PREVIEW do texto de um tipo pra um alvo/data. NÃO envia. */
  async preview(
    tipoId: string,
    alvo: { unidadeId?: string; plantaId?: string; proprietarioId?: string; data?: string },
  ): Promise<{ tipo: string; data: string; texto: string | null; semDados: boolean; erro?: string }> {
    const tipo = getNotificacaoTipo(tipoId);
    const data =
      alvo.data && /^\d{4}-\d{2}-\d{2}$/.test(alvo.data) ? alvo.data : this.hojeBRT();
    if (!tipo) {
      return { tipo: tipoId, data, texto: null, semDados: true, erro: 'Tipo desconhecido' };
    }
    const texto = await tipo.builder({
      prisma: this.prisma,
      unidadeId: alvo.unidadeId ?? null,
      plantaId: alvo.plantaId ?? null,
      proprietarioId: alvo.proprietarioId ?? null,
      data,
    });
    return { tipo: tipoId, data, texto, semDados: texto == null };
  }

  private hojeBRT(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }
}
