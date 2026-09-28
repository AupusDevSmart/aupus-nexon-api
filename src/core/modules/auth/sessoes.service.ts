import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ClienteInfo, novoId26 } from '../../common/cliente-info';
import {
  avaliarRefresh,
  hashJti,
  novoJti,
  ResultadoRefresh,
  SessaoParaRotacao,
  VALIDADE_REFRESH_MS,
} from './sessao-rotacao';

interface SessaoRow extends SessaoParaRotacao {
  id: string;
  usuario_id: string;
  dispositivo: string | null;
  plataforma: string | null;
  ip: string | null;
  cidade: string | null;
  created_at: Date;
  last_used_at: Date;
}

/**
 * Sessões de login (tabela auth_sessoes, SQL cru — ver
 * db/manual-migrations/2026-09-28_3-auth-sessoes.sql).
 *
 * Tolerante à ausência da tabela: se o SQL ainda não rodou, `criar` devolve
 * null e o login segue sem sid (comportamento legado). Assim o deploy do código
 * antes do SQL não derruba o login.
 */
@Injectable()
export class SessoesService {
  private readonly logger = new Logger(SessoesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Cria a sessão e devolve { sid, jti } para o refresh token (ou null se a tabela não existe). */
  async criar(usuarioId: string, cliente?: ClienteInfo | null): Promise<{ sid: string; jti: string } | null> {
    const sid = novoId26();
    const jti = novoJti();
    const expira = new Date(Date.now() + VALIDADE_REFRESH_MS);
    try {
      await this.prisma.$executeRaw`
        INSERT INTO auth_sessoes
          (id, usuario_id, refresh_jti_hash, dispositivo, plataforma, user_agent, ip, created_at, last_used_at, expira_em)
        VALUES
          (${sid}, ${usuarioId.trim()}, ${hashJti(jti)}, ${cliente?.dispositivo ?? null}, ${cliente?.plataforma ?? null},
           ${cliente?.userAgent ?? null}, ${cliente?.ip ?? null}, now(), now(), ${expira})`;
      return { sid, jti };
    } catch (e) {
      this.logger.warn(`[sessoes] não criou sessão (tabela ausente?): ${(e as Error).message}`);
      return null;
    }
  }

  private async buscar(sid: string): Promise<SessaoRow | null> {
    const rows = await this.prisma.$queryRaw<SessaoRow[]>`
      SELECT TRIM(id) AS id, TRIM(usuario_id) AS usuario_id, refresh_jti_hash, refresh_jti_anterior_hash,
             rotacionado_em, expira_em, revoked_at, dispositivo, plataforma, ip, cidade, created_at, last_used_at
      FROM auth_sessoes WHERE TRIM(id) = ${sid.trim()} LIMIT 1`;
    return rows[0] ?? null;
  }

  /**
   * Valida o refresh (sid + jti) e ROTACIONA. Devolve o jti novo, ou o motivo
   * da recusa. Também atualiza last_used_at / ip / aparelho.
   */
  async rotacionar(
    sid: string,
    usuarioId: string,
    jti: string | undefined,
    cliente?: ClienteInfo | null,
  ): Promise<{ resultado: ResultadoRefresh; jti?: string }> {
    const sessao = await this.buscar(sid).catch(() => null);
    if (sessao && sessao.usuario_id !== usuarioId.trim()) return { resultado: 'revogada' };
    const resultado = avaliarRefresh(sessao, jti);
    if (resultado !== 'ok' && resultado !== 'ok_graca') {
      if (resultado === 'reuso') this.logger.warn(`[sessoes] refresh com jti velho na sessão ${sid}`);
      return { resultado };
    }
    const novo = novoJti();
    const expira = new Date(Date.now() + VALIDADE_REFRESH_MS);
    await this.prisma.$executeRaw`
      UPDATE auth_sessoes
      SET refresh_jti_anterior_hash = refresh_jti_hash,
          refresh_jti_hash = ${hashJti(novo)},
          rotacionado_em = now(),
          last_used_at = now(),
          expira_em = ${expira},
          ip = COALESCE(${cliente?.ip ?? null}, ip),
          dispositivo = COALESCE(${cliente?.aparelho ? cliente.dispositivo : null}, dispositivo)
      WHERE TRIM(id) = ${sid.trim()}`;
    return { resultado, jti: novo };
  }

  async listar(usuarioId: string, sidAtual?: string | null) {
    // Tabela ausente (SQL 2026-09-28_3 não aplicado) → 404: o app esconde a seção.
    const rows = await this.prisma.$queryRaw<SessaoRow[]>`
      SELECT TRIM(id) AS id, TRIM(usuario_id) AS usuario_id, refresh_jti_hash, refresh_jti_anterior_hash,
             rotacionado_em, expira_em, revoked_at, dispositivo, plataforma, ip, cidade, created_at, last_used_at
      FROM auth_sessoes
      WHERE TRIM(usuario_id) = ${usuarioId.trim()} AND revoked_at IS NULL AND expira_em > now()
      ORDER BY last_used_at DESC
      LIMIT 50`.catch((e: Error) => {
      if (/does not exist/i.test(e?.message ?? '')) throw new NotFoundException('Sessões indisponíveis neste servidor');
      throw e;
    });
    return rows.map((r) => ({
      id: r.id,
      dispositivo: r.dispositivo ?? 'Aparelho desconhecido',
      plataforma: r.plataforma,
      cidade: r.cidade,
      ip: r.ip,
      created_at: r.created_at,
      last_used_at: r.last_used_at,
      atual: !!sidAtual && r.id === sidAtual.trim(),
    }));
  }

  async revogar(usuarioId: string, sid: string): Promise<{ ok: true }> {
    const n = await this.prisma.$executeRaw`
      UPDATE auth_sessoes SET revoked_at = now()
      WHERE TRIM(id) = ${sid.trim()} AND TRIM(usuario_id) = ${usuarioId.trim()} AND revoked_at IS NULL`;
    if (!n) throw new NotFoundException('Sessão não encontrada');
    return { ok: true };
  }

  /** Encerra todas as sessões do usuário, menos `exceto` (a atual). */
  async revogarOutras(usuarioId: string, exceto?: string | null): Promise<{ encerradas: number }> {
    const ex = exceto?.trim() || '';
    try {
      const n = await this.prisma.$executeRaw`
        UPDATE auth_sessoes SET revoked_at = now()
        WHERE TRIM(usuario_id) = ${usuarioId.trim()} AND revoked_at IS NULL AND TRIM(id) <> ${ex}`;
      return { encerradas: Number(n) };
    } catch (e) {
      this.logger.warn(`[sessoes] revogarOutras falhou: ${(e as Error).message}`);
      return { encerradas: 0 };
    }
  }

  exigirOutras(outras: unknown): void {
    if (String(outras) !== 'true') {
      throw new BadRequestException('Use DELETE /auth/sessions?outras=true para encerrar as outras sessões');
    }
  }
}
