import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { isGlobal, papelCanonico } from './papeis';

export type PlantaScope = string[] | null;

/**
 * Usuario "leve" suficiente para resolver scope. JWT payload normalmente tras id e role.
 */
export interface ScopedUser {
  id?: string;
  role?: string | null;
}

/**
 * Entidades cujos vinculos a planta sao resolviveis por uma consulta padrao.
 * Use em `assertEntityInScope(type, id, user)` quando o controller recebe o id
 * de uma entidade dependente e nao tem o `planta_id` em maos.
 */
export type ScopedEntityType =
  | 'planta'
  | 'unidade'
  | 'equipamento'
  | 'anomalia'
  | 'tarefa'
  | 'ordem_servico'
  | 'solicitacao_servico'
  | 'programacao_os'
  | 'regra_log_mqtt'
  | 'log_mqtt'
  | 'anexo_equipamento'
  | 'anexo_unidade';

/**
 * Papeis que veem TODAS as plantas (escopo nulo). Lista fechada de proposito:
 * qualquer papel fora dela cai no escopo por vinculo (default-deny).
 */
export const PAPEIS_SEM_ESCOPO: readonly string[] = [
  'super_admin',
  'admin',
  'gerente',
  'analista',
  'analista_automacao',
  'analista_operacao',
];

/**
 * O que o operador alcança pelos vínculos ativos (NEXON-20, PER-12..24):
 * equipamentos liberados (e os filhos deles, que andam junto), as instalações e
 * plantas que os contêm e as permissões extras.
 */
export interface AcessoOperador {
  equipamentos: Set<string>;
  unidades: Set<string>;
  plantas: Set<string>;
  /** Equipamentos com "Ver valores em R$". */
  verRs: Set<string>;
  /** Instalações com "Ver geração" (análise de geração). */
  verGeracao: Set<string>;
}

/** Cache curto: várias checagens na mesma requisição sem refazer a consulta; PER-21f (vale na próxima). */
const TTL_ACESSO_MS = 3000;

/** Normaliza o nome do papel: minusculo, sem espacos, e corrige o typo historico 'propietario'. */
export function normalizarPapel(role?: string | null): string {
  const r = String(role ?? '').trim().toLowerCase();
  return r === 'propietario' ? 'proprietario' : r;
}

/** true quando o papel e administrativo (exporta/ve tudo). */
export function isPapelSemEscopo(role?: string | null): boolean {
  return PAPEIS_SEM_ESCOPO.includes(normalizarPapel(role)) || isGlobal(papelCanonico(role));
}

function tabelaVinculoAusente(e: unknown): boolean {
  return /operador_vinculo\w* .*does not exist|relation "operador_vinculo/i.test((e as Error)?.message ?? '');
}

/**
 * Resolve o conjunto de plantas que um usuario pode acessar, com base no seu role,
 * e fornece helpers para aplicar/validar o escopo em queries e endpoints.
 *
 * Convencao do escopo:
 * - `null`     -> SEM filtro (so PAPEIS_SEM_ESCOPO, ou chamada interna sem usuario)
 * - `string[]` -> lista de planta_ids permitidos (array vazio = nao ve nada)
 *
 * Mapeamento por role (default-deny):
 * - super_admin/admin/gerente/analista -> null (ve tudo)
 * - operador     -> plantas com algum equipamento liberado nos vinculos ativos
 *                   (operador_vinculos; sem a tabela, cai no legado planta_operadores)
 * - proprietario -> plantas onde plantas.proprietario_id = userId ('propietario' idem)
 * - qualquer outro papel (ou sem papel) -> uniao dos dois vinculos acima; sem vinculo = []
 *
 * Convencao de resposta a recurso fora do escopo: ForbiddenException (consistente
 * em todos os modulos; ver docs/RBAC-SCOPE.md).
 */
@Injectable()
export class PermissionScopeService {
  private cacheAcesso = new Map<string, { em: number; valor: AcessoOperador | null }>();

  constructor(private prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Acesso do operador por equipamento (vinculos)
  // -------------------------------------------------------------------------

  /**
   * Equipamentos/instalações/plantas que o operador alcança pelos vínculos
   * ativos (não removidos e dentro da validade, fuso de São Paulo). Filhos de um
   * equipamento liberado (equipamento_pai_id) andam junto.
   *
   * `null` = tabela de vínculos ainda não existe (SQL 2026-10-20c não aplicado):
   * o operador segue no escopo legado por planta, sem recorte por equipamento.
   */
  async getAcessoOperador(userId: string): Promise<AcessoOperador | null> {
    const id = userId?.trim();
    if (!id) return null;
    const c = this.cacheAcesso.get(id);
    if (c && Date.now() - c.em < TTL_ACESSO_MS) return c.valor;

    let valor: AcessoOperador | null;
    try {
      const [linhas, extras] = await Promise.all([
        this.prisma.$queryRaw<Array<{ id: string; planta_id: string | null; unidade_id: string | null; ver_rs: boolean }>>`
          WITH RECURSIVE lib AS (
            -- Só vale enquanto a planta do equipamento for do proprietário do vínculo
            -- (planta que troca de dono não leva junto o operador do dono antigo).
            SELECT ve.equipamento_id AS id, bool_or(ve.ver_rs) AS ver_rs
            FROM operador_vinculo_equipamentos ve
            JOIN operador_vinculos v ON v.id = ve.vinculo_id
            JOIN equipamentos e0 ON e0.id = ve.equipamento_id
            LEFT JOIN unidades u0 ON u0.id = e0.unidade_id
            JOIN plantas p0 ON p0.id = COALESCE(e0.planta_id, u0.planta_id) AND p0.proprietario_id = v.proprietario_id
            WHERE v.operador_id = ${id}::bpchar AND v.removido_em IS NULL
              AND (v.validade IS NULL OR v.validade >= (now() AT TIME ZONE 'America/Sao_Paulo')::date)
            GROUP BY ve.equipamento_id
          ), arv AS (
            SELECT e.id, lib.ver_rs, 0 AS nivel FROM equipamentos e JOIN lib ON lib.id = e.id WHERE e.deleted_at IS NULL
            UNION ALL
            SELECT f.id, arv.ver_rs, arv.nivel + 1 FROM equipamentos f JOIN arv ON f.equipamento_pai_id = arv.id
            WHERE f.deleted_at IS NULL AND arv.nivel < 6
          )
          SELECT TRIM(e.id) AS id, TRIM(COALESCE(e.planta_id, u.planta_id)) AS planta_id,
                 TRIM(e.unidade_id) AS unidade_id, bool_or(arv.ver_rs) AS ver_rs
          FROM arv JOIN equipamentos e ON e.id = arv.id
          LEFT JOIN unidades u ON u.id = e.unidade_id
          GROUP BY e.id, e.planta_id, u.planta_id, e.unidade_id`,
        this.prisma.$queryRaw<Array<{ unidade_id: string }>>`
          SELECT DISTINCT TRIM(vu.unidade_id) AS unidade_id
          FROM operador_vinculo_unidades vu
          JOIN operador_vinculos v ON v.id = vu.vinculo_id
          JOIN unidades u1 ON u1.id = vu.unidade_id
          JOIN plantas p1 ON p1.id = u1.planta_id AND p1.proprietario_id = v.proprietario_id
          WHERE v.operador_id = ${id}::bpchar AND v.removido_em IS NULL AND vu.ver_geracao
            AND (v.validade IS NULL OR v.validade >= (now() AT TIME ZONE 'America/Sao_Paulo')::date)`,
      ]);
      valor = {
        equipamentos: new Set(linhas.map((l) => l.id)),
        // "Ver geração" também abre a instalação (a análise mora nela).
        unidades: new Set([
          ...linhas.map((l) => l.unidade_id).filter((x): x is string => !!x),
          ...extras.map((x) => x.unidade_id),
        ]),
        plantas: new Set(linhas.map((l) => l.planta_id).filter((x): x is string => !!x)),
        verRs: new Set(linhas.filter((l) => l.ver_rs).map((l) => l.id)),
        verGeracao: new Set(extras.map((x) => x.unidade_id)),
      };
    } catch (e) {
      if (!tabelaVinculoAusente(e)) throw e;
      valor = null;
    }
    this.cacheAcesso.set(id, { em: Date.now(), valor });
    if (this.cacheAcesso.size > 500) this.cacheAcesso.clear();
    return valor;
  }

  /** Esquece o acesso guardado (depois de gravar vínculo, para valer já). */
  invalidarAcesso(userId?: string | null): void {
    if (userId?.trim()) this.cacheAcesso.delete(userId.trim());
    else this.cacheAcesso.clear();
  }

  /** true quando o usuário é operador com recorte por equipamento ativo. */
  async acessoPorEquipamento(user?: ScopedUser | null): Promise<AcessoOperador | null> {
    if (!user?.id || papelCanonico(user.role) !== 'operador') return null;
    return this.getAcessoOperador(user.id);
  }

  /**
   * Ids de equipamento que o usuário pode ver. `null` = sem recorte por
   * equipamento (vale só o escopo de planta). Array vazio = nenhum.
   */
  async getEquipamentosScope(user?: ScopedUser | null): Promise<string[] | null> {
    const a = await this.acessoPorEquipamento(user);
    return a ? [...a.equipamentos] : null;
  }

  /** Ids de instalação (unidade) visíveis. `null` = sem recorte além da planta. */
  async getUnidadesScope(user?: ScopedUser | null): Promise<string[] | null> {
    const a = await this.acessoPorEquipamento(user);
    return a ? [...a.unidades] : null;
  }

  /**
   * Filtro Prisma por equipamento (mesma convenção de `applyPlantaFilter`):
   * `path` = 'id' na própria tabela de equipamentos, 'equipamento_id' nas dependentes.
   */
  applyEquipamentoFilter<T extends Record<string, any>>(where: T, eqScope: string[] | null, path = 'id'): T {
    if (!Array.isArray(eqScope)) return where;
    return this.applyPlantaFilter(where, eqScope, path);
  }

  /** Operador sem o equipamento liberado → 403 (PER-23). Demais papéis passam. */
  async assertEquipamentoLiberado(equipamentoId: string | null | undefined, user?: ScopedUser | null): Promise<void> {
    const a = await this.acessoPorEquipamento(user);
    if (!a) return;
    const id = equipamentoId?.trim();
    if (!id || !a.equipamentos.has(id)) throw new ForbiddenException('Recurso fora do escopo do usuario');
  }

  /** "Ver valores em R$" (seção 6.4): operador só com a permissão extra no equipamento. */
  async podeVerValores(equipamentoId: string | null | undefined, user?: ScopedUser | null): Promise<boolean> {
    const a = await this.acessoPorEquipamento(user);
    if (!a) return true;
    const id = equipamentoId?.trim();
    return !!id && a.verRs.has(id);
  }

  /** Análise de geração (PER-40): operador só com "Ver geração" na instalação. */
  async podeVerGeracao(unidadeId: string | null | undefined, user?: ScopedUser | null): Promise<boolean> {
    const a = await this.acessoPorEquipamento(user);
    if (!a) return true;
    const id = unidadeId?.trim();
    return !!id && a.verGeracao.has(id);
  }

  // -------------------------------------------------------------------------
  // Resolucao do scope
  // -------------------------------------------------------------------------

  async getPlantasDoUsuario(userId: string, roleName?: string | null): Promise<PlantaScope> {
    const id = userId?.trim();
    if (!id) return null;

    const papel = normalizarPapel(roleName);
    if (isPapelSemEscopo(papel)) return null;

    const comoOperadorLegado = async () =>
      (
        await this.prisma.planta_operadores.findMany({
          where: { usuario_id: id },
          select: { planta_id: true },
        })
      ).map((r) => r.planta_id.trim());

    const comoOperador = async () => {
      const a = await this.getAcessoOperador(id);
      return a ? [...a.plantas] : comoOperadorLegado();
    };

    const comoProprietario = async () =>
      (
        await this.prisma.plantas.findMany({
          where: { proprietario_id: id, deleted_at: null },
          select: { id: true },
        })
      ).map((r) => r.id.trim());

    if (papel === 'operador') return comoOperador();
    if (papel === 'proprietario') return comoProprietario();

    // Papel desconhecido (cativo, associado, consultor, sem papel...): so o que
    // estiver vinculado a ele. Sem vinculo, escopo vazio — nunca "ve tudo".
    const [op, prop] = await Promise.all([comoOperador(), comoProprietario()]);
    return Array.from(new Set([...op, ...prop]));
  }

  /**
   * Conveniencia: resolve o scope direto a partir do objeto de usuario do request.
   */
  async getScope(user?: ScopedUser | null): Promise<PlantaScope> {
    if (!user?.id) return null;
    return this.getPlantasDoUsuario(user.id, user.role ?? null);
  }

  isScoped(scope: PlantaScope): scope is string[] {
    return Array.isArray(scope);
  }

  // -------------------------------------------------------------------------
  // Aplicacao em filtros Prisma
  // -------------------------------------------------------------------------

  /**
   * Aplica o filtro de planta no objeto `where` do Prisma quando o escopo eh ativo.
   *
   * `path` aceita:
   * - 'planta_id'                              (entidade tem coluna direta)
   * - 'unidade.planta_id'                      (atravessa 1 relacao)
   * - 'equipamento.unidade.planta_id'          (atravessa 2 relacoes)
   *
   * O where eh mutado E retornado para encadeamento.
   *
   * Exemplos:
   *   applyPlantaFilter({}, scope, 'planta_id')
   *     -> { planta_id: { in: scope } }
   *
   *   applyPlantaFilter({}, scope, 'unidade.planta_id')
   *     -> { unidade: { planta_id: { in: scope } } }
   *
   *   applyPlantaFilter({}, scope, 'equipamento.unidade.planta_id')
   *     -> { equipamento: { unidade: { planta_id: { in: scope } } } }
   */
  applyPlantaFilter<T extends Record<string, any>>(
    where: T,
    scope: PlantaScope,
    path: string = 'planta_id',
  ): T {
    if (!this.isScoped(scope)) return where;

    const parts = path.split('.').filter(Boolean);
    if (parts.length === 0) return where;

    const leaf = { in: scope };
    if (parts.length === 1) {
      (where as any)[parts[0]] = leaf;
      return where;
    }

    // Constroi nested where reverso: equipamento -> { unidade: { planta_id: leaf } }
    let nested: any = leaf;
    for (let i = parts.length - 1; i >= 1; i--) {
      nested = { [parts[i]]: nested };
    }
    (where as any)[parts[0]] = nested;
    return where;
  }

  // -------------------------------------------------------------------------
  // Asserts de pertencimento ao escopo
  // -------------------------------------------------------------------------

  /**
   * Joga ForbiddenException se o `plantaId` nao esta no escopo do usuario.
   * Aceita scope null (admin) ou plantaId null/undefined (registro "global" -> proibido para escopados).
   */
  async assertPlantaInScope(plantaId: string | null | undefined, user: ScopedUser | undefined): Promise<void> {
    const scope = await this.getScope(user);
    if (!this.isScoped(scope)) return;

    const id = plantaId?.trim();
    if (!id) {
      throw new ForbiddenException('Recurso fora do escopo do usuario');
    }
    if (!scope.includes(id)) {
      throw new ForbiddenException('Recurso fora do escopo do usuario');
    }
  }

  /**
   * Variante para quando o caller ja resolveu o scope (evita 2a query).
   */
  assertPlantaInScopeSync(plantaId: string | null | undefined, scope: PlantaScope): void {
    if (!this.isScoped(scope)) return;
    const id = plantaId?.trim();
    if (!id || !scope.includes(id)) {
      throw new ForbiddenException('Recurso fora do escopo do usuario');
    }
  }

  /**
   * Resolve o planta_id de uma entidade dependente e valida que esta no escopo.
   * Util quando o controller so tem o id do equipamento/unidade/tarefa/etc.
   *
   * Lanca NotFoundException se a entidade nao existe (consistente com /:id GET).
   * Lanca ForbiddenException se existe mas esta fora do escopo.
   */
  async assertEntityInScope(
    type: ScopedEntityType,
    entityId: string,
    user: ScopedUser | undefined,
  ): Promise<void> {
    const scope = await this.getScope(user);
    if (!this.isScoped(scope)) return;

    const id = entityId?.trim();
    if (!id) throw new NotFoundException(`${type} nao encontrado`);

    const plantaId = await this.resolveEntityPlantaId(type, id);
    if (plantaId === null) throw new NotFoundException(`${type} nao encontrado`);
    this.assertPlantaInScopeSync(plantaId, scope);

    // Operador: além da planta, só o equipamento/instalação liberado (PER-23).
    const acesso = await this.acessoPorEquipamento(user);
    if (!acesso) return;
    if (type === 'planta') return;
    if (type === 'unidade' || type === 'anexo_unidade') {
      const unidadeId = type === 'unidade' ? id : await this.resolveUnidadeDoAnexo(id);
      if (!unidadeId || !acesso.unidades.has(unidadeId)) {
        throw new ForbiddenException('Recurso fora do escopo do usuario');
      }
      return;
    }
    const equipamentoId = type === 'equipamento' ? id : await this.resolveEntityEquipamentoId(type, id);
    // Registro sem equipamento (anomalia/OS da planta): basta a planta.
    if (equipamentoId === undefined) return;
    if (!equipamentoId || !acesso.equipamentos.has(equipamentoId)) {
      throw new ForbiddenException('Recurso fora do escopo do usuario');
    }
  }

  private async resolveUnidadeDoAnexo(anexoId: string): Promise<string | null> {
    const row = await this.prisma.anexos_unidades.findFirst({
      where: { id: anexoId, deleted_at: null },
      select: { unidade_id: true },
    });
    return row?.unidade_id?.trim() ?? null;
  }

  /**
   * Equipamento de uma entidade dependente. `undefined` = a entidade não tem
   * equipamento (vale só a planta); `null` = não achou.
   */
  private async resolveEntityEquipamentoId(type: ScopedEntityType, id: string): Promise<string | null | undefined> {
    const tabela: Partial<Record<ScopedEntityType, string>> = {
      anomalia: 'anomalias',
      tarefa: 'tarefas',
      ordem_servico: 'ordens_servico',
      programacao_os: 'programacoes_os',
      regra_log_mqtt: 'regras_logs_mqtt',
      log_mqtt: 'logs_mqtt',
      anexo_equipamento: 'anexos_equipamentos',
      solicitacao_servico: 'solicitacoes_servico',
    };
    const t = tabela[type];
    if (!t) return undefined;
    const row = await (this.prisma as any)[t]?.findFirst?.({ where: { id }, select: { equipamento_id: true } }).catch(() => null);
    if (!row) return type === 'solicitacao_servico' ? undefined : null;
    const eq = row.equipamento_id?.trim?.();
    return eq ? eq : undefined;
  }

  /**
   * Busca o planta_id "efetivo" de uma entidade do dominio.
   * Retorna null se a entidade nao existe (ou foi soft-deleted).
   */
  private async resolveEntityPlantaId(type: ScopedEntityType, id: string): Promise<string | null> {
    switch (type) {
      case 'planta': {
        const row = await this.prisma.plantas.findFirst({
          where: { id, deleted_at: null },
          select: { id: true },
        });
        return row?.id?.trim() ?? null;
      }
      case 'unidade': {
        const row = await this.prisma.unidades.findFirst({
          where: { id, deleted_at: null },
          select: { planta_id: true },
        });
        return row?.planta_id?.trim() ?? null;
      }
      case 'equipamento': {
        // equipamentos.planta_id eh nullable; fallback para unidade.planta_id
        // quando a coluna direta esta vazia.
        const row = await this.prisma.equipamentos.findFirst({
          where: { id, deleted_at: null },
          select: {
            planta_id: true,
            unidade: { select: { planta_id: true } },
          },
        });
        if (!row) return null;
        const direct = row.planta_id?.trim();
        if (direct) return direct;
        return row.unidade?.planta_id?.trim() ?? null;
      }
      case 'anomalia': {
        // anomalias.planta_id e nullable; fallback via equipamento.unidade.planta_id.
        const row = await this.prisma.anomalias.findFirst({
          where: { id, deleted_at: null },
          select: {
            planta_id: true,
            equipamento: {
              select: { planta_id: true, unidade: { select: { planta_id: true } } },
            },
          },
        });
        if (!row) return null;
        return (
          row.planta_id?.trim() ||
          row.equipamento?.planta_id?.trim() ||
          row.equipamento?.unidade?.planta_id?.trim() ||
          null
        );
      }
      case 'tarefa': {
        // tarefas.planta_id e nullable; equipamento_id eh non-nullable.
        const row = await (this.prisma as any).tarefas?.findFirst?.({
          where: { id, deleted_at: null },
          select: {
            planta_id: true,
            equipamento: {
              select: { planta_id: true, unidade: { select: { planta_id: true } } },
            },
          },
        });
        if (!row) return null;
        return (
          row.planta_id?.trim() ||
          row.equipamento?.planta_id?.trim() ||
          row.equipamento?.unidade?.planta_id?.trim() ||
          null
        );
      }
      case 'ordem_servico': {
        // ordens_servico.planta_id e nullable; fallback via equipamento.unidade.planta_id.
        const row = await (this.prisma as any).ordens_servico?.findFirst?.({
          where: { id, deleted_at: null },
          select: {
            planta_id: true,
            equipamento: {
              select: { planta_id: true, unidade: { select: { planta_id: true } } },
            },
          },
        });
        if (!row) return null;
        return (
          row.planta_id?.trim() ||
          row.equipamento?.planta_id?.trim() ||
          row.equipamento?.unidade?.planta_id?.trim() ||
          null
        );
      }
      case 'solicitacao_servico': {
        // solicitacoes_servico.planta_id eh non-nullable; sem fallback necessario.
        const row = await (this.prisma as any).solicitacoes_servico?.findFirst?.({
          where: { id, deleted_at: null },
          select: { planta_id: true },
        });
        return row?.planta_id?.trim() ?? null;
      }
      case 'programacao_os': {
        // programacoes_os.planta_id e nullable; fallback via equipamento.unidade.planta_id.
        const row = await (this.prisma as any).programacoes_os?.findFirst?.({
          where: { id, deleted_at: null },
          select: {
            planta_id: true,
            equipamento: {
              select: { planta_id: true, unidade: { select: { planta_id: true } } },
            },
          },
        });
        if (!row) return null;
        return (
          row.planta_id?.trim() ||
          row.equipamento?.planta_id?.trim() ||
          row.equipamento?.unidade?.planta_id?.trim() ||
          null
        );
      }
      case 'regra_log_mqtt': {
        // Resolvida via equipamento. equipamentos.planta_id e nullable;
        // fallback via equipamentos.unidade.planta_id.
        const row = await (this.prisma as any).regras_logs_mqtt?.findFirst?.({
          where: { id },
          select: {
            equipamento: {
              select: { planta_id: true, unidade: { select: { planta_id: true } } },
            },
          },
        });
        return (
          row?.equipamento?.planta_id?.trim() ||
          row?.equipamento?.unidade?.planta_id?.trim() ||
          null
        );
      }
      case 'anexo_equipamento': {
        // Dono resolvido pelo anexo no banco, nunca por id vindo do cliente.
        const row = await this.prisma.anexos_equipamentos.findFirst({
          where: { id, deleted_at: null },
          select: { equipamento_id: true },
        });
        if (!row?.equipamento_id) return null;
        return this.resolveEntityPlantaId('equipamento', row.equipamento_id.trim());
      }
      case 'anexo_unidade': {
        const row = await this.prisma.anexos_unidades.findFirst({
          where: { id, deleted_at: null },
          select: { unidade_id: true },
        });
        if (!row?.unidade_id) return null;
        return this.resolveEntityPlantaId('unidade', row.unidade_id.trim());
      }
      case 'log_mqtt': {
        // Resolvida via equipamento. equipamentos.planta_id e nullable;
        // fallback via equipamentos.unidade.planta_id.
        const row = await (this.prisma as any).logs_mqtt?.findFirst?.({
          where: { id },
          select: {
            equipamento: {
              select: { planta_id: true, unidade: { select: { planta_id: true } } },
            },
          },
        });
        return (
          row?.equipamento?.planta_id?.trim() ||
          row?.equipamento?.unidade?.planta_id?.trim() ||
          null
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Ownership helpers (filtros 2-nivel: scope + criador/responsavel)
  // -------------------------------------------------------------------------

  /**
   * Verifica que `entityId` pertence ao usuario (coluna de ownership) E esta no scope.
   * Util para `anomalias.manage_own` (usuario_id) e `usuarios.manage_created` (created_by).
   *
   * `entityType` indica qual tabela; `ownerColumn` qual coluna FK ao usuarios.id.
   *
   * - Se a entidade nao existe -> NotFoundException
   * - Se existe mas o owner nao bate -> ForbiddenException
   * - Tambem aplica scope de planta quando o tipo tem planta_id
   */
  async assertOwnership(
    type: 'anomalia' | 'usuario',
    entityId: string,
    user: ScopedUser | undefined,
  ): Promise<void> {
    const userId = user?.id?.trim();
    if (!userId) throw new ForbiddenException('Usuario nao autenticado');

    const id = entityId?.trim();
    if (!id) throw new NotFoundException(`${type} nao encontrado`);

    if (type === 'anomalia') {
      const row = await this.prisma.anomalias.findFirst({
        where: { id, deleted_at: null },
        select: { usuario_id: true, planta_id: true },
      });
      if (!row) throw new NotFoundException('anomalia nao encontrada');
      if (row.usuario_id?.trim() !== userId) {
        throw new ForbiddenException('Voce so pode editar anomalias que reportou');
      }
      // Scope adicional por planta (anomalias.manage_own ainda respeita o scope)
      await this.assertPlantaInScope(row.planta_id, user);
      return;
    }

    if (type === 'usuario') {
      const row = await this.prisma.usuarios.findFirst({
        where: { id, deleted_at: null },
        select: { created_by: true },
      });
      if (!row) throw new NotFoundException('usuario nao encontrado');
      if (row.created_by?.trim() !== userId) {
        throw new ForbiddenException('Voce so pode editar usuarios que criou');
      }
      return;
    }
  }
}
