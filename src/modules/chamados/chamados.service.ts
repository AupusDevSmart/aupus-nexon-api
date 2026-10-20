import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, PermissionScopeService, ScopedUser } from '@/core';
import { AuditoriaAcessosService } from '@/core/modules/usuarios/auditoria-acessos.service';
import { normalizarPapel } from '@/core/modules/auth/permission-scope.service';
import { novoId26, type ClienteInfo } from '@/core/common/cliente-info';
import {
  DESTINO_ROTULO,
  interpretarBusca,
  podeEncaminhar,
  podeFechar,
  STATUS_ABERTOS,
  validarContato,
  type Destino,
} from './chamados-regras';
import { AbrirChamadoDto, EncaminharChamadoDto, FecharChamadoDto, ListarChamadosDto } from './dto/chamados.dto';

type Usuario = ScopedUser & { nome?: string | null; email?: string | null };

export type AcaoChamado = 'chamado_aberto' | 'chamado_encaminhado' | 'chamado_envio' | 'chamado_fechado';

interface Contexto {
  equipamento: { id: string; nome: string; tag: string | null } | null;
  unidade: { id: string; nome: string } | null;
  planta: { id: string; nome: string } | null;
  proprietario: { id: string; nome: string; email: string | null; telefone: string | null } | null;
}

const t = (v: string | null | undefined) => (v ? v.trim() : null);

@Injectable()
export class ChamadosService {
  private readonly logger = new Logger(ChamadosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scopeService: PermissionScopeService,
    private readonly auditoria: AuditoriaAcessosService,
  ) {}

  // ---------------------------------------------------------------------------
  // Leitura
  // ---------------------------------------------------------------------------

  private async whereEscopo(user?: Usuario): Promise<Prisma.chamadosWhereInput> {
    const where: Prisma.chamadosWhereInput = { deleted_at: null };
    const scope = await this.scopeService.getScope(user);
    if (this.scopeService.isScoped(scope)) where.planta_id = { in: scope.map((p) => p.trim()) };
    return where;
  }

  async listar(q: ListarChamadosDto, user?: Usuario) {
    const page = q.page ?? 1;
    const limit = Math.min(q.limit ?? 20, 100);
    const where = await this.whereEscopo(user);

    if (q.status === 'ABERTOS') where.status = { in: STATUS_ABERTOS };
    else if (q.status) where.status = q.status;
    if (q.planta_id) where.planta_id = { ...(where.planta_id as object), equals: q.planta_id.trim() };
    if (q.unidade_id) where.unidade_id = q.unidade_id.trim();
    if (q.equipamento_id) where.equipamento_id = q.equipamento_id.trim();
    if (q.prioridade) where.prioridade = q.prioridade;

    const { numero, texto } = interpretarBusca(q.busca);
    if (texto) {
      const equipamentos = await this.prisma.equipamentos.findMany({
        where: {
          deleted_at: null,
          OR: [
            { nome: { contains: texto, mode: 'insensitive' } },
            { tag: { contains: texto, mode: 'insensitive' } },
          ],
        },
        select: { id: true },
        take: 200,
      });
      where.OR = [
        ...(numero ? [{ numero }] : []),
        { titulo: { contains: texto, mode: 'insensitive' } },
        { descricao: { contains: texto, mode: 'insensitive' } },
        { autor_nome: { contains: texto, mode: 'insensitive' } },
        ...(equipamentos.length ? [{ equipamento_id: { in: equipamentos.map((e) => e.id.trim()) } }] : []),
      ];
    }

    const [linhas, total] = await Promise.all([
      this.prisma.chamados.findMany({
        where,
        orderBy: [{ created_at: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: { encaminhamentos: { orderBy: { created_at: 'desc' } } },
      }),
      this.prisma.chamados.count({ where }),
    ]);

    const nomes = await this.nomesDosVinculos(linhas);
    return {
      data: linhas.map((c) => this.apresentar(c, nomes)),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  /** Número do menu: chamados não fechados no escopo do usuário. */
  async contagem(user?: Usuario) {
    const where = await this.whereEscopo(user);
    const porStatus = await this.prisma.chamados.groupBy({
      by: ['status'],
      where: { ...where, status: { in: STATUS_ABERTOS } },
      _count: { _all: true },
    });
    const n = (s: string) => porStatus.find((p) => p.status === s)?._count._all ?? 0;
    return { abertos: n('ABERTO') + n('ENCAMINHADO'), aguardando_encaminhamento: n('ABERTO'), encaminhados: n('ENCAMINHADO') };
  }

  async detalhe(id: string, user?: Usuario) {
    const c = await this.buscar(id, user);
    const ctx = await this.contexto(c.equipamento_id, c.planta_id);
    const nomes = await this.nomesDosVinculos([c]);
    return {
      ...this.apresentar(c, nomes),
      contatos_proprietario: ctx.proprietario
        ? { nome: ctx.proprietario.nome, email: ctx.proprietario.email, whatsapp: ctx.proprietario.telefone }
        : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Ações (todas com trilha em auditoria_acessos)
  // ---------------------------------------------------------------------------

  async abrir(dto: AbrirChamadoDto, user?: Usuario, cliente?: ClienteInfo) {
    const equipamentoId = dto.equipamento_id.trim();
    const ctx = await this.contexto(equipamentoId, null);
    if (!ctx.equipamento) throw new NotFoundException('Equipamento não encontrado');
    if (user) await this.scopeService.assertPlantaInScope(ctx.planta?.id ?? null, user);

    const chamado = await this.prisma.chamados.create({
      data: {
        id: novoId26(),
        equipamento_id: equipamentoId,
        unidade_id: ctx.unidade?.id ?? null,
        planta_id: ctx.planta?.id ?? null,
        proprietario_id: ctx.proprietario?.id ?? null,
        titulo: dto.titulo.trim(),
        descricao: dto.descricao.trim(),
        motivo: dto.motivo ?? 'FALHA',
        prioridade: dto.prioridade ?? 'MEDIA',
        canal: dto.canal ?? (cliente?.aparelho ? 'APP' : 'WEB'),
        autor_id: t(user?.id),
        autor_nome: user?.nome ?? null,
      },
      include: { encaminhamentos: true },
    });

    await this.auditar('chamado_aberto', chamado, ctx, user, cliente, {
      mensagem: `Chamado #${chamado.numero} aberto — ${ctx.equipamento.nome}${ctx.planta ? ` (${ctx.planta.nome})` : ''}: ${chamado.titulo}`,
      extra: { descricao: chamado.descricao, canal: chamado.canal },
    });

    return this.apresentar(chamado, this.nomesDoContexto(ctx));
  }

  async encaminhar(id: string, dto: EncaminharChamadoDto, user?: Usuario, cliente?: ClienteInfo) {
    const c = await this.buscar(id, user);
    if (!podeEncaminhar(c.status)) throw new BadRequestException('Chamado fechado não pode ser encaminhado');

    const ctx = await this.contexto(c.equipamento_id, c.planta_id);
    const destino = dto.destino as Destino;
    const padrao =
      destino === 'EMAIL' ? ctx.proprietario?.email : destino === 'WHATSAPP' ? ctx.proprietario?.telefone : null;
    const v = validarContato(destino, dto.contato?.trim() || padrao);
    if ('erro' in v) throw new BadRequestException(v.erro);

    const [enc] = await this.prisma.$transaction([
      this.prisma.chamados_encaminhamentos.create({
        data: {
          id: novoId26(),
          chamado_id: c.id,
          destino,
          contato: v.contato,
          observacao: dto.observacao?.trim() || null,
          status: 'PENDENTE',
          autor_id: t(user?.id),
          autor_nome: user?.nome ?? null,
        },
      }),
      this.prisma.chamados.update({ where: { id: c.id }, data: { status: 'ENCAMINHADO' } }),
    ]);

    await this.auditar('chamado_encaminhado', { ...c, status: 'ENCAMINHADO' }, ctx, user, cliente, {
      mensagem: `Chamado #${c.numero} encaminhado para ${DESTINO_ROTULO[destino]}${v.contato ? ` (${v.contato})` : ''} — ${ctx.equipamento?.nome ?? c.equipamento_id}`,
      extra: {
        encaminhamento: { id: enc.id, destino, contato: v.contato, observacao: enc.observacao },
        contato_do_proprietario: !dto.contato?.trim() && !!padrao,
        status_anterior: c.status,
      },
    });

    return this.detalhe(c.id, user);
  }

  async fechar(id: string, dto: FecharChamadoDto, user?: Usuario, cliente?: ClienteInfo) {
    const c = await this.buscar(id, user);
    if (!podeFechar(c.status)) throw new BadRequestException('Chamado já está fechado');

    const ctx = await this.contexto(c.equipamento_id, c.planta_id);
    const fechado = await this.prisma.chamados.update({
      where: { id: c.id },
      data: {
        status: 'FECHADO',
        fechado_em: new Date(),
        fechado_por_id: t(user?.id),
        fechado_por_nome: user?.nome ?? null,
        motivo_fechamento: dto.motivo.trim(),
      },
      include: { encaminhamentos: true },
    });

    await this.auditar('chamado_fechado', fechado, ctx, user, cliente, {
      mensagem: `Chamado #${c.numero} fechado — ${ctx.equipamento?.nome ?? c.equipamento_id}: ${dto.motivo.trim()}`,
      extra: {
        status_anterior: c.status,
        motivo_fechamento: fechado.motivo_fechamento,
        aberto_ha_horas: Math.round((Date.now() - c.created_at.getTime()) / 36e5),
      },
    });

    return this.detalhe(c.id, user);
  }

  /** Trilha do envio (worker): sucesso ou falha definitiva. Sem usuário: autor é quem encaminhou. */
  async auditarEnvio(
    chamadoId: string,
    enc: { id: string; destino: string; contato: string | null; autor_id: string | null; tentativas: number },
    resultado: { ok: boolean; erro?: string; referencia?: string | null },
  ) {
    const c = await this.prisma.chamados.findUnique({ where: { id: chamadoId } });
    if (!c) return;
    const ctx = await this.contexto(c.equipamento_id, c.planta_id);
    const rotulo = DESTINO_ROTULO[enc.destino as Destino] ?? enc.destino;
    await this.auditar('chamado_envio', c, ctx, enc.autor_id ? { id: enc.autor_id } : undefined, undefined, {
      mensagem: resultado.ok
        ? `Chamado #${c.numero} entregue em ${rotulo}${enc.contato ? ` (${enc.contato})` : ''}`
        : `Chamado #${c.numero} não entregue em ${rotulo}${enc.contato ? ` (${enc.contato})` : ''}: ${resultado.erro ?? 'erro'}`,
      extra: {
        encaminhamento: { id: enc.id, destino: enc.destino, contato: enc.contato, tentativas: enc.tentativas },
        entregue: resultado.ok,
        erro: resultado.erro ?? null,
        referencia_externa: resultado.referencia ?? null,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Apoio
  // ---------------------------------------------------------------------------

  private async buscar(id: string, user?: Usuario) {
    const c = await this.prisma.chamados.findFirst({
      where: { id: id.trim(), deleted_at: null },
      include: { encaminhamentos: { orderBy: { created_at: 'desc' } } },
    });
    if (!c) throw new NotFoundException('Chamado não encontrado');
    if (user) {
      const scope = await this.scopeService.getScope(user);
      if (this.scopeService.isScoped(scope) && !scope.map((p) => p.trim()).includes(c.planta_id ?? '')) {
        throw new ForbiddenException('Recurso fora do escopo do usuario');
      }
    }
    return c;
  }

  /** Equipamento → unidade → planta → proprietário, com ids sem padding. */
  async contexto(equipamentoId: string, plantaIdGravada: string | null): Promise<Contexto> {
    const e = await this.prisma.equipamentos.findFirst({
      where: { id: equipamentoId },
      select: {
        id: true,
        nome: true,
        tag: true,
        planta_id: true,
        unidade: { select: { id: true, nome: true, planta: { select: { id: true, nome: true, proprietario_id: true } } } },
      },
    });
    let planta = e?.unidade?.planta ?? null;
    const plantaId = t(planta?.id) ?? t(e?.planta_id) ?? plantaIdGravada;
    if (!planta && plantaId) {
      planta = await this.prisma.plantas.findFirst({
        where: { id: plantaId },
        select: { id: true, nome: true, proprietario_id: true },
      });
    }
    const proprietario = planta?.proprietario_id
      ? await this.prisma.usuarios.findFirst({
          where: { id: planta.proprietario_id },
          select: { id: true, nome: true, email: true, telefone: true },
        })
      : null;
    return {
      equipamento: e ? { id: e.id.trim(), nome: e.nome, tag: e.tag ?? null } : null,
      unidade: e?.unidade ? { id: e.unidade.id.trim(), nome: e.unidade.nome } : null,
      planta: planta ? { id: planta.id.trim(), nome: planta.nome } : null,
      proprietario: proprietario
        ? { id: proprietario.id.trim(), nome: proprietario.nome, email: proprietario.email, telefone: proprietario.telefone }
        : null,
    };
  }

  private nomesDoContexto(ctx: Contexto) {
    const m = new Map<string, string>();
    if (ctx.equipamento) m.set(`e:${ctx.equipamento.id}`, ctx.equipamento.tag ? `${ctx.equipamento.nome} (${ctx.equipamento.tag})` : ctx.equipamento.nome);
    if (ctx.unidade) m.set(`u:${ctx.unidade.id}`, ctx.unidade.nome);
    if (ctx.planta) m.set(`p:${ctx.planta.id}`, ctx.planta.nome);
    return m;
  }

  private async nomesDosVinculos(
    linhas: Array<{ equipamento_id: string; unidade_id: string | null; planta_id: string | null }>,
  ) {
    const ids = (f: (l: (typeof linhas)[number]) => string | null) =>
      [...new Set(linhas.map(f).filter((x): x is string => !!x))];
    const [eqs, uns, pls] = await Promise.all([
      this.prisma.equipamentos.findMany({ where: { id: { in: ids((l) => l.equipamento_id) } }, select: { id: true, nome: true, tag: true } }),
      this.prisma.unidades.findMany({ where: { id: { in: ids((l) => l.unidade_id) } }, select: { id: true, nome: true } }),
      this.prisma.plantas.findMany({ where: { id: { in: ids((l) => l.planta_id) } }, select: { id: true, nome: true } }),
    ]);
    const m = new Map<string, string>();
    eqs.forEach((e) => m.set(`e:${e.id.trim()}`, e.tag ? `${e.nome} (${e.tag})` : e.nome));
    uns.forEach((u) => m.set(`u:${u.id.trim()}`, u.nome));
    pls.forEach((p) => m.set(`p:${p.id.trim()}`, p.nome));
    return m;
  }

  private apresentar<C extends { equipamento_id: string; unidade_id: string | null; planta_id: string | null }>(
    c: C,
    nomes: Map<string, string>,
  ) {
    return {
      ...c,
      equipamento_nome: nomes.get(`e:${c.equipamento_id}`) ?? null,
      unidade_nome: c.unidade_id ? (nomes.get(`u:${c.unidade_id}`) ?? null) : null,
      planta_nome: c.planta_id ? (nomes.get(`p:${c.planta_id}`) ?? null) : null,
    };
  }

  /**
   * Trilha (auditoria_acessos, acao chamado_*). Mensagem sempre com "Chamado #N", equipamento e
   * planta para a busca; detalhes com ids e nomes. Falha só loga.
   */
  private async auditar(
    acao: AcaoChamado,
    c: { id: string; numero: number; titulo: string; status: string; motivo: string; prioridade: string },
    ctx: Contexto,
    user: Usuario | undefined,
    cliente: ClienteInfo | undefined,
    o: { mensagem: string; extra?: Record<string, unknown> },
  ) {
    try {
      await this.auditoria.registrar({
        autorId: user?.id ?? null,
        alvoUsuarioId: ctx.proprietario?.id ?? null,
        acao,
        mensagem: o.mensagem,
        plantaIds: ctx.planta ? [ctx.planta.id] : [],
        unidadeIds: ctx.unidade ? [ctx.unidade.id] : [],
        dispositivo: cliente?.dispositivo ?? null,
        detalhes: {
          usuario: user
            ? {
                id: t(user.id),
                nome: user.nome ?? null,
                email: user.email ?? null,
                papel: user.role ? normalizarPapel(user.role) : null,
              }
            : null,
          chamado: { id: c.id, numero: c.numero, titulo: c.titulo, status: c.status, motivo: c.motivo, prioridade: c.prioridade },
          equipamento: ctx.equipamento,
          unidade: ctx.unidade,
          planta: ctx.planta,
          proprietario: ctx.proprietario ? { id: ctx.proprietario.id, nome: ctx.proprietario.nome } : null,
          ...(o.extra ?? {}),
          ip: cliente?.ip ?? null,
          user_agent: cliente?.userAgent ?? null,
        },
      });
    } catch (e) {
      this.logger.warn(`[auditoria] ${acao} não registrado (${c.id}): ${(e as Error).message}`);
    }
  }
}
