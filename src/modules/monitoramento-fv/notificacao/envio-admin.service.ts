import { ForbiddenException, Injectable, BadRequestException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService, ScopedUser } from '@aupus/api-shared';

const CFG_ID = 'cfgdefault0000000000000000';
const PAPEIS_ADMIN = ['super_admin', 'admin'];

export interface DestinatarioInput {
  unidade_id?: string;
  nome?: string;
  telefone?: string;
  ativo?: boolean;
}

export interface ConfigInput {
  ativo?: boolean;
  horario?: string;
  grupo_jid?: string | null;
  enviar_grupo?: boolean;
  enviar_individual?: boolean;
}

/**
 * Administração do envio de boletim (config + destinatários). SÓ super_admin/admin —
 * é config que dispara WhatsApp pra cliente real.
 */
@Injectable()
export class EnvioAdminService {
  constructor(private readonly prisma: PrismaService) {}

  assertAdmin(user?: ScopedUser): void {
    if (!user?.role || !PAPEIS_ADMIN.includes(user.role)) {
      throw new ForbiddenException('Apenas administradores configuram o envio.');
    }
  }

  async getConfig() {
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT ativo, horario, grupo_jid, enviar_grupo, enviar_individual,
             to_char(ultimo_envio_data, 'YYYY-MM-DD') AS ultimo_envio_data
      FROM notificacao_envio_config WHERE id = ${CFG_ID} LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async updateConfig(patch: ConfigInput) {
    if (patch.horario !== undefined && !/^\d{2}:\d{2}$/.test(patch.horario)) {
      throw new BadRequestException('horario deve ser HH:MM');
    }
    await this.prisma.$executeRaw`
      UPDATE notificacao_envio_config SET
        ativo = COALESCE(${patch.ativo ?? null}, ativo),
        horario = COALESCE(${patch.horario ?? null}, horario),
        enviar_grupo = COALESCE(${patch.enviar_grupo ?? null}, enviar_grupo),
        enviar_individual = COALESCE(${patch.enviar_individual ?? null}, enviar_individual),
        updated_at = now()
      WHERE id = ${CFG_ID}
    `;
    // grupo_jid pode ser setado pra NULL explicitamente → só toca quando veio no patch.
    if (patch.grupo_jid !== undefined) {
      await this.prisma.$executeRaw`
        UPDATE notificacao_envio_config SET grupo_jid = ${patch.grupo_jid}, updated_at = now()
        WHERE id = ${CFG_ID}
      `;
    }
    return this.getConfig();
  }

  async listarDestinatarios() {
    return this.prisma.$queryRaw<any[]>`
      SELECT d.id, TRIM(d.unidade_id) AS unidade_id, TRIM(u.nome) AS unidade_nome,
             d.nome, d.telefone, d.ativo,
             to_char(d.created_at, 'YYYY-MM-DD HH24:MI') AS created_at
      FROM notificacao_destinatarios d
      LEFT JOIN unidades u ON TRIM(u.id) = TRIM(d.unidade_id)
      ORDER BY u.nome NULLS FIRST, d.nome
    `;
  }

  async criarDestinatario(d: DestinatarioInput) {
    if (!d.unidade_id?.trim()) throw new BadRequestException('usina (unidade_id) é obrigatória');
    if (!d.nome?.trim() || !d.telefone?.trim()) {
      throw new BadRequestException('nome e telefone são obrigatórios');
    }
    const id = randomBytes(13).toString('hex');
    await this.prisma.$executeRaw`
      INSERT INTO notificacao_destinatarios
        (id, unidade_id, nome, telefone, ativo, created_at, updated_at)
      VALUES (${id}, ${d.unidade_id.trim()}, ${d.nome.trim()}, ${d.telefone.trim()},
              ${d.ativo !== false}, now(), now())
    `;
    return { id };
  }

  async atualizarDestinatario(id: string, d: DestinatarioInput) {
    await this.prisma.$executeRaw`
      UPDATE notificacao_destinatarios SET
        unidade_id = COALESCE(${d.unidade_id?.trim() ?? null}, unidade_id),
        nome = COALESCE(${d.nome ?? null}, nome),
        telefone = COALESCE(${d.telefone ?? null}, telefone),
        ativo = COALESCE(${d.ativo ?? null}, ativo),
        updated_at = now()
      WHERE id = ${id}
    `;
    return { id };
  }

  async removerDestinatario(id: string) {
    await this.prisma.$executeRaw`DELETE FROM notificacao_destinatarios WHERE id = ${id}`;
    return { id };
  }
}
