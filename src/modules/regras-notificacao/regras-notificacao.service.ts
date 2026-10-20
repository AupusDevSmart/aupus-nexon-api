import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, PermissionScopeService, ScopedUser } from '@/core';
import { AuditoriaAcessosService } from '@/core/modules/usuarios/auditoria-acessos.service';
import { isPapelSemEscopo, normalizarPapel } from '@/core/modules/auth/permission-scope.service';
import type { ClienteInfo } from '@/core/common/cliente-info';
import {
  CreateRegraNotificacaoDto,
  QueryRegrasNotificacaoDto,
  UpdateRegraNotificacaoDto,
} from './dto/regra-notificacao.dto';
import { ANTECEDENCIA_DIAS_PADRAO, LIMITE_MINUTOS_PADRAO } from './regras-notificacao.constants';
import { diffRegra, resumirAlteracoes, rotuloCanais, rotuloEvento, type AlteracaoCampo } from './regras-notificacao-auditoria';

type Autor = ScopedUser & { nome?: string | null; email?: string | null };
type Regra = Prisma.regras_notificacaoGetPayload<object>;
type DadosRegra = Partial<
  Pick<Regra, 'nome' | 'evento' | 'canais' | 'papeis' | 'planta_ids' | 'usuario_ids' | 'ativo' | 'limite_minutos' | 'antecedencia_dias'>
>;

const limpar = (ids?: string[] | null) => [...new Set((ids ?? []).map((i) => String(i).trim()).filter(Boolean))];

/**
 * NEXON-25 — Regras de notificação: quem é avisado, de quê e por qual canal.
 * Só as regras (o disparo é fase 2). Criar, editar e excluir gravam na trilha de acesso
 * (auditoria_acessos, acao 'regra_notificacao'), que aparece em Logs › Acessos.
 */
@Injectable()
export class RegrasNotificacaoService {
  private readonly logger = new Logger(RegrasNotificacaoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scopeService: PermissionScopeService,
    private readonly auditoria: AuditoriaAcessosService,
  ) {}

  async create(dto: CreateRegraNotificacaoDto, user?: Autor, cliente?: ClienteInfo) {
    const data = this.montar(dto);
    await this.validarPlantas(data.planta_ids ?? [], user);
    await this.validarUsuarios(data.usuario_ids ?? [], user);
    const regra = await this.prisma.regras_notificacao.create({
      data: { ...(data as Prisma.regras_notificacaoCreateInput), created_by: user?.id?.trim() ?? null, updated_by: user?.id?.trim() ?? null },
    });
    await this.auditar('criada', regra, diffRegra({}, regra as any), user, cliente);
    return this.enriquecer([regra]).then((r) => r[0]);
  }

  async findAll(query: QueryRegrasNotificacaoDto, user?: ScopedUser) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.regras_notificacaoWhereInput = { deleted_at: null };
    const AND: Prisma.regras_notificacaoWhereInput[] = [];

    if (query.evento && query.evento !== 'all') where.evento = query.evento;
    if (query.canal && query.canal !== 'all') where.canais = { has: query.canal };
    if (query.ativo && query.ativo !== 'all') where.ativo = query.ativo === 'true';
    if (query.plantaId && query.plantaId !== 'all') {
      // Regra sem planta vale para todas: também aparece no filtro por planta.
      AND.push({ OR: [{ planta_ids: { has: query.plantaId.trim() } }, { planta_ids: { isEmpty: true } }] });
    }
    if (query.search?.trim()) where.nome = { contains: query.search.trim(), mode: 'insensitive' };

    const scope = await this.scopeService.getScope(user);
    if (this.scopeService.isScoped(scope)) {
      AND.push(scope.length === 0 ? { id: '__NEVER__' } : { planta_ids: { hasSome: scope } });
    }
    if (AND.length) where.AND = AND;

    const [data, total] = await Promise.all([
      this.prisma.regras_notificacao.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ ativo: 'desc' }, { nome: 'asc' }],
      }),
      this.prisma.regras_notificacao.count({ where }),
    ]);

    return {
      data: await this.enriquecer(data),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string, user?: ScopedUser) {
    const regra = await this.buscar(id, user);
    return this.enriquecer([regra]).then((r) => r[0]);
  }

  async update(id: string, dto: UpdateRegraNotificacaoDto, user?: Autor, cliente?: ClienteInfo) {
    const antes = await this.buscar(id, user);
    const data = this.montar(dto, antes);
    if (data.planta_ids) await this.validarPlantas(data.planta_ids, user);
    if (data.usuario_ids) await this.validarUsuarios(data.usuario_ids, user);
    const alteracoes = diffRegra(antes as any, data as any);
    if (!alteracoes.length) return this.enriquecer([antes]).then((r) => r[0]);

    const regra = await this.prisma.regras_notificacao.update({
      where: { id: antes.id },
      data: { ...data, updated_by: user?.id?.trim() ?? null },
    });
    await this.auditar('editada', regra, alteracoes, user, cliente);
    return this.enriquecer([regra]).then((r) => r[0]);
  }

  async remove(id: string, user?: Autor, cliente?: ClienteInfo) {
    const regra = await this.buscar(id, user);
    await this.prisma.regras_notificacao.update({
      where: { id: regra.id },
      data: { deleted_at: new Date(), updated_by: user?.id?.trim() ?? null },
    });
    await this.auditar('excluida', regra, [], user, cliente);
  }

  /**
   * Quem recebe hoje, pela regra: papéis (operador pelas plantas que opera, proprietário
   * pelas que tem; papéis administrativos valem para todas) + usuários escolhidos.
   * É o que o disparo da fase 2 vai usar.
   */
  async destinatarios(id: string, user?: ScopedUser) {
    const regra = await this.buscar(id, user);
    const usuarios = await this.resolverDestinatarios(regra);
    return { total: usuarios.length, usuarios };
  }

  async resolverDestinatarios(regra: Pick<Regra, 'papeis' | 'planta_ids' | 'usuario_ids'>) {
    const plantas = limpar(regra.planta_ids);
    const papeis = limpar(regra.papeis).map(normalizarPapel);
    const OR: Prisma.usuariosWhereInput[] = [];

    const admins = papeis.filter((p) => isPapelSemEscopo(p));
    if (admins.length) OR.push({ role: { in: admins } });
    if (papeis.includes('operador')) {
      OR.push(
        plantas.length
          ? { role: 'operador', plantas_operando: { some: { planta_id: { in: plantas } } } }
          : { role: 'operador' },
      );
    }
    if (papeis.includes('proprietario')) {
      const roles = ['proprietario', 'propietario'];
      OR.push(plantas.length ? { role: { in: roles }, plantas_proprietario: { some: { id: { in: plantas }, deleted_at: null } } } : { role: { in: roles } });
    }
    const ids = limpar(regra.usuario_ids);
    if (ids.length) OR.push({ id: { in: ids } });
    if (!OR.length) return [];

    const usuarios = await this.prisma.usuarios.findMany({
      where: { deleted_at: null, OR },
      select: { id: true, nome: true, email: true, telefone: true, role: true },
      orderBy: { nome: 'asc' },
      take: 1000,
    });
    return usuarios.map((u) => ({ ...u, id: u.id.trim(), role: normalizarPapel(u.role) }));
  }

  // ---------------------------------------------------------------------------

  private async buscar(id: string, user?: ScopedUser): Promise<Regra> {
    const regra = await this.prisma.regras_notificacao.findFirst({ where: { id: id.trim(), deleted_at: null } });
    if (!regra) throw new NotFoundException('Regra não encontrada');
    const scope = await this.scopeService.getScope(user);
    if (this.scopeService.isScoped(scope)) {
      const plantas = limpar(regra.planta_ids);
      if (!plantas.length || !plantas.every((p) => scope.includes(p))) {
        throw new ForbiddenException('Regra fora das suas plantas');
      }
    }
    return regra;
  }

  /** Normaliza o DTO; o parâmetro do evento só fica no evento que o usa. */
  private montar(dto: UpdateRegraNotificacaoDto, antes?: Regra): DadosRegra {
    const out: DadosRegra = {};
    if (dto.nome !== undefined) out.nome = dto.nome.trim();
    if (dto.evento !== undefined) out.evento = dto.evento;
    if (dto.canais !== undefined) out.canais = limpar(dto.canais);
    if (dto.papeis !== undefined) out.papeis = limpar(dto.papeis).map(normalizarPapel);
    if (dto.planta_ids !== undefined) out.planta_ids = limpar(dto.planta_ids);
    if (dto.usuario_ids !== undefined) out.usuario_ids = limpar(dto.usuario_ids);
    if (dto.ativo !== undefined) out.ativo = dto.ativo;

    const evento = out.evento ?? antes?.evento;
    const limite = dto.limite_minutos !== undefined ? dto.limite_minutos : antes?.limite_minutos;
    const antecedencia = dto.antecedencia_dias !== undefined ? dto.antecedencia_dias : antes?.antecedencia_dias;
    out.limite_minutos = evento === 'sem_comunicacao' ? (limite ?? LIMITE_MINUTOS_PADRAO) : null;
    out.antecedencia_dias = evento === 'vencimento_acesso_morador' ? (antecedencia ?? ANTECEDENCIA_DIAS_PADRAO) : null;

    const papeis = out.papeis ?? antes?.papeis ?? [];
    const usuarios = out.usuario_ids ?? antes?.usuario_ids ?? [];
    if (!papeis.length && !usuarios.length) {
      throw new BadRequestException('Escolha quem recebe: ao menos um papel ou um usuário');
    }
    return out;
  }

  /** Usuário com escopo só cria regra nas plantas dele (e nunca "todas"). */
  private async validarPlantas(plantaIds: string[], user?: ScopedUser) {
    const scope = await this.scopeService.getScope(user);
    if (!this.scopeService.isScoped(scope)) return;
    if (!plantaIds.length || !plantaIds.every((p) => scope.includes(p))) {
      throw new ForbiddenException('Escolha só plantas que você acompanha');
    }
  }

  /** Usuário com escopo só escolhe a si mesmo ou quem opera/é dono de uma planta dele. */
  private async validarUsuarios(usuarioIds: string[], user?: ScopedUser) {
    if (!usuarioIds.length) return;
    const scope = await this.scopeService.getScope(user);
    if (!this.scopeService.isScoped(scope)) return;
    const eu = user?.id?.trim();
    const outros = usuarioIds.filter((id) => id !== eu);
    if (!outros.length) return;
    const dentro = await this.prisma.usuarios.count({
      where: {
        id: { in: outros },
        deleted_at: null,
        OR: [
          { plantas_operando: { some: { planta_id: { in: scope } } } },
          { plantas_proprietario: { some: { id: { in: scope }, deleted_at: null } } },
        ],
      },
    });
    if (dentro !== outros.length) throw new ForbiddenException('Escolha só usuários das suas plantas');
  }

  /** Nomes de plantas e usuários para a tabela (ids continuam na regra). */
  private async enriquecer(regras: Regra[]) {
    const plantaIds = [...new Set(regras.flatMap((r) => r.planta_ids))];
    const usuarioIds = [...new Set(regras.flatMap((r) => r.usuario_ids))];
    const [plantas, usuarios] = await Promise.all([
      plantaIds.length
        ? this.prisma.plantas.findMany({ where: { id: { in: plantaIds } }, select: { id: true, nome: true } })
        : Promise.resolve([] as { id: string; nome: string }[]),
      usuarioIds.length
        ? this.prisma.usuarios.findMany({ where: { id: { in: usuarioIds } }, select: { id: true, nome: true, email: true } })
        : Promise.resolve([] as { id: string; nome: string; email: string }[]),
    ]);
    const nomePlanta = new Map(plantas.map((p) => [p.id.trim(), p.nome]));
    const usuario = new Map(usuarios.map((u) => [u.id.trim(), { id: u.id.trim(), nome: u.nome, email: u.email }]));
    return regras.map((r) => ({
      ...r,
      id: r.id.trim(),
      plantas: r.planta_ids.map((id) => ({ id, nome: nomePlanta.get(id) ?? null })),
      usuarios: r.usuario_ids.map((id) => usuario.get(id) ?? { id, nome: null, email: null }),
    }));
  }

  private async auditar(
    operacao: 'criada' | 'editada' | 'excluida',
    regra: Regra,
    alteracoes: AlteracaoCampo[],
    user?: Autor,
    cliente?: ClienteInfo,
  ) {
    try {
      const [enriquecida] = await this.enriquecer([regra]);
      const evento = rotuloEvento(regra.evento);
      const canais = rotuloCanais(regra.canais);
      const detalhe =
        operacao === 'editada'
          ? resumirAlteracoes(alteracoes)
          : `${evento} · ${canais} · ${regra.planta_ids.length ? `${regra.planta_ids.length} planta(s)` : 'todas as plantas'}`;

      await this.auditoria.registrar({
        autorId: user?.id ?? null,
        alvoUsuarioId: null,
        acao: 'regra_notificacao',
        mensagem: `Regra de notificação ${operacao} — ${regra.nome}: ${detalhe}`,
        plantaIds: regra.planta_ids,
        dispositivo: cliente?.dispositivo ?? null,
        detalhes: {
          operacao,
          usuario: user
            ? {
                id: user.id?.trim() ?? null,
                nome: user.nome ?? null,
                email: user.email ?? null,
                papel: user.role ? normalizarPapel(user.role) : null,
              }
            : null,
          regra: {
            id: regra.id.trim(),
            nome: regra.nome,
            evento: regra.evento,
            evento_rotulo: evento,
            canais: regra.canais,
            papeis: regra.papeis,
            plantas: enriquecida.plantas,
            usuarios: enriquecida.usuarios,
            limite_minutos: regra.limite_minutos,
            antecedencia_dias: regra.antecedencia_dias,
            ativo: regra.ativo,
          },
          campos_alterados: alteracoes.map((a) => a.campo),
          alteracoes,
          ip: cliente?.ip ?? null,
          user_agent: cliente?.userAgent ?? null,
        },
      });
    } catch (e) {
      this.logger.warn(`[auditoria] regra de notificação não registrada (${regra.id}): ${(e as Error).message}`);
    }
  }
}
