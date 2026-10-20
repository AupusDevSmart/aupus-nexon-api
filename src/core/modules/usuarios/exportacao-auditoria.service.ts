import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { ClienteInfo } from '../../common/cliente-info';
import { AuditoriaAcessosService } from './auditoria-acessos.service';
import { normalizarPapel } from '../auth/permission-scope.service';

/** O que foi exportado. Vai em detalhes.tipo e serve de filtro na busca. */
export type TipoExportacao =
  | 'leituras' // GET /equipamentos/:id/dados/historico
  | 'telemetria_atual' // GET /equipamentos/:id/dados/atual (só negada)
  | 'anexo_equipamento' // download de anexo do equipamento
  | 'anexo_unidade' // download de anexo da unidade
  | 'lista_anexos' // listagem de anexos (só negada)
  | 'carregador' // export mensal do carregador elétrico
  | 'boletim_semanal' // relatório de geração (boletim semanal)
  | 'consumo' // relatório de consumo
  | 'geracao' // histórico de geração da unidade (só negada)
  | 'relatorio_operacao'; // relatórios de operação dos equipamentos (NEXON-33)

export const ROTULO_EXPORTACAO: Record<TipoExportacao, string> = {
  leituras: 'leituras do equipamento',
  telemetria_atual: 'telemetria atual do equipamento',
  anexo_equipamento: 'anexo do equipamento',
  anexo_unidade: 'anexo da unidade',
  lista_anexos: 'lista de anexos',
  carregador: 'carregador elétrico (mensal)',
  boletim_semanal: 'boletim semanal de geração',
  consumo: 'relatório de consumo',
  geracao: 'histórico de geração',
  relatorio_operacao: 'relatório de operação',
};

export interface UsuarioExportacao {
  id?: string | null;
  nome?: string | null;
  email?: string | null;
  role?: string | null;
}

export interface ContextoExportacao {
  user?: UsuarioExportacao | null;
  cliente?: ClienteInfo | null;
  tipo: TipoExportacao;
  equipamentoIds?: Array<string | null | undefined>;
  unidadeIds?: Array<string | null | undefined>;
  plantaIds?: Array<string | null | undefined>;
  /** Anexo pedido: o dono (equipamento/unidade) e o nome do arquivo são lidos do banco. */
  anexo?: { tipo: 'equipamento' | 'unidade'; id: string } | null;
  periodo?: Record<string, string | number | null | undefined> | null;
  formato?: string | null;
  linhas?: number | null;
  /** 'sessao' (usuário logado) ou 'link_assinado' (PDF público por token). */
  via?: 'sessao' | 'link_assinado';
  extra?: Record<string, unknown>;
}

const limpar = (ids?: Array<string | null | undefined>): string[] =>
  Array.from(new Set((ids ?? []).map((x) => (x ?? '').trim()).filter(Boolean)));

/**
 * Trilha das EXPORTAÇÕES de dados (leituras, anexos, carregador, boletins).
 * Grava em auditoria_acessos com acao 'exportacao' ou 'exportacao_negada', autor =
 * quem exportou, planta_ids/unidade_ids preenchidos (a trilha de acesso já filtra por
 * planta) e em `detalhes` tudo o que serve para busca: usuário (id, nome, papel),
 * tipo, equipamentos/unidades/plantas com nome, período, formato, linhas, IP e
 * user-agent. Falha ao gravar só loga — nunca derruba o export.
 */
@Injectable()
export class ExportacaoAuditoriaService {
  private readonly logger = new Logger(ExportacaoAuditoriaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaAcessosService,
  ) {}

  /**
   * Roda `fn` (que valida o escopo e/ou gera o export). ForbiddenException vira
   * `exportacao_negada` e é relançada; sucesso vira `exportacao` (a não ser que
   * `registrarSucesso: false`, para rotas de tela que só auditam a recusa).
   */
  async executar<T>(
    ctx: ContextoExportacao,
    fn: () => Promise<T>,
    opts: { registrarSucesso?: boolean; resumo?: (r: T) => Partial<ContextoExportacao> } = {},
  ): Promise<T> {
    let resultado: T;
    try {
      resultado = await fn();
    } catch (e) {
      if (e instanceof ForbiddenException) {
        await this.negada(ctx, (e as Error).message);
      }
      throw e;
    }
    if (opts.registrarSucesso !== false) {
      let extra: Partial<ContextoExportacao> = {};
      try {
        extra = opts.resumo ? opts.resumo(resultado) : {};
      } catch {
        extra = {};
      }
      await this.registrar({ ...ctx, ...extra, extra: { ...(ctx.extra ?? {}), ...(extra.extra ?? {}) } });
    }
    return resultado;
  }

  async registrar(ctx: ContextoExportacao): Promise<void> {
    await this.gravar(ctx, 'exportacao');
  }

  async negada(ctx: ContextoExportacao, motivo?: string): Promise<void> {
    await this.gravar({ ...ctx, extra: { ...(ctx.extra ?? {}), motivo: motivo ?? 'fora do escopo' } }, 'exportacao_negada');
  }

  private async gravar(ctx: ContextoExportacao, acao: 'exportacao' | 'exportacao_negada'): Promise<void> {
    try {
      const nomes = await this.resolverNomes(ctx);
      const rotulo = ROTULO_EXPORTACAO[ctx.tipo] ?? ctx.tipo;
      const alvo =
        nomes.equipamentos.map((e) => e.nome).join(', ') ||
        nomes.unidades.map((u) => u.nome).join(', ') ||
        nomes.plantas.map((p) => p.nome).join(', ');
      const mensagem = `${acao === 'exportacao' ? 'Exportação' : 'Exportação negada'}: ${rotulo}${alvo ? ` — ${alvo}` : ''}`;

      const user = ctx.user ?? null;
      await this.auditoria.registrar({
        autorId: user?.id ?? null,
        alvoUsuarioId: null,
        acao,
        mensagem,
        plantaIds: nomes.plantas.map((p) => p.id),
        unidadeIds: nomes.unidades.map((u) => u.id),
        dispositivo: ctx.cliente?.dispositivo ?? null,
        detalhes: {
          tipo: ctx.tipo,
          via: ctx.via ?? (user?.id ? 'sessao' : 'link_assinado'),
          usuario: user
            ? {
                id: user.id?.trim() ?? null,
                nome: user.nome ?? null,
                email: user.email ?? null,
                papel: user.role ? normalizarPapel(user.role) : null,
              }
            : null,
          equipamentos: nomes.equipamentos,
          unidades: nomes.unidades,
          plantas: nomes.plantas,
          periodo: ctx.periodo ?? null,
          formato: ctx.formato ?? null,
          linhas: ctx.linhas ?? null,
          // ip = socket/req.ip (proxy confiável); xff só como pista, nunca verdade.
          ip: ctx.cliente?.ip ?? null,
          ip_socket: ctx.cliente?.ipSocket ?? null,
          xff: ctx.cliente?.xff ?? null,
          user_agent: ctx.cliente?.userAgent ?? null,
          ...(nomes.anexo ? { anexo_id: nomes.anexo.id, arquivo: nomes.anexo.arquivo } : {}),
          ...(ctx.extra ?? {}),
        },
      });
    } catch (e) {
      this.logger.warn(`[auditoria] exportação não registrada (${ctx.tipo}): ${(e as Error).message}`);
    }
  }

  /** Busca nome e planta de cada id citado (equipamento → unidade → planta). */
  private async resolverNomes(ctx: ContextoExportacao) {
    const equipIds = limpar(ctx.equipamentoIds);
    const unidadeIds = limpar(ctx.unidadeIds);

    let anexo: { id: string; arquivo: string | null } | null = null;
    const anexoId = ctx.anexo?.id?.trim();
    if (anexoId) {
      if (ctx.anexo!.tipo === 'equipamento') {
        const a = await this.prisma.anexos_equipamentos.findFirst({
          where: { id: anexoId },
          select: { equipamento_id: true, nome_original: true },
        });
        if (a?.equipamento_id && !equipIds.includes(a.equipamento_id.trim())) equipIds.push(a.equipamento_id.trim());
        anexo = { id: anexoId, arquivo: a?.nome_original ?? null };
      } else {
        const a = await this.prisma.anexos_unidades.findFirst({
          where: { id: anexoId },
          select: { unidade_id: true, nome_original: true },
        });
        if (a?.unidade_id) unidadeIds.push(a.unidade_id.trim());
        anexo = { id: anexoId, arquivo: a?.nome_original ?? null };
      }
    }
    const plantaIds = limpar(ctx.plantaIds);

    const equipamentos: Array<{ id: string; nome: string | null }> = [];
    if (equipIds.length) {
      const rows = await this.prisma.equipamentos.findMany({
        where: { id: { in: equipIds } },
        select: { id: true, nome: true, planta_id: true, unidade_id: true, unidade: { select: { planta_id: true } } },
      });
      for (const id of equipIds) {
        const r = rows.find((x) => x.id.trim() === id);
        equipamentos.push({ id, nome: r?.nome ?? null });
        if (r?.unidade_id) unidadeIds.push(r.unidade_id.trim());
        const pid = r?.planta_id?.trim() || r?.unidade?.planta_id?.trim();
        if (pid) plantaIds.push(pid);
      }
    }

    const unidades: Array<{ id: string; nome: string | null }> = [];
    const uIds = limpar(unidadeIds);
    if (uIds.length) {
      const rows = await this.prisma.unidades.findMany({
        where: { id: { in: uIds } },
        select: { id: true, nome: true, planta_id: true },
      });
      for (const id of uIds) {
        const r = rows.find((x) => x.id.trim() === id);
        unidades.push({ id, nome: r?.nome ?? null });
        if (r?.planta_id) plantaIds.push(r.planta_id.trim());
      }
    }

    const plantas: Array<{ id: string; nome: string | null }> = [];
    const pIds = limpar(plantaIds);
    if (pIds.length) {
      const rows = await this.prisma.plantas.findMany({
        where: { id: { in: pIds } },
        select: { id: true, nome: true },
      });
      for (const id of pIds) {
        plantas.push({ id, nome: rows.find((x) => x.id.trim() === id)?.nome ?? null });
      }
    }

    return { equipamentos, unidades, plantas, anexo };
  }
}
