import { Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '@aupus/api-shared';
import type {
  IotDiagrama,
  IotProjetoRow,
} from './interfaces/iot-diagrama.interface';

const EMPTY_DIAGRAMA: IotDiagrama = {
  components: [],
  connections: [],
  nextId: 1,
};

/**
 * Service de projetos IoT.
 *
 * A tabela `iot_projetos` NAO esta declarada em `api-shared/prisma/schema.prisma`
 * porque eh gerenciada por `/var/www/iot_nexon/` (sistema externo que compartilha
 * o mesmo Postgres). Logo, todas as operacoes usam queries raw do Prisma.
 *
 * Schema esperado da tabela:
 *   id          CHAR(26)    PRIMARY KEY
 *   unidade_id  CHAR(26)    NOT NULL
 *   nome        VARCHAR     NOT NULL
 *   diagrama    JSONB       NOT NULL
 *   created_at  TIMESTAMP   NOT NULL
 *   updated_at  TIMESTAMP   NOT NULL
 *   deleted_at  TIMESTAMP   NULL    (soft delete)
 */
@Injectable()
export class IoTService {
  constructor(private readonly prisma: PrismaService) {}

  /** Gera um ID hex de 26 chars (compativel com CHAR(26) usado em iot_projetos.id). */
  private generateId(): string {
    return randomBytes(13).toString('hex');
  }

  async getProjetosByUnidade(unidadeId: string): Promise<IotProjetoRow[]> {
    return this.prisma.$queryRaw<IotProjetoRow[]>`
      SELECT id, unidade_id, nome, diagrama, created_at, updated_at
      FROM iot_projetos
      WHERE unidade_id = ${unidadeId} AND deleted_at IS NULL
      ORDER BY created_at ASC
    `;
  }

  async getProjetoById(id: string): Promise<IotProjetoRow | null> {
    const rows = await this.prisma.$queryRaw<IotProjetoRow[]>`
      SELECT id, unidade_id, nome, diagrama, created_at, updated_at
      FROM iot_projetos
      WHERE id = ${id} AND deleted_at IS NULL
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async createProjeto(
    unidadeId: string,
    nome: string,
  ): Promise<IotProjetoRow> {
    const id = this.generateId();
    await this.prisma.$executeRaw`
      INSERT INTO iot_projetos (id, unidade_id, nome, diagrama, created_at, updated_at)
      VALUES (
        ${id},
        ${unidadeId},
        ${nome},
        ${JSON.stringify(EMPTY_DIAGRAMA)}::jsonb,
        NOW(),
        NOW()
      )
    `;
    const created = await this.getProjetoById(id);
    if (!created) {
      // INSERT confirmado mas SELECT nao retornou — caso patologico (deleted_at preenchido por trigger?).
      throw new NotFoundException(
        `Projeto IoT recem-criado nao foi encontrado (id=${id})`,
      );
    }
    return created;
  }

  async updateProjeto(
    id: string,
    data: { nome?: string; diagrama?: IotDiagrama },
  ): Promise<IotProjetoRow> {
    const existing = await this.getProjetoById(id);
    if (!existing) {
      throw new NotFoundException(`Projeto IoT ${id} nao encontrado`);
    }

    if (data.nome !== undefined && data.diagrama !== undefined) {
      await this.prisma.$executeRaw`
        UPDATE iot_projetos
        SET nome = ${data.nome},
            diagrama = ${JSON.stringify(data.diagrama)}::jsonb,
            updated_at = NOW()
        WHERE id = ${id} AND deleted_at IS NULL
      `;
    } else if (data.nome !== undefined) {
      await this.prisma.$executeRaw`
        UPDATE iot_projetos
        SET nome = ${data.nome}, updated_at = NOW()
        WHERE id = ${id} AND deleted_at IS NULL
      `;
    } else if (data.diagrama !== undefined) {
      await this.prisma.$executeRaw`
        UPDATE iot_projetos
        SET diagrama = ${JSON.stringify(data.diagrama)}::jsonb, updated_at = NOW()
        WHERE id = ${id} AND deleted_at IS NULL
      `;
    }
    // Se nada foi enviado, retorna o estado atual (sem modificacao).
    const updated = await this.getProjetoById(id);
    if (!updated) {
      throw new NotFoundException(`Projeto IoT ${id} nao encontrado apos update`);
    }
    return updated;
  }

  async deleteProjeto(id: string): Promise<void> {
    const existing = await this.getProjetoById(id);
    if (!existing) {
      throw new NotFoundException(`Projeto IoT ${id} nao encontrado`);
    }
    await this.prisma.$executeRaw`
      UPDATE iot_projetos SET deleted_at = NOW() WHERE id = ${id}
    `;
  }
}
