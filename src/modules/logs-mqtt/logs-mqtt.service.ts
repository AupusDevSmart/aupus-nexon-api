import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService, PermissionScopeService, ScopedUser, Prisma } from '@/core';
import { QueryLogsMqttDto } from './dto/query-logs-mqtt.dto';
import { colunaTrilhaAusente, condicaoStatus, juntarE, parseTipos, StatusAlarme } from './logs-mqtt-filtros';

type Usuario = ScopedUser & { nome?: string; email?: string };

interface LinhaBase {
  id: string;
  tipo: string;
  equipamento_id: string | null;
  mensagem: string;
  severidade: string;
  created_at: Date;
  regra_id: string | null;
  valor_lido: unknown;
  dados_snapshot: unknown;
  cmd_id: string | null;
  status: string | null;
  latency_ms: number | null;
  usuario_id: string | null;
  ton_id: string | null;
  ton_bo_id: string | null;
  comando_tecnico: string | null;
  comando_semantico: string | null;
  dispositivo: string | null;
  reconhecido_em: Date | null;
  reconhecido_por_texto: string | null;
  reconhecido_por_id: string | null;
  resolvido_em: Date | null;
  resolvido_por_id: string | null;
  silenciado_ate: Date | null;
  detalhes: unknown;
  alvo_usuario_id: string | null;
}

@Injectable()
export class LogsMqttService {
  private readonly logger = new Logger(LogsMqttService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scopeService: PermissionScopeService,
  ) {}

  /**
   * Listagem da trilha: alertas e comandos (logs_mqtt) + acessos (auditoria_acessos,
   * só quando `tipo` inclui 'acesso'). Resposta "dupla" de sempre:
   * `{ data: [...], pagination }`.
   *
   * As colunas de trilha (dispositivo, reconhecido_*, resolvido_*, silenciado_ate)
   * ficam fora do schema Prisma → SQL. Se o SQL da trilha ainda não foi aplicado
   * (coluna/tabela ausente), cai na listagem antiga (Prisma) para o web não quebrar.
   */
  async findAll(query: QueryLogsMqttDto, user?: Usuario) {
    try {
      return await this.findAllTrilha(query, user);
    } catch (e) {
      if (!colunaTrilhaAusente(e)) throw e;
      this.logger.warn(`[logs-mqtt] SQL da trilha não aplicado — listagem legada: ${(e as Error).message}`);
      return this.findAllLegado(query, user);
    }
  }

  private async findAllTrilha(query: QueryLogsMqttDto, user?: Usuario) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const offset = (page - 1) * limit;
    const tipos = parseTipos(query.tipo);
    const status = query.status as StatusAlarme | undefined;
    const tiposLog = tipos ? tipos.filter((t) => t !== 'acesso') : null;
    const incluiLogs = !tipos || (tiposLog?.length ?? 0) > 0;
    const incluiAcesso = !!tipos?.includes('acesso') && !status && !query.equipamentoId && !query.regraId;

    const scope = await this.scopeService.getScope(user);
    const escopado = this.scopeService.isScoped(scope);
    const eqId = limpo(query.equipamentoId);
    const unId = limpo(query.unidadeId);
    const plId = limpo(query.plantaId);
    const usId = limpo(query.usuarioId);

    const partes: Prisma.Sql[] = [];

    if (incluiLogs) {
      const c: Prisma.Sql[] = [];
      if (tiposLog && tiposLog.length) c.push(Prisma.sql`l.tipo = ANY(${tiposLog}::text[])`);
      if (status) c.push(condicaoStatus(status, new Date()));
      if (eqId) c.push(Prisma.sql`l.equipamento_id = ${eqId}::bpchar`);
      if (unId) c.push(Prisma.sql`e.unidade_id = ${unId}::bpchar`);
      if (plId) c.push(Prisma.sql`TRIM(COALESCE(un.planta_id, e.planta_id)) = ${plId}`);
      if (usId) c.push(Prisma.sql`l.usuario_id = ${usId}::bpchar`);
      if (query.regraId) c.push(Prisma.sql`l.regra_id = ${query.regraId.trim()}::bpchar`);
      if (query.severidade) c.push(Prisma.sql`l.severidade = ${query.severidade}`);
      if (query.search) c.push(Prisma.sql`l.mensagem ILIKE ${'%' + query.search + '%'}`);
      if (query.dataInicial) c.push(Prisma.sql`l.created_at >= ${new Date(query.dataInicial)}`);
      if (query.dataFinal) c.push(Prisma.sql`l.created_at <= ${new Date(query.dataFinal)}`);
      if (escopado) {
        c.push(
          scope.length === 0
            ? Prisma.sql`FALSE`
            : Prisma.sql`TRIM(COALESCE(un.planta_id, e.planta_id)) = ANY(${scope}::text[])`,
        );
      }
      partes.push(Prisma.sql`
        SELECT TRIM(l.id) AS id, l.tipo::text AS tipo, TRIM(l.equipamento_id) AS equipamento_id,
               l.mensagem::text AS mensagem, l.severidade::text AS severidade, l.created_at,
               TRIM(l.regra_id) AS regra_id, l.valor_lido, l.dados_snapshot,
               l.cmd_id::text AS cmd_id, l.status::text AS status, l.latency_ms,
               TRIM(l.usuario_id) AS usuario_id, TRIM(l.ton_id) AS ton_id, TRIM(l.ton_bo_id) AS ton_bo_id,
               l.comando_tecnico::text AS comando_tecnico, l.comando_semantico::text AS comando_semantico,
               l.dispositivo::text AS dispositivo, l.reconhecido_em, l.reconhecido_por::text AS reconhecido_por_texto,
               TRIM(l.reconhecido_por_id) AS reconhecido_por_id, l.resolvido_em,
               TRIM(l.resolvido_por) AS resolvido_por_id, l.silenciado_ate,
               NULL::jsonb AS detalhes, NULL::text AS alvo_usuario_id
        FROM logs_mqtt l
        JOIN equipamentos e ON e.id = l.equipamento_id
        LEFT JOIN unidades un ON un.id = e.unidade_id
        WHERE ${juntarE(c)}`);
    }

    if (incluiAcesso) {
      const c: Prisma.Sql[] = [];
      if (unId) c.push(Prisma.sql`${unId} = ANY(a.unidade_ids)`);
      if (plId) c.push(Prisma.sql`${plId} = ANY(a.planta_ids)`);
      if (usId) c.push(Prisma.sql`a.autor_id = ${usId}::bpchar`);
      if (query.severidade) c.push(Prisma.sql`${query.severidade} = 'INFO'`);
      if (query.search) c.push(Prisma.sql`a.mensagem ILIKE ${'%' + query.search + '%'}`);
      if (query.dataInicial) c.push(Prisma.sql`a.created_at >= ${new Date(query.dataInicial)}`);
      if (query.dataFinal) c.push(Prisma.sql`a.created_at <= ${new Date(query.dataFinal)}`);
      if (user?.role === 'operador') {
        // Operador vê só o que mudou o acesso DELE (ou o que ele mesmo fez).
        const me = user.id?.trim() ?? '';
        c.push(Prisma.sql`(a.alvo_usuario_id = ${me}::bpchar OR a.autor_id = ${me}::bpchar)`);
      } else if (escopado) {
        c.push(scope.length === 0 ? Prisma.sql`FALSE` : Prisma.sql`a.planta_ids && ${scope}::text[]`);
      }
      partes.push(Prisma.sql`
        SELECT TRIM(a.id) AS id, 'acesso'::text AS tipo, NULL::text AS equipamento_id,
               a.mensagem::text AS mensagem, 'INFO'::text AS severidade, a.created_at,
               NULL::text AS regra_id, NULL::numeric AS valor_lido, NULL::jsonb AS dados_snapshot,
               NULL::text AS cmd_id, NULL::text AS status, NULL::int AS latency_ms,
               TRIM(a.autor_id) AS usuario_id, NULL::text AS ton_id, NULL::text AS ton_bo_id,
               NULL::text AS comando_tecnico, NULL::text AS comando_semantico,
               a.dispositivo::text AS dispositivo, NULL::timestamp AS reconhecido_em, NULL::text AS reconhecido_por_texto,
               NULL::text AS reconhecido_por_id, NULL::timestamp AS resolvido_em,
               NULL::text AS resolvido_por_id, NULL::timestamp AS silenciado_ate,
               a.detalhes, TRIM(a.alvo_usuario_id) AS alvo_usuario_id
        FROM auditoria_acessos a
        WHERE ${juntarE(c)}`);
    }

    if (partes.length === 0) {
      return { data: [], pagination: { page, limit, total: 0, totalPages: 0 } };
    }

    const uniao = Prisma.join(partes, ' UNION ALL ');
    const ordem =
      query.orderBy === 'severidade'
        ? query.orderDirection === 'asc'
          ? Prisma.sql`severidade ASC, created_at DESC`
          : Prisma.sql`severidade DESC, created_at DESC`
        : query.orderDirection === 'asc'
          ? Prisma.sql`created_at ASC`
          : Prisma.sql`created_at DESC`;

    const [linhas, totalRows] = await Promise.all([
      this.prisma.$queryRaw<LinhaBase[]>`
        SELECT * FROM (${uniao}) t ORDER BY ${ordem} LIMIT ${limit} OFFSET ${offset}`,
      this.prisma.$queryRaw<Array<{ total: bigint }>>`SELECT COUNT(*) AS total FROM (${uniao}) t`,
    ]);
    const total = Number(totalRows[0]?.total ?? 0);

    return {
      data: await this.enriquecer(linhas),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /** Junta regra, equipamento (+ unidade) e nomes de usuários às linhas. */
  private async enriquecer(linhas: LinhaBase[]) {
    const ids = (f: (l: LinhaBase) => (string | null)[]) =>
      [...new Set(linhas.flatMap(f).filter((x): x is string => !!x))];
    const regraIds = ids((l) => [l.regra_id]);
    const equipIds = ids((l) => [l.equipamento_id]);
    const userIds = ids((l) => [l.usuario_id, l.reconhecido_por_id, l.resolvido_por_id, l.alvo_usuario_id]);

    // `in: []` devolve [] sem ir ao banco.
    const [regras, equips, usuarios] = await Promise.all([
      this.prisma.regras_logs_mqtt.findMany({
        where: { id: { in: regraIds } },
        select: { id: true, nome: true, campo_json: true, operador: true, valor: true },
      }),
      this.prisma.equipamentos.findMany({
        where: { id: { in: equipIds } },
        select: { id: true, nome: true, unidade: { select: { id: true, nome: true, cidade: true } } },
      }),
      this.prisma.usuarios.findMany({ where: { id: { in: userIds } }, select: { id: true, nome: true } }),
    ]);
    const regraPor = new Map(regras.map((r) => [r.id.trim(), { ...r, id: r.id.trim() }]));
    const equipPor = new Map(
      equips.map((e) => [
        e.id.trim(),
        {
          id: e.id.trim(),
          nome: e.nome,
          unidade: e.unidade ? { id: e.unidade.id.trim(), nome: e.unidade.nome, cidade: e.unidade.cidade } : null,
        },
      ]),
    );
    const userPor = new Map(usuarios.map((u) => [u.id.trim(), { id: u.id.trim(), nome: u.nome }]));
    const pessoa = (id: string | null) => (id ? userPor.get(id) ?? { id, nome: null } : null);

    return linhas.map((l) => {
      const { reconhecido_por_texto, reconhecido_por_id, resolvido_por_id, alvo_usuario_id, detalhes, ...resto } = l;
      const reconhecidoPor =
        pessoa(reconhecido_por_id) ?? (reconhecido_por_texto ? { id: null, nome: reconhecido_por_texto } : null);
      return {
        ...resto,
        regra: l.regra_id ? regraPor.get(l.regra_id) ?? null : null,
        equipamento: l.equipamento_id ? equipPor.get(l.equipamento_id) ?? null : null,
        usuario: pessoa(l.usuario_id),
        reconhecido_por: reconhecidoPor,
        resolvido_por: pessoa(resolvido_por_id),
        ...(l.tipo === 'acesso' ? { alvo_usuario: pessoa(alvo_usuario_id), detalhes } : {}),
      };
    });
  }

  /** Listagem antiga (Prisma) — só enquanto o SQL da trilha não estiver aplicado. */
  private async findAllLegado(query: QueryLogsMqttDto, user?: Usuario) {
    const { page = 1, limit = 10, search, equipamentoId, unidadeId, regraId, severidade, dataInicial, dataFinal } =
      query;
    const where: any = {};
    const tiposLog = parseTipos(query.tipo)?.filter((t) => t !== 'acesso');
    if (tiposLog) where.tipo = tiposLog.length ? { in: tiposLog } : '__NENHUM__';
    if (query.status) where.tipo = 'alerta';
    if (query.usuarioId) where.usuario_id = query.usuarioId.trim();
    if (equipamentoId && equipamentoId !== 'all') where.equipamento_id = equipamentoId.trim();
    if (unidadeId && unidadeId !== 'all') where.equipamento = { unidade_id: unidadeId.trim() };
    if (query.plantaId) {
      where.equipamento = { ...(where.equipamento ?? {}), unidade: { planta_id: query.plantaId.trim() } };
    }
    if (regraId) where.regra_id = regraId.trim();
    if (severidade) where.severidade = severidade;
    if (search) where.mensagem = { contains: search, mode: 'insensitive' };
    if (dataInicial || dataFinal) {
      where.created_at = {};
      if (dataInicial) where.created_at.gte = new Date(dataInicial);
      if (dataFinal) where.created_at.lte = new Date(dataFinal);
    }
    const scope = await this.scopeService.getScope(user);
    if (this.scopeService.isScoped(scope)) {
      where.AND =
        scope.length === 0 ? [{ id: '__NEVER__' }] : [{ equipamento: { unidade: { planta_id: { in: scope } } } }];
    }
    const [data, total] = await Promise.all([
      this.prisma.logs_mqtt.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { [query.orderBy || 'created_at']: query.orderDirection || 'desc' },
        include: {
          regra: { select: { id: true, nome: true, campo_json: true, operador: true, valor: true } },
          equipamento: { select: { id: true, nome: true } },
        },
      }),
      this.prisma.logs_mqtt.count({ where }),
    ]);
    return { data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async findOne(id: string, user?: ScopedUser) {
    if (user) await this.scopeService.assertEntityInScope('log_mqtt', id.trim(), user);
    const log = await this.prisma.logs_mqtt.findUnique({
      where: { id: id.trim() },
      include: {
        regra: {
          select: {
            id: true,
            nome: true,
            campo_json: true,
            operador: true,
            valor: true,
            severidade: true,
            cooldown_minutos: true,
          },
        },
        equipamento: {
          select: { id: true, nome: true },
        },
      },
    });
    if (!log) throw new NotFoundException('Log não encontrado');
    return log;
  }

  async remove(id: string, user?: ScopedUser) {
    await this.findOne(id, user);
    return this.prisma.logs_mqtt.delete({ where: { id: id.trim() } });
  }

  /**
   * Reconhecer (ack) um alarme: marca reconhecido_em/por. Usado pro modelo
   * "alarme fica ativo até o operador marcar como visto" (ex.: trip do relé).
   * findOne valida existência + escopo (tenant isolation). Colunas de ack não
   * estão no model Prisma → gravadas por raw (idempotente: só marca se NULL).
   * reconhecido_por segue sendo o NOME (texto, web); reconhecido_por_id é o id.
   */
  async reconhecer(id: string, user?: Usuario) {
    await this.findOne(id, user);
    const u: Usuario = user || {};
    const quem = String(u.nome || u.email || u.id || 'operador').slice(0, 64);
    const quemId = u.id?.trim() || null;
    try {
      await this.prisma.$executeRaw`
        UPDATE logs_mqtt SET reconhecido_em = now(), reconhecido_por = ${quem}, reconhecido_por_id = ${quemId}
        WHERE TRIM(id) = ${id.trim()} AND reconhecido_em IS NULL`;
    } catch (e) {
      if (!colunaTrilhaAusente(e)) throw e;
      await this.prisma.$executeRaw`
        UPDATE logs_mqtt SET reconhecido_em = now(), reconhecido_por = ${quem}
        WHERE TRIM(id) = ${id.trim()} AND reconhecido_em IS NULL`;
    }
    return { ok: true, reconhecido_por: quem };
  }

  /** Resolve o alarme (sai de Ativos/Reconhecidos e vai para Resolvidos). Idempotente. */
  async resolver(id: string, user?: Usuario) {
    await this.exigirAlerta(id, user);
    const quemId = user?.id?.trim() || null;
    const rows = await this.prisma.$queryRaw<Array<{ resolvido_em: Date }>>`
      UPDATE logs_mqtt SET resolvido_em = COALESCE(resolvido_em, now()), resolvido_por = COALESCE(resolvido_por, ${quemId})
      WHERE TRIM(id) = ${id.trim()}
      RETURNING resolvido_em`;
    return { ok: true, resolvido_em: rows[0]?.resolvido_em ?? null };
  }

  /** Silencia o alarme por N horas (1..24): some de Ativos até vencer. */
  async silenciar(id: string, horas: number, user?: Usuario) {
    await this.exigirAlerta(id, user);
    const h = Math.trunc(Number(horas));
    if (!Number.isFinite(h) || h < 1 || h > 24) throw new BadRequestException('horas deve estar entre 1 e 24');
    const ate = new Date(Date.now() + h * 60 * 60 * 1000);
    await this.prisma.$executeRaw`UPDATE logs_mqtt SET silenciado_ate = ${ate} WHERE TRIM(id) = ${id.trim()}`;
    return { ok: true, silenciado_ate: ate };
  }

  private async exigirAlerta(id: string, user?: ScopedUser) {
    const log = await this.findOne(id, user);
    if (log.tipo !== 'alerta') throw new BadRequestException('Só alarmes podem ser resolvidos ou silenciados');
    return log;
  }
}

function limpo(v?: string | null): string | null {
  const t = v?.trim();
  return t && t !== 'all' ? t : null;
}
