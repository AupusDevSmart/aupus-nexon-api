import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService, PermissionScopeService, ScopedUser } from '@aupus/api-shared';
import { Prisma } from '@aupus/api-shared';
import type {
  IotDiagrama,
  IotDiagramaComponent,
  IotDiagramaConnection,
  IotProjetoRow,
} from './interfaces/iot-diagrama.interface';

const EMPTY_DIAGRAMA: IotDiagrama = {
  components: [],
  connections: [],
  nextId: 1,
};

const PROJETO_SELECT = {
  id: true,
  unidade_id: true,
  nome: true,
  diagrama: true,
  created_at: true,
  updated_at: true,
} as const;

/**
 * Service de projetos IoT.
 *
 * Persistencia dupla durante transicao (PR1, 2026-05):
 * - Cache JSONB em `iot_projetos.diagrama` — formato consumido pelo frontend
 *   legado iot-diagram.v2.js sem mudancas. Continua sendo a fonte do GET.
 * - Tabelas relacionais `iot_componentes` + `iot_conexoes` — base da
 *   integracao IoT <-> Diagrama Unifilar via FK iot_componentes.equipamento_id.
 *
 * Em PUT, ambos sao escritos juntos numa transacao. JSONB sera deprecated
 * apos 1-2 sprints estaveis.
 *
 * Sobre o sync delete-all+insert-all em syncRelational: simples e atomico
 * mas faz CASCADE em iot_firmwares e SET NULL em iot_dispositivos_online dos
 * componentes. Aceitavel hoje (ambas tabelas sem dados de producao). Quando
 * ganharem, trocar por delta upsert preservando IDs estaveis.
 */
@Injectable()
export class IoTService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopeService: PermissionScopeService,
  ) {}

  /** Gera um ID hex de 26 chars compativel com CHAR(26) — preserva o formato dos registros existentes. */
  private generateId(): string {
    return randomBytes(13).toString('hex');
  }

  /** Resolve unidade_id de um projeto IoT. */
  private async unidadeIdDoProjeto(projetoId: string): Promise<string | null> {
    const p = await this.prisma.iot_projetos.findFirst({
      where: { id: projetoId.trim() },
      select: { unidade_id: true },
    });
    return p?.unidade_id?.trim() ?? null;
  }

  async getProjetosByUnidade(unidadeId: string, user?: ScopedUser): Promise<IotProjetoRow[]> {
    if (user) await this.scopeService.assertEntityInScope('unidade', unidadeId.trim(), user);
    const rows = await this.prisma.iot_projetos.findMany({
      where: { unidade_id: unidadeId.trim(), deleted_at: null },
      orderBy: { created_at: 'asc' },
      select: PROJETO_SELECT,
    });
    return rows.map(this.toProjetoRow);
  }

  async getProjetoById(id: string, user?: ScopedUser): Promise<IotProjetoRow | null> {
    const row = await this.prisma.iot_projetos.findFirst({
      where: { id: id.trim(), deleted_at: null },
      select: PROJETO_SELECT,
    });
    if (!row) return null;
    if (user) await this.scopeService.assertEntityInScope('unidade', row.unidade_id.trim(), user);
    return this.toProjetoRow(row);
  }

  async createProjeto(unidadeId: string, nome: string, user?: ScopedUser): Promise<IotProjetoRow> {
    if (user) await this.scopeService.assertEntityInScope('unidade', unidadeId.trim(), user);
    const created = await this.prisma.iot_projetos.create({
      data: {
        id: this.generateId(),
        unidade_id: unidadeId.trim(),
        nome,
        diagrama: EMPTY_DIAGRAMA as unknown as Prisma.InputJsonValue,
      },
      select: PROJETO_SELECT,
    });
    return this.toProjetoRow(created);
  }

  async updateProjeto(
    id: string,
    data: { nome?: string; diagrama?: IotDiagrama },
    user?: ScopedUser,
  ): Promise<IotProjetoRow> {
    const trimmedId = id.trim();
    if (user) {
      const unidadeId = await this.unidadeIdDoProjeto(trimmedId);
      if (unidadeId) await this.scopeService.assertEntityInScope('unidade', unidadeId, user);
    }

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.iot_projetos.findFirst({
        where: { id: trimmedId, deleted_at: null },
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundException(`Projeto IoT ${trimmedId} nao encontrado`);
      }

      const updateData: Prisma.iot_projetosUpdateInput = {};
      if (data.nome !== undefined) updateData.nome = data.nome;
      if (data.diagrama !== undefined) {
        updateData.diagrama = data.diagrama as unknown as Prisma.InputJsonValue;
        updateData.view_pan_x = data.diagrama.pan?.x ?? 0;
        updateData.view_pan_y = data.diagrama.pan?.y ?? 0;
        updateData.view_zoom = data.diagrama.zoom ?? 1;
      }

      if (Object.keys(updateData).length > 0) {
        await tx.iot_projetos.update({
          where: { id: trimmedId },
          data: updateData,
        });
      }

      if (data.diagrama !== undefined) {
        await this.syncRelational(tx, trimmedId, data.diagrama);
      }

      const updated = await tx.iot_projetos.findFirst({
        where: { id: trimmedId, deleted_at: null },
        select: PROJETO_SELECT,
      });
      if (!updated) {
        throw new NotFoundException(
          `Projeto IoT ${trimmedId} desapareceu durante o update`,
        );
      }
      return this.toProjetoRow(updated);
    });
  }

  async deleteProjeto(id: string, user?: ScopedUser): Promise<void> {
    const trimmedId = id.trim();
    const existing = await this.prisma.iot_projetos.findFirst({
      where: { id: trimmedId, deleted_at: null },
      select: { id: true, unidade_id: true },
    });
    if (!existing) {
      throw new NotFoundException(`Projeto IoT ${trimmedId} nao encontrado`);
    }
    if (user) await this.scopeService.assertEntityInScope('unidade', existing.unidade_id.trim(), user);
    await this.prisma.iot_projetos.update({
      where: { id: trimmedId },
      data: { deleted_at: new Date() },
    });
  }

  /**
   * Reescreve iot_componentes + iot_conexoes do projeto a partir do diagrama.
   * Chamado dentro da transacao do updateProjeto.
   */
  private async syncRelational(
    tx: Prisma.TransactionClient,
    projetoId: string,
    diagrama: IotDiagrama,
  ): Promise<void> {
    await tx.iot_conexoes.deleteMany({ where: { projeto_id: projetoId } });
    await tx.iot_componentes.deleteMany({ where: { projeto_id: projetoId } });

    if (!Array.isArray(diagrama.components) || diagrama.components.length === 0) {
      return;
    }

    // Pre-resolve equipamento_ids via existence check em equipamentos.
    // Handles CHAR(26) padding e ids invalidos sem quebrar a transacao.
    const requestedEquipIds = new Set<string>();
    for (const comp of diagrama.components) {
      const raw = this.rawEquipamentoId(comp);
      if (raw) requestedEquipIds.add(raw);
    }
    const validEquipIds = new Set<string>();
    if (requestedEquipIds.size > 0) {
      const found = await tx.equipamentos.findMany({
        where: { id: { in: Array.from(requestedEquipIds) }, deleted_at: null },
        select: { id: true },
      });
      for (const e of found) validEquipIds.add(e.id.trim());
    }

    const idMapping = new Map<string, string>();
    for (const comp of diagrama.components) {
      const dbId = this.generateId();
      const localId = String(comp.id);
      idMapping.set(localId, dbId);

      const rawEquip = this.rawEquipamentoId(comp);
      const equipamentoId =
        rawEquip && validEquipIds.has(rawEquip) ? rawEquip : null;

      await tx.iot_componentes.create({
        data: {
          id: dbId,
          projeto_id: projetoId,
          tipo: comp.type,
          x: typeof comp.x === 'number' ? comp.x : 0,
          y: typeof comp.y === 'number' ? comp.y : 0,
          equipamento_id: equipamentoId,
          props: this.extractComponentProps(comp) as unknown as Prisma.InputJsonValue,
        },
      });
    }

    if (!Array.isArray(diagrama.connections)) return;

    for (const conn of diagrama.connections) {
      const fromRef = this.parseConnectionRef(conn.from);
      const toRef = this.parseConnectionRef(conn.to);
      if (!fromRef || !toRef) continue;

      const fromCompId = idMapping.get(fromRef.componentId);
      const toCompId = idMapping.get(toRef.componentId);
      if (!fromCompId || !toCompId) continue;

      await tx.iot_conexoes.create({
        data: {
          id: this.generateId(),
          projeto_id: projetoId,
          from_comp_id: fromCompId,
          from_port: this.truncatePort(fromRef.port),
          to_comp_id: toCompId,
          to_port: this.truncatePort(toRef.port),
          estilo: typeof conn.style === 'string' ? conn.style.slice(0, 20) : 'rs485',
        },
      });
    }
  }

  /**
   * Extrai equipamento_id bruto (texto trimado) do component.
   * NAO valida formato — validacao acontece via SELECT em equipamentos
   * dentro da transacao (lida com CHAR(26) padding e ids garbage).
   * Aceita o id em comp.props.equipamento_id ou no proprio comp.equipamento_id.
   */
  private rawEquipamentoId(comp: IotDiagramaComponent): string | null {
    const props = (comp as Record<string, unknown>).props;
    const fromProps =
      props && typeof props === 'object'
        ? (props as Record<string, unknown>).equipamento_id
        : undefined;
    const fromTop = (comp as Record<string, unknown>).equipamento_id;
    const raw = typeof fromProps === 'string' ? fromProps : fromTop;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return trimmed.length === 0 ? null : trimmed;
  }

  /** Coleta atributos custom do componente (tudo exceto id/type/x/y) para gravar em iot_componentes.props. */
  private extractComponentProps(comp: IotDiagramaComponent): Record<string, unknown> {
    const { id: _id, type: _type, x: _x, y: _y, props, ...rest } = comp;
    const merged: Record<string, unknown> = { ...rest };
    if (props && typeof props === 'object') {
      Object.assign(merged, props as Record<string, unknown>);
    }
    return merged;
  }

  /** Parse das duas formas que `connection.from`/`connection.to` aparecem no JSON. */
  private parseConnectionRef(
    ref: unknown,
  ): { componentId: string; port?: string } | null {
    if (ref === null || ref === undefined) return null;
    if (typeof ref === 'string' || typeof ref === 'number') {
      return { componentId: String(ref) };
    }
    if (typeof ref === 'object') {
      const obj = ref as Record<string, unknown>;
      const compId = obj.componentId ?? obj.id;
      if (compId === undefined || compId === null) return null;
      const port = typeof obj.port === 'string' ? obj.port : undefined;
      return { componentId: String(compId), port };
    }
    return null;
  }

  private truncatePort(port: string | undefined): string {
    if (!port) return '';
    return port.slice(0, 10);
  }

  /** Cast da linha do Prisma para o shape consumido pelo frontend. */
  private toProjetoRow = (row: {
    id: string;
    unidade_id: string;
    nome: string;
    diagrama: Prisma.JsonValue;
    created_at: Date;
    updated_at: Date;
  }): IotProjetoRow => ({
    id: row.id,
    unidade_id: row.unidade_id,
    nome: row.nome,
    diagrama: (row.diagrama ?? EMPTY_DIAGRAMA) as unknown as IotDiagrama,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}
