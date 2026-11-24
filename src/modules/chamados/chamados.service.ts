import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, PermissionScopeService, ScopedUser } from '@/core';
import { AuditoriaAcessosService } from '@/core/modules/usuarios/auditoria-acessos.service';
import { isPapelSemEscopo, normalizarPapel } from '@/core/modules/auth/permission-scope.service';
import { novoId26, type ClienteInfo } from '@/core/common/cliente-info';
import {
  agregarEstatisticas,
  DESTINO_ROTULO,
  duracaoHoras,
  estaAberto,
  interpretarBusca,
  MOTIVO_ROTULO,
  motivoValido,
  podeEncaminhar,
  podeFechar,
  podeMudarStatus,
  STATUS_ABERTOS,
  STATUS_ENCERRADOS,
  STATUS_ROTULO,
  validarContato,
  type Destino,
  type Motivo,
  type StatusChamado,
  type Tipo,
} from './chamados-regras';
import {
  AbrirChamadoDto,
  AdicionarNotaDto,
  EditarChamadoDto,
  EncaminharChamadoDto,
  ExcluirChamadoDto,
  FecharChamadoDto,
  ListarChamadosDto,
  MudarStatusDto,
} from './dto/chamados.dto';

type Usuario = ScopedUser & { nome?: string | null; email?: string | null };

export type AcaoChamado =
  | 'chamado_aberto'
  | 'chamado_encaminhado'
  | 'chamado_envio'
  | 'chamado_fechado'
  | 'chamado_editado'
  | 'chamado_status'
  | 'chamado_nota'
  | 'chamado_excluido';

interface Contexto {
  equipamento: { id: string; nome: string; tag: string | null } | null;
  unidade: { id: string; nome: string } | null;
  planta: { id: string; nome: string } | null;
  proprietario: { id: string; nome: string; email: string | null; telefone: string | null } | null;
}

type ChamadoRow = Prisma.chamadosGetPayload<{ include: { encaminhamentos: true } }>;

const t = (v: string | null | undefined) => (v ? v.trim() : null);

/** Sem usuário = ação do próprio NexON (ex.: falta de energia detectada pela TON, NEXON-145). */
export const AUTOR_SISTEMA = 'NexON (automático)';
const nomeAutor = (user?: { nome?: string | null }) => (user ? (user.nome ?? null) : AUTOR_SISTEMA);
const data = (v: string | null | undefined) => (v ? new Date(v) : null);

/** Campos que a edição compara e grava na trilha (antes → depois). */
const CAMPOS_EDITAVEIS = [
  'titulo',
  'descricao',
  'motivo',
  'prioridade',
  'orgao',
  'protocolo',
  'ocorrencia_em',
  'aberto_em',
  'previsao_em',
  'equipamento_id',
  'unidade_id',
  'planta_id',
] as const;

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
    // Operador: só chamados dos equipamentos liberados (NEXON-20, PER-23) e os externos sem
    // equipamento das instalações desses equipamentos.
    const eqs = await this.scopeService.getEquipamentosScope(user);
    if (eqs) {
      const uns = (await this.scopeService.getUnidadesScope(user)) ?? [];
      where.AND = [
        {
          OR: [
            { equipamento_id: { in: eqs } },
            ...(uns.length ? [{ tipo: 'EXTERNO', equipamento_id: null, unidade_id: { in: uns } }] : []),
          ],
        },
      ];
    }
    return where;
  }

  /** Filtros da tela (lista e estatísticas usam os mesmos). */
  private async aplicarFiltros(where: Prisma.chamadosWhereInput, q: ListarChamadosDto) {
    if (q.status === 'ABERTOS') where.status = { in: STATUS_ABERTOS };
    else if (q.status === 'ENCERRADOS') where.status = { in: STATUS_ENCERRADOS };
    else if (q.status) where.status = q.status;
    if (q.tipo) where.tipo = q.tipo;
    if (q.motivo) where.motivo = q.motivo;
    if (q.orgao?.trim()) where.orgao = { equals: q.orgao.trim(), mode: 'insensitive' };
    if (q.planta_id) where.planta_id = { ...(where.planta_id as object), equals: q.planta_id.trim() };
    if (q.unidade_id) where.unidade_id = q.unidade_id.trim();
    if (q.equipamento_id) where.equipamento_id = q.equipamento_id.trim();
    if (q.prioridade) where.prioridade = q.prioridade;

    const filtros: Prisma.chamadosWhereInput[] = [];
    if (q.de || q.ate) {
      // Período pela data de início do chamado (ocorrência, abertura no órgão ou cadastro).
      const de = q.de ? new Date(`${q.de.slice(0, 10)}T00:00:00-03:00`) : undefined;
      const ate = q.ate ? new Date(`${q.ate.slice(0, 10)}T23:59:59-03:00`) : undefined;
      const faixa = { ...(de ? { gte: de } : {}), ...(ate ? { lte: ate } : {}) };
      filtros.push({
        OR: [
          { ocorrencia_em: faixa },
          { ocorrencia_em: null, aberto_em: faixa },
          { ocorrencia_em: null, aberto_em: null, created_at: faixa },
        ],
      });
    }

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
      filtros.push({
        OR: [
          ...(numero ? [{ numero }] : []),
          { titulo: { contains: texto, mode: 'insensitive' } },
          { descricao: { contains: texto, mode: 'insensitive' } },
          { autor_nome: { contains: texto, mode: 'insensitive' } },
          { protocolo: { contains: texto, mode: 'insensitive' } },
          { orgao: { contains: texto, mode: 'insensitive' } },
          ...(equipamentos.length ? [{ equipamento_id: { in: equipamentos.map((e) => e.id.trim()) } }] : []),
        ],
      });
    }
    if (filtros.length) where.AND = [...((where.AND as Prisma.chamadosWhereInput[]) ?? []), ...filtros];
    return where;
  }

  async listar(q: ListarChamadosDto, user?: Usuario) {
    const page = q.page ?? 1;
    const limit = Math.min(q.limit ?? 20, 100);
    const where = await this.aplicarFiltros(await this.whereEscopo(user), q);

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

  /** Número do menu: chamados não encerrados no escopo do usuário. */
  async contagem(user?: Usuario) {
    const where = await this.whereEscopo(user);
    const porStatus = await this.prisma.chamados.groupBy({
      by: ['status', 'tipo'],
      where: { ...where, status: { in: STATUS_ABERTOS } },
      _count: { _all: true },
    });
    const n = (f: (p: (typeof porStatus)[number]) => boolean) =>
      porStatus.filter(f).reduce((s, p) => s + p._count._all, 0);
    return {
      abertos: n(() => true),
      aguardando_encaminhamento: n((p) => p.tipo !== 'EXTERNO' && p.status === 'ABERTO'),
      encaminhados: n((p) => p.status === 'ENCAMINHADO'),
      externos_abertos: n((p) => p.tipo === 'EXTERNO'),
    };
  }

  /**
   * Indicadores e gráficos da página: mesmos filtros da lista, sem paginação. Sem período,
   * olha os últimos 12 meses mais tudo que ainda está aberto.
   */
  async estatisticas(q: ListarChamadosDto, user?: Usuario) {
    const where = await this.aplicarFiltros(await this.whereEscopo(user), q);
    if (!q.de && !q.ate) {
      const desde = new Date();
      desde.setMonth(desde.getMonth() - 12);
      where.AND = [
        ...((where.AND as Prisma.chamadosWhereInput[]) ?? []),
        { OR: [{ created_at: { gte: desde } }, { status: { in: STATUS_ABERTOS } }] },
      ];
    }
    const linhas = await this.prisma.chamados.findMany({
      where,
      select: {
        tipo: true,
        status: true,
        motivo: true,
        orgao: true,
        planta_id: true,
        unidade_id: true,
        equipamento_id: true,
        ocorrencia_em: true,
        aberto_em: true,
        previsao_em: true,
        fechado_em: true,
        created_at: true,
      },
      take: 20000,
    });
    const r = agregarEstatisticas(linhas);
    const nomes = await this.nomesDosVinculos(linhas);
    return {
      ...r,
      por_status: r.por_status.map((x) => ({ ...x, rotulo: STATUS_ROTULO[x.chave as StatusChamado] ?? x.chave })),
      por_motivo: r.por_motivo.map((x) => ({ ...x, rotulo: MOTIVO_ROTULO[x.chave as Motivo] ?? x.chave })),
      por_orgao: r.por_orgao.map((x) => ({ ...x, rotulo: x.chave === '—' ? 'Sem órgão' : x.chave })),
      por_planta: r.por_planta.map((x) => ({ ...x, rotulo: nomes.get(`p:${x.chave}`) ?? x.chave })),
      por_equipamento: r.por_equipamento.map((x) => ({ ...x, rotulo: nomes.get(`e:${x.chave}`) ?? x.chave })),
    };
  }

  /** Órgãos já usados no escopo (sugestão do campo, com Equatorial sempre presente). */
  async orgaos(user?: Usuario) {
    const where = await this.whereEscopo(user);
    const linhas = await this.prisma.chamados.groupBy({
      by: ['orgao'],
      where: { ...where, tipo: 'EXTERNO', orgao: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { orgao: 'desc' } },
      take: 30,
    });
    const nomes = linhas.map((l) => l.orgao!.trim()).filter(Boolean);
    return [...new Set(['Equatorial', ...nomes])];
  }

  async detalhe(id: string, user?: Usuario) {
    const c = await this.buscar(id, user);
    const ctx = await this.contexto(c.equipamento_id, c.planta_id, c.unidade_id);
    const nomes = await this.nomesDosVinculos([c]);
    const atualizacoes = await this.prisma.chamados_atualizacoes.findMany({
      where: { chamado_id: c.id },
      orderBy: { created_at: 'desc' },
      take: 200,
    });
    return {
      ...this.apresentar(c, nomes),
      atualizacoes,
      contatos_proprietario: ctx.proprietario
        ? { nome: ctx.proprietario.nome, email: ctx.proprietario.email, whatsapp: ctx.proprietario.telefone }
        : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Ações (todas com trilha em auditoria_acessos)
  // ---------------------------------------------------------------------------

  async abrir(dto: AbrirChamadoDto, user?: Usuario, cliente?: ClienteInfo) {
    const tipo: Tipo = dto.tipo ?? 'INTERNO';
    const equipamentoId = t(dto.equipamento_id);
    if (tipo === 'INTERNO' && !equipamentoId) throw new BadRequestException('Escolha o equipamento do chamado');

    const ctx = await this.resolverVinculo(tipo, equipamentoId, t(dto.unidade_id), t(dto.planta_id), user);
    const motivo = dto.motivo ?? (tipo === 'EXTERNO' ? 'FALTA_ENERGIA' : 'FALHA');
    if (!motivoValido(tipo, motivo)) throw new BadRequestException(`Motivo ${motivo} não vale para este tipo de chamado`);
    if (tipo === 'EXTERNO' && !dto.orgao?.trim()) throw new BadRequestException('Informe com quem o chamado foi aberto (ex.: Equatorial)');

    const chamado = await this.prisma.chamados.create({
      data: {
        id: novoId26(),
        tipo,
        equipamento_id: ctx.equipamento?.id ?? null,
        unidade_id: ctx.unidade?.id ?? null,
        planta_id: ctx.planta?.id ?? null,
        proprietario_id: ctx.proprietario?.id ?? null,
        titulo: dto.titulo.trim(),
        descricao: dto.descricao.trim(),
        motivo,
        prioridade: dto.prioridade ?? 'MEDIA',
        canal: dto.canal ?? (cliente?.aparelho ? 'APP' : 'WEB'),
        autor_id: t(user?.id),
        autor_nome: nomeAutor(user),
        ...(tipo === 'EXTERNO'
          ? {
              orgao: dto.orgao!.trim(),
              protocolo: t(dto.protocolo) || null,
              ocorrencia_em: data(dto.ocorrencia_em),
              aberto_em: data(dto.aberto_em) ?? new Date(),
              previsao_em: data(dto.previsao_em),
            }
          : {}),
      },
      include: { encaminhamentos: true },
    });

    await this.auditar('chamado_aberto', chamado, ctx, user, cliente, {
      mensagem: `${this.rotulo(chamado)} aberto — ${this.local(ctx)}: ${chamado.titulo}`,
      extra: { descricao: chamado.descricao, canal: chamado.canal },
    });

    return this.apresentar(chamado, this.nomesDoContexto(ctx));
  }

  async editar(id: string, dto: EditarChamadoDto, user?: Usuario, cliente?: ClienteInfo) {
    const c = await this.buscar(id, user);
    if (c.tipo !== 'EXTERNO' && !estaAberto(c.status)) throw new BadRequestException('Chamado fechado não pode ser editado');

    const novo: Record<string, unknown> = {};
    if (dto.titulo !== undefined) novo.titulo = dto.titulo.trim();
    if (dto.descricao !== undefined) novo.descricao = dto.descricao.trim();
    if (dto.prioridade !== undefined) novo.prioridade = dto.prioridade;
    if (dto.motivo !== undefined) {
      if (!motivoValido(c.tipo as Tipo, dto.motivo)) throw new BadRequestException(`Motivo ${dto.motivo} não vale para este tipo de chamado`);
      novo.motivo = dto.motivo;
    }
    if (c.tipo === 'EXTERNO') {
      if (dto.orgao !== undefined) {
        if (!dto.orgao.trim()) throw new BadRequestException('Informe com quem o chamado foi aberto');
        novo.orgao = dto.orgao.trim();
      }
      if (dto.protocolo !== undefined) novo.protocolo = dto.protocolo.trim() || null;
      if (dto.ocorrencia_em !== undefined) novo.ocorrencia_em = data(dto.ocorrencia_em);
      if (dto.aberto_em !== undefined) novo.aberto_em = data(dto.aberto_em);
      if (dto.previsao_em !== undefined) novo.previsao_em = data(dto.previsao_em);
    }

    // Vínculo: no interno só troca de equipamento; no externo equipamento, unidade ou planta.
    let ctx = await this.contexto(c.equipamento_id, c.planta_id, c.unidade_id);
    const mexeVinculo = dto.equipamento_id !== undefined || dto.unidade_id !== undefined || dto.planta_id !== undefined;
    if (mexeVinculo) {
      const eq = dto.equipamento_id === undefined ? c.equipamento_id : t(dto.equipamento_id);
      if (c.tipo !== 'EXTERNO' && !eq) throw new BadRequestException('Chamado de reparo precisa de equipamento');
      const un = dto.unidade_id === undefined ? (dto.equipamento_id !== undefined ? null : c.unidade_id) : t(dto.unidade_id);
      const pl = dto.planta_id === undefined ? (eq || un ? null : c.planta_id) : t(dto.planta_id);
      ctx = await this.resolverVinculo(c.tipo as Tipo, eq, un, pl, user);
      novo.equipamento_id = ctx.equipamento?.id ?? null;
      novo.unidade_id = ctx.unidade?.id ?? null;
      novo.planta_id = ctx.planta?.id ?? null;
      novo.proprietario_id = ctx.proprietario?.id ?? null;
    }

    const alteracoes = diffCampos(c as unknown as Record<string, unknown>, novo);
    if (!alteracoes.length) return this.detalhe(c.id, user);

    const resumo = alteracoes.map((a) => ROTULO_CAMPO[a.campo] ?? a.campo).join(', ');
    const [atualizado] = await this.prisma.$transaction([
      this.prisma.chamados.update({ where: { id: c.id }, data: novo, include: { encaminhamentos: true } }),
      this.prisma.chamados_atualizacoes.create({
        data: {
          id: novoId26(),
          chamado_id: c.id,
          tipo: 'EDICAO',
          texto: `Alterado: ${resumo}`.slice(0, 2000),
          autor_id: t(user?.id),
          autor_nome: nomeAutor(user),
        },
      }),
    ]);

    await this.auditar('chamado_editado', atualizado, ctx, user, cliente, {
      mensagem: `${this.rotulo(atualizado)} editado (${resumo}) — ${this.local(ctx)}`,
      extra: { alteracoes },
    });
    return this.detalhe(c.id, user);
  }

  /** Troca de status do EXTERNO, com nota opcional na linha do tempo. */
  async mudarStatus(id: string, dto: MudarStatusDto, user?: Usuario, cliente?: ClienteInfo) {
    const c = await this.buscar(id, user);
    const v = podeMudarStatus(c.tipo, c.status, dto.status);
    if ('erro' in v) throw new BadRequestException(v.erro);

    const encerra = dto.status === 'RESOLVIDO' || dto.status === 'CANCELADO';
    const quando = data(dto.quando) ?? new Date();
    if (encerra && quando.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException('A data de resolução não pode ser no futuro');
    const texto = dto.texto?.trim() || null;

    const [atualizado] = await this.prisma.$transaction([
      this.prisma.chamados.update({
        where: { id: c.id },
        data: encerra
          ? {
              status: dto.status,
              fechado_em: quando,
              fechado_por_id: t(user?.id),
              fechado_por_nome: nomeAutor(user),
              motivo_fechamento: texto?.slice(0, 500) ?? null,
            }
          : { status: dto.status, fechado_em: null, fechado_por_id: null, fechado_por_nome: null, motivo_fechamento: null },
        include: { encaminhamentos: true },
      }),
      this.prisma.chamados_atualizacoes.create({
        data: {
          id: novoId26(),
          chamado_id: c.id,
          tipo: 'STATUS',
          status_anterior: c.status,
          status_novo: dto.status,
          texto,
          autor_id: t(user?.id),
          autor_nome: nomeAutor(user),
        },
      }),
    ]);

    const ctx = await this.contexto(c.equipamento_id, c.planta_id, c.unidade_id);
    const de = STATUS_ROTULO[c.status as StatusChamado] ?? c.status;
    const para = STATUS_ROTULO[dto.status];
    await this.auditar('chamado_status', atualizado, ctx, user, cliente, {
      mensagem: `${this.rotulo(atualizado)}: ${de} → ${para} — ${this.local(ctx)}${texto ? `: ${texto}` : ''}`,
      extra: {
        status_anterior: c.status,
        status_novo: dto.status,
        texto,
        ...(encerra ? { encerrado_em: quando.toISOString(), duracao_horas: Math.round(duracaoHoras({ ...c, fechado_em: quando }) * 10) / 10 } : {}),
      },
    });
    return this.detalhe(c.id, user);
  }

  async adicionarNota(id: string, dto: AdicionarNotaDto, user?: Usuario, cliente?: ClienteInfo) {
    const c = await this.buscar(id, user);
    const texto = dto.texto.trim();
    await this.prisma.$transaction([
      this.prisma.chamados_atualizacoes.create({
        data: { id: novoId26(), chamado_id: c.id, tipo: 'NOTA', texto, autor_id: t(user?.id), autor_nome: nomeAutor(user) },
      }),
      this.prisma.chamados.update({ where: { id: c.id }, data: { updated_at: new Date() } }),
    ]);
    const ctx = await this.contexto(c.equipamento_id, c.planta_id, c.unidade_id);
    await this.auditar('chamado_nota', c, ctx, user, cliente, {
      mensagem: `${this.rotulo(c)} — nota: ${texto}`,
      extra: { texto },
    });
    return this.detalhe(c.id, user);
  }

  /** Exclusão lógica (cadastro errado). Só quem abriu ou papel administrativo. */
  async excluir(id: string, dto: ExcluirChamadoDto, user?: Usuario, cliente?: ClienteInfo) {
    const c = await this.buscar(id, user);
    const autor = t(user?.id) && t(user?.id) === t(c.autor_id);
    if (user && !autor && !isPapelSemEscopo(user.role)) {
      throw new ForbiddenException('Só quem abriu o chamado ou um administrador pode excluir');
    }
    await this.prisma.chamados.update({ where: { id: c.id }, data: { deleted_at: new Date() } });
    const ctx = await this.contexto(c.equipamento_id, c.planta_id, c.unidade_id);
    await this.auditar('chamado_excluido', c, ctx, user, cliente, {
      mensagem: `${this.rotulo(c)} excluído — ${this.local(ctx)}: ${dto.motivo.trim()}`,
      extra: { motivo_exclusao: dto.motivo.trim(), descricao: c.descricao, autor_original: c.autor_nome },
    });
    return { ok: true };
  }

  async encaminhar(id: string, dto: EncaminharChamadoDto, user?: Usuario, cliente?: ClienteInfo) {
    const c = await this.buscar(id, user);
    if (c.tipo === 'EXTERNO') throw new BadRequestException('Chamado externo não é encaminhado: atualize o status');
    if (!podeEncaminhar(c.status)) throw new BadRequestException('Chamado fechado não pode ser encaminhado');

    const ctx = await this.contexto(c.equipamento_id, c.planta_id, c.unidade_id);
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
          autor_nome: nomeAutor(user),
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
    if (c.tipo === 'EXTERNO') throw new BadRequestException('Chamado externo é encerrado pelo status (Resolvido ou Cancelado)');
    if (!podeFechar(c.status)) throw new BadRequestException('Chamado já está fechado');

    const ctx = await this.contexto(c.equipamento_id, c.planta_id, c.unidade_id);
    const fechado = await this.prisma.chamados.update({
      where: { id: c.id },
      data: {
        status: 'FECHADO',
        fechado_em: new Date(),
        fechado_por_id: t(user?.id),
        fechado_por_nome: nomeAutor(user),
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
    const ctx = await this.contexto(c.equipamento_id, c.planta_id, c.unidade_id);
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

  private async buscar(id: string, user?: Usuario): Promise<ChamadoRow> {
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
      if (c.equipamento_id) await this.scopeService.assertEquipamentoLiberado(c.equipamento_id, user);
      else await this.assertUnidadeLiberada(c.unidade_id, user);
    }
    return c;
  }

  /** Operador: externo sem equipamento só se a instalação tiver equipamento liberado para ele. */
  private async assertUnidadeLiberada(unidadeId: string | null, user?: Usuario) {
    const uns = await this.scopeService.getUnidadesScope(user);
    if (!uns) return;
    if (!unidadeId || !uns.includes(unidadeId.trim())) throw new ForbiddenException('Recurso fora do escopo do usuario');
  }

  /**
   * Vínculo do chamado. Interno: equipamento. Externo: equipamento, ou unidade, ou planta
   * (o mais específico informado). Confere escopo antes de gravar.
   */
  private async resolverVinculo(
    tipo: Tipo,
    equipamentoId: string | null,
    unidadeId: string | null,
    plantaId: string | null,
    user?: Usuario,
  ): Promise<Contexto> {
    let ctx: Contexto;
    if (equipamentoId) {
      ctx = await this.contexto(equipamentoId, null, null);
      if (!ctx.equipamento) throw new NotFoundException('Equipamento não encontrado');
      await this.scopeService.assertEquipamentoLiberado(equipamentoId, user);
    } else {
      if (tipo === 'INTERNO') throw new BadRequestException('Escolha o equipamento do chamado');
      if (unidadeId) {
        const u = await this.prisma.unidades.findFirst({ where: { id: unidadeId, deleted_at: null }, select: { id: true, planta_id: true } });
        if (!u) throw new NotFoundException('Instalação não encontrada');
        if (plantaId && t(u.planta_id) !== plantaId) throw new BadRequestException('A instalação não é desta planta');
        ctx = await this.contexto(null, t(u.planta_id), u.id.trim());
      } else if (plantaId) {
        ctx = await this.contexto(null, plantaId, null);
      } else {
        throw new BadRequestException('Escolha a planta do chamado');
      }
      if (!ctx.planta) throw new NotFoundException('Planta não encontrada');
      await this.assertUnidadeLiberada(ctx.unidade?.id ?? null, user);
    }
    if (user) await this.scopeService.assertPlantaInScope(ctx.planta?.id ?? null, user);
    if (!ctx.planta) throw new BadRequestException('O equipamento não está ligado a nenhuma planta');
    return ctx;
  }

  /** Equipamento → unidade → planta → proprietário, com ids sem padding. */
  async contexto(equipamentoId: string | null, plantaIdGravada: string | null, unidadeIdGravada: string | null = null): Promise<Contexto> {
    const e = equipamentoId
      ? await this.prisma.equipamentos.findFirst({
          where: { id: equipamentoId },
          select: {
            id: true,
            nome: true,
            tag: true,
            planta_id: true,
            unidade: { select: { id: true, nome: true, planta: { select: { id: true, nome: true, proprietario_id: true } } } },
          },
        })
      : null;
    const unidadeSolta =
      !e?.unidade && unidadeIdGravada
        ? await this.prisma.unidades.findFirst({ where: { id: unidadeIdGravada }, select: { id: true, nome: true, planta_id: true } })
        : null;
    let planta = e?.unidade?.planta ?? null;
    const plantaId = t(planta?.id) ?? t(e?.planta_id) ?? t(unidadeSolta?.planta_id) ?? plantaIdGravada;
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
    const unidade = e?.unidade ?? unidadeSolta;
    return {
      equipamento: e ? { id: e.id.trim(), nome: e.nome, tag: e.tag ?? null } : null,
      unidade: unidade ? { id: unidade.id.trim(), nome: unidade.nome } : null,
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
    linhas: Array<{ equipamento_id: string | null; unidade_id: string | null; planta_id: string | null }>,
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

  private apresentar<C extends { equipamento_id: string | null; unidade_id: string | null; planta_id: string | null }>(
    c: C,
    nomes: Map<string, string>,
  ) {
    return {
      ...c,
      equipamento_nome: c.equipamento_id ? (nomes.get(`e:${c.equipamento_id}`) ?? null) : null,
      unidade_nome: c.unidade_id ? (nomes.get(`u:${c.unidade_id}`) ?? null) : null,
      planta_nome: c.planta_id ? (nomes.get(`p:${c.planta_id}`) ?? null) : null,
    };
  }

  /** "Chamado #12" ou "Chamado #12 (Equatorial, protocolo 123)" — para a mensagem da trilha. */
  private rotulo(c: { numero: number; tipo?: string | null; orgao?: string | null; protocolo?: string | null }) {
    if (c.tipo !== 'EXTERNO') return `Chamado #${c.numero}`;
    const extra = [c.orgao, c.protocolo ? `protocolo ${c.protocolo}` : null].filter(Boolean).join(', ');
    return `Chamado #${c.numero}${extra ? ` (${extra})` : ''}`;
  }

  private local(ctx: Contexto) {
    return [ctx.equipamento?.nome, ctx.unidade?.nome, ctx.planta?.nome].filter(Boolean).join(' · ') || '—';
  }

  /**
   * Trilha (auditoria_acessos, acao chamado_*). Mensagem sempre com "Chamado #N", órgão,
   * protocolo, equipamento e planta para a busca; objeto_tipo 'chamado' + objeto_id; detalhes com
   * ids e nomes. Falha só loga.
   */
  private async auditar(
    acao: AcaoChamado,
    c: {
      id: string;
      numero: number;
      titulo: string;
      status: string;
      motivo: string;
      prioridade: string;
      tipo?: string | null;
      orgao?: string | null;
      protocolo?: string | null;
    },
    ctx: Contexto,
    user: Usuario | undefined,
    cliente: ClienteInfo | undefined,
    o: { mensagem: string; extra?: Record<string, unknown> },
  ) {
    try {
      await this.auditoria.registrar({
        autorId: user?.id ?? null,
        autorNome: user?.nome ?? null,
        alvoUsuarioId: ctx.proprietario?.id ?? null,
        alvoNome: ctx.proprietario?.nome ?? null,
        acao,
        mensagem: o.mensagem,
        objetoTipo: 'chamado',
        objetoId: c.id,
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
          chamado: {
            id: c.id,
            numero: c.numero,
            tipo: c.tipo ?? 'INTERNO',
            titulo: c.titulo,
            status: c.status,
            motivo: c.motivo,
            prioridade: c.prioridade,
            orgao: c.orgao ?? null,
            protocolo: c.protocolo ?? null,
          },
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

const ROTULO_CAMPO: Record<string, string> = {
  titulo: 'título',
  descricao: 'descrição',
  motivo: 'motivo',
  prioridade: 'prioridade',
  orgao: 'órgão',
  protocolo: 'protocolo',
  ocorrencia_em: 'início da ocorrência',
  aberto_em: 'abertura no órgão',
  previsao_em: 'previsão',
  equipamento_id: 'equipamento',
  unidade_id: 'instalação',
  planta_id: 'planta',
};

const norm = (v: unknown) => (v instanceof Date ? v.toISOString() : v === undefined ? null : v);

/** Só o que mudou, com antes e depois (datas em ISO). */
export function diffCampos(antes: Record<string, unknown>, novo: Record<string, unknown>) {
  return CAMPOS_EDITAVEIS.filter((k) => k in novo && norm(antes[k]) !== norm(novo[k])).map((k) => ({
    campo: k,
    antes: norm(antes[k]),
    depois: norm(novo[k]),
  }));
}
