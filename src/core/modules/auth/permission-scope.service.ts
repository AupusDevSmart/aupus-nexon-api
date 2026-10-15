import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

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
export const PAPEIS_SEM_ESCOPO: readonly string[] = ['super_admin', 'admin', 'gerente', 'analista'];

/** Normaliza o nome do papel: minusculo, sem espacos, e corrige o typo historico 'propietario'. */
export function normalizarPapel(role?: string | null): string {
  const r = String(role ?? '').trim().toLowerCase();
  return r === 'propietario' ? 'proprietario' : r;
}

/** true quando o papel e administrativo (exporta/ve tudo). */
export function isPapelSemEscopo(role?: string | null): boolean {
  return PAPEIS_SEM_ESCOPO.includes(normalizarPapel(role));
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
 * - operador     -> plantas vinculadas via planta_operadores
 * - proprietario -> plantas onde plantas.proprietario_id = userId ('propietario' idem)
 * - qualquer outro papel (ou sem papel) -> uniao dos dois vinculos acima; sem vinculo = []
 *
 * Convencao de resposta a recurso fora do escopo: ForbiddenException (consistente
 * em todos os modulos; ver docs/RBAC-SCOPE.md).
 */
@Injectable()
export class PermissionScopeService {
  constructor(private prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Resolucao do scope
  // -------------------------------------------------------------------------

  async getPlantasDoUsuario(userId: string, roleName?: string | null): Promise<PlantaScope> {
    const id = userId?.trim();
    if (!id) return null;

    const papel = normalizarPapel(roleName);
    if (PAPEIS_SEM_ESCOPO.includes(papel)) return null;

    const comoOperador = async () =>
      (
        await this.prisma.planta_operadores.findMany({
          where: { usuario_id: id },
          select: { planta_id: true },
        })
      ).map((r) => r.planta_id.trim());

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
