import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { novoId26 } from '../../common/cliente-info';
import { UsuariosService } from './usuarios.service';
import { AtualizarMeDto, PreferenciasNotificacaoDto, RegistrarDispositivoPushDto } from './dto/conta-app.dto';

export interface PreferenciasNotificacao {
  alarmes_criticos: boolean;
  alarmes_atencao: boolean;
  comandos: boolean;
  resumo_diario: boolean;
}

export const PREFERENCIAS_PADRAO: PreferenciasNotificacao = {
  alarmes_criticos: true,
  alarmes_atencao: true,
  comandos: false,
  resumo_diario: false,
};

/**
 * "Minha conta" dos apps NexON: perfil, preferências de notificação e tokens de
 * push. Tudo sobre o PRÓPRIO usuário (id vem do JWT, nunca da URL).
 */
@Injectable()
export class ContaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usuariosService: UsuariosService,
  ) {}

  /** PATCH /usuarios/me — nome, telefone, email (email único). */
  async atualizarMe(userId: string, dto: AtualizarMeDto) {
    const id = userId.trim();
    const atual = await this.prisma.usuarios.findFirst({ where: { id, deleted_at: null } });
    if (!atual) throw new NotFoundException('Usuário não encontrado');

    const data: Record<string, unknown> = {};
    if (dto.nome !== undefined) data.nome = dto.nome.trim();
    if (dto.telefone !== undefined) data.telefone = dto.telefone.trim() || null;
    if (dto.email !== undefined) {
      // Sem lowercase: o login casa o email exatamente como foi gravado.
      const email = dto.email.trim();
      if (email !== atual.email) {
        const dono = await this.prisma.usuarios.findFirst({
          where: { email: { equals: email, mode: 'insensitive' }, id: { not: id } },
          select: { id: true, deleted_at: true, email: true },
        });
        if (dono && !dono.deleted_at) throw new ConflictException('Email já está em uso');
        if (dono?.deleted_at) {
          // Mesmo tratamento do create: libera o email de conta excluída.
          await this.prisma.usuarios.update({
            where: { id: dono.id },
            data: { email: `deleted_${dono.id.trim()}_${dono.email}` },
          });
        }
        data.email = email;
      }
    }
    if (Object.keys(data).length > 0) {
      data.updated_at = new Date();
      await this.prisma.usuarios.update({ where: { id }, data });
    }
    const usuario = await this.usuariosService.findOne(id);
    return { ...usuario, senha_alterada_em: await this.usuariosService.getSenhaAlteradaEm(id) };
  }

  async getNotificacoes(userId: string): Promise<PreferenciasNotificacao> {
    const rows = await this.prisma.$queryRaw<PreferenciasNotificacao[]>`
      SELECT alarmes_criticos, alarmes_atencao, comandos, resumo_diario
      FROM usuario_notificacoes WHERE TRIM(usuario_id) = ${userId.trim()} LIMIT 1`;
    return rows[0] ?? { ...PREFERENCIAS_PADRAO };
  }

  async putNotificacoes(userId: string, dto: PreferenciasNotificacaoDto): Promise<PreferenciasNotificacao> {
    const p = { ...(await this.getNotificacoes(userId)), ...stripUndefined(dto) } as PreferenciasNotificacao;
    await this.prisma.$executeRaw`
      INSERT INTO usuario_notificacoes (usuario_id, alarmes_criticos, alarmes_atencao, comandos, resumo_diario, updated_at)
      VALUES (${userId.trim()}, ${p.alarmes_criticos}, ${p.alarmes_atencao}, ${p.comandos}, ${p.resumo_diario}, now())
      ON CONFLICT (usuario_id) DO UPDATE SET
        alarmes_criticos = EXCLUDED.alarmes_criticos,
        alarmes_atencao  = EXCLUDED.alarmes_atencao,
        comandos         = EXCLUDED.comandos,
        resumo_diario    = EXCLUDED.resumo_diario,
        updated_at       = now()`;
    return p;
  }

  /** Upsert pelo token: se o aparelho trocou de usuário, o token muda de dono. */
  async registrarDispositivo(userId: string, dto: RegistrarDispositivoPushDto) {
    const token = dto.token.trim();
    await this.prisma.$executeRaw`
      INSERT INTO dispositivos_push (id, usuario_id, plataforma, token, created_at, updated_at)
      VALUES (${novoId26()}, ${userId.trim()}, ${dto.plataforma}, ${token}, now(), now())
      ON CONFLICT (token) DO UPDATE SET
        usuario_id = EXCLUDED.usuario_id,
        plataforma = EXCLUDED.plataforma,
        updated_at = now()`;
    return { ok: true, plataforma: dto.plataforma };
  }

  async removerDispositivo(userId: string, token: string) {
    const n = await this.prisma.$executeRaw`
      DELETE FROM dispositivos_push WHERE token = ${token.trim()} AND TRIM(usuario_id) = ${userId.trim()}`;
    return { ok: true, removidos: Number(n) };
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;
}
