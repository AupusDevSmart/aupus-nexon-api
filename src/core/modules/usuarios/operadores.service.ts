import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../../mail/mail.service';
import { ClienteInfo, novoId26 } from '../../common/cliente-info';
import { PermissionScopeService } from '../auth/permission-scope.service';
import { UsuariosService } from './usuarios.service';
import { AuditoriaAcessosService } from './auditoria-acessos.service';
import { AcessoOperadorDto, CriarConviteDto } from './dto/conta-app.dto';
import { expandirPermissoes, LinhaPermissaoUnidade, resumirPermissoes } from './acesso-operador.util';

export interface Requisitante {
  id?: string;
  nome?: string;
  role?: string | null;
  permissions?: string[];
}

/** Permission que dá comando a operador legado (sem linhas por instalação). */
const PERMISSAO_COMANDO = 'equipamentos.acionar_ponto';

/**
 * Operadores dos apps NexON: lista, convite (cria o usuário inativo + link para
 * criar a senha), reenvio e acesso por instalação.
 *
 * Quem pode (decisão AUPU-70):
 * - listar/ver acesso: `usuarios.view`. Proprietário só vê os operadores que ele
 *   criou; operador não vê ninguém (lista vazia).
 * - convidar/reenviar/alterar acesso: `usuarios.create_operador` ou
 *   `usuarios.manage` — a MESMA permission que o POST /usuarios já exige para
 *   criar operador. O proprietário perdeu `usuarios.create_operador` em
 *   2026-09-10 (proprietario-monitoramento-only.sql), então hoje ele NÃO convida;
 *   se a permission voltar ao papel, ele convida só para as plantas dele (escopo).
 */
@Injectable()
export class OperadoresService {
  private readonly logger = new Logger(OperadoresService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly usuariosService: UsuariosService,
    private readonly scope: PermissionScopeService,
    private readonly mail: MailService,
    private readonly auditoria: AuditoriaAcessosService,
  ) {}

  // ==========================================================================
  // Listagem
  // ==========================================================================

  async listar(req: Requisitante) {
    const reqId = req.id?.trim() ?? '';
    if (req.role === 'operador') return [];
    const soMeus = req.role === 'proprietario';

    const usuarios = await this.prisma.$queryRaw<Array<{
      id: string; nome: string; email: string; telefone: string | null; status: string;
      is_active: boolean; created_at: Date | null; updated_at: Date | null;
      plantas_count: number; unidades_legado: number; linhas: number;
      comandar_algum: boolean | null; relatorios_algum: boolean | null;
    }>>`
      SELECT TRIM(u.id) AS id, u.nome, u.email, u.telefone, u.status, u.is_active, u.created_at, u.updated_at,
             (SELECT COUNT(*) FROM planta_operadores po
                JOIN plantas p ON p.id = po.planta_id AND p.deleted_at IS NULL
               WHERE po.usuario_id = u.id)::int AS plantas_count,
             (SELECT COUNT(*) FROM unidades un
                JOIN planta_operadores po ON po.planta_id = un.planta_id AND po.usuario_id = u.id
               WHERE un.deleted_at IS NULL)::int AS unidades_legado,
             (SELECT COUNT(*) FROM usuario_unidade_permissoes up
                JOIN unidades un ON un.id = up.unidade_id AND un.deleted_at IS NULL
               WHERE up.usuario_id = u.id)::int AS linhas,
             (SELECT bool_or(up.comandar) FROM usuario_unidade_permissoes up WHERE up.usuario_id = u.id) AS comandar_algum,
             (SELECT bool_or(up.relatorios) FROM usuario_unidade_permissoes up WHERE up.usuario_id = u.id) AS relatorios_algum
      FROM usuarios u
      WHERE u.role = 'operador' AND u.deleted_at IS NULL
        AND (${!soMeus} OR TRIM(u.created_by) = ${reqId})
      ORDER BY u.nome ASC
      LIMIT 500`;
    if (usuarios.length === 0) return [];

    const ids = usuarios.map((u) => u.id);
    const convites = await this.prisma.$queryRaw<Array<{ id: string; usuario_id: string; enviado_em: Date; expira_em: Date }>>`
      SELECT DISTINCT ON (TRIM(usuario_id)) TRIM(id) AS id, TRIM(usuario_id) AS usuario_id, enviado_em, expira_em
      FROM usuario_convites
      WHERE TRIM(usuario_id) = ANY(${ids}::text[]) AND aceito_em IS NULL AND cancelado_em IS NULL
      ORDER BY TRIM(usuario_id), enviado_em DESC`;
    const convitePorUsuario = new Map(convites.map((c) => [c.usuario_id, c]));
    const comandoLegado = await this.papelOperadorComanda();

    return usuarios.map((u) => {
      const temLinhas = Number(u.linhas) > 0;
      const c = convitePorUsuario.get(u.id);
      return {
        id: u.id,
        nome: u.nome,
        email: u.email,
        telefone: u.telefone,
        status: u.status,
        is_active: u.is_active,
        plantas_count: Number(u.plantas_count) || 0,
        unidades_count: temLinhas ? Number(u.linhas) : Number(u.unidades_legado) || 0,
        permissoes: {
          visualizar: true,
          comandar: temLinhas ? !!u.comandar_algum : comandoLegado,
          relatorios: temLinhas ? !!u.relatorios_algum : true,
        },
        convite: c ? { id: c.id, enviado_em: c.enviado_em, expira_em: c.expira_em } : null,
        // "Desativado em 12/08" (seção Sem acesso): última alteração do cadastro.
        desativado_em: u.status !== 'Ativo' && !c ? u.updated_at : null,
        created_at: u.created_at,
      };
    });
  }

  // ==========================================================================
  // Convite
  // ==========================================================================

  async convidar(dto: CriarConviteDto, req: Requisitante, cliente?: ClienteInfo) {
    const reqId = this.exigirId(req);
    const unidades = await this.carregarUnidadesNoEscopo(dto.unidade_ids, req);
    const email = dto.email.trim();

    const existente = await this.prisma.usuarios.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true, email: true, deleted_at: true },
    });
    if (existente && !existente.deleted_at) throw new ConflictException('Email já está em uso');
    if (existente?.deleted_at) {
      await this.prisma.usuarios.update({
        where: { id: existente.id },
        data: { email: `deleted_${existente.id.trim()}_${existente.email}` },
      });
    }

    const operadorRole = await this.prisma.roles.findFirst({ where: { name: 'operador' } });
    if (!operadorRole) throw new BadRequestException('Role operador não encontrada no sistema');

    // Senha aleatória inutilizável: ninguém a conhece; o acesso nasce no link.
    const senhaInutil = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
    const userId = novoId26();
    await this.prisma.usuarios.create({
      data: {
        id: userId,
        nome: dto.nome.trim(),
        email,
        telefone: dto.telefone?.trim() || null,
        status: 'Inativo', // vira 'Ativo' quando o convite é aceito (auth.resetPassword)
        role: 'operador',
        created_by: reqId,
        is_active: true,
        senha: senhaInutil,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });
    await this.usuariosService.assignRole(userId, Number(operadorRole.id));

    const linhas = expandirPermissoes(
      unidades.map((u) => u.id),
      dto.permissoes,
      dto.excecoes ?? [],
    );
    await this.gravarAcesso(userId, linhas, unidades, dto.janela ?? null, reqId, null);

    const validade = dto.validade_dias ?? 7;
    const canais = dto.canais ?? ['email'];
    const { token, hash } = await this.novoToken();
    const conviteId = novoId26();
    const expira = new Date(Date.now() + validade * 24 * 60 * 60 * 1000);
    await this.prisma.$executeRaw`
      INSERT INTO usuario_convites
        (id, usuario_id, criado_por, token_hash, canais, validade_dias, enviado_em, expira_em, created_at, updated_at)
      VALUES
        (${conviteId}, ${userId}, ${reqId}, ${hash}, ${canais}::text[], ${validade}, now(), ${expira}, now(), now())`;

    const link = this.mail.linkRedefinirSenha(token, email);
    if (canais.includes('email')) {
      this.mail
        .sendConviteOperadorEmail(email, dto.nome.trim(), link, validade, req.nome ?? null)
        .catch((e) => this.logger.warn(`[convite] email não enviado: ${e?.message}`));
    }

    await this.auditoria.registrar({
      autorId: reqId,
      alvoUsuarioId: userId,
      acao: 'convite',
      mensagem: `Operador convidado: ${dto.nome.trim()}`,
      detalhes: { canais, validade_dias: validade, acesso: resumirPermissoes(linhas), janela: dto.janela ?? null },
      plantaIds: [...new Set(unidades.map((u) => u.planta_id))],
      unidadeIds: unidades.map((u) => u.id),
      dispositivo: cliente?.dispositivo ?? null,
    });

    return { usuario: { id: userId }, convite: { id: conviteId, expira_em: expira, link } };
  }

  async reenviar(conviteId: string, req: Requisitante, cliente?: ClienteInfo) {
    const reqId = this.exigirId(req);
    const rows = await this.prisma.$queryRaw<Array<{
      id: string; usuario_id: string; canais: string[]; validade_dias: number; aceito_em: Date | null;
    }>>`
      SELECT TRIM(id) AS id, TRIM(usuario_id) AS usuario_id, canais, validade_dias, aceito_em
      FROM usuario_convites WHERE TRIM(id) = ${conviteId.trim()} AND cancelado_em IS NULL LIMIT 1`;
    const c = rows[0];
    if (!c) throw new NotFoundException('Convite não encontrado');
    if (c.aceito_em) throw new BadRequestException('Convite já aceito — o operador já criou a senha');
    const alvo = await this.assertPodeGerir(c.usuario_id, req);

    const { token, hash } = await this.novoToken();
    const validade = Number(c.validade_dias) || 7;
    const expira = new Date(Date.now() + validade * 24 * 60 * 60 * 1000);
    await this.prisma.$executeRaw`
      UPDATE usuario_convites
      SET token_hash = ${hash}, enviado_em = now(), expira_em = ${expira}, reenvios = reenvios + 1, updated_at = now()
      WHERE TRIM(id) = ${c.id}`;

    const link = this.mail.linkRedefinirSenha(token, alvo.email);
    if ((c.canais ?? []).includes('email')) {
      this.mail
        .sendConviteOperadorEmail(alvo.email, alvo.nome, link, validade, req.nome ?? null)
        .catch((e) => this.logger.warn(`[convite] email não reenviado: ${e?.message}`));
    }
    await this.auditoria.registrar({
      autorId: reqId,
      alvoUsuarioId: c.usuario_id,
      acao: 'convite_reenviado',
      mensagem: `Convite reenviado: ${alvo.nome}`,
      plantaIds: await this.plantasDoUsuario(c.usuario_id),
      dispositivo: cliente?.dispositivo ?? null,
    });
    return { usuario: { id: c.usuario_id }, convite: { id: c.id, expira_em: expira, link } };
  }

  // ==========================================================================
  // Acesso por instalação
  // ==========================================================================

  async getAcesso(usuarioId: string, req: Requisitante) {
    const id = usuarioId.trim();
    if (req.role === 'operador' && req.id?.trim() !== id) {
      throw new ForbiddenException('Você só pode consultar o seu próprio acesso');
    }
    if (req.role !== 'operador') await this.assertPodeGerir(id, req);
    return this.lerAcesso(id);
  }

  async putAcesso(usuarioId: string, dto: AcessoOperadorDto, req: Requisitante, cliente?: ClienteInfo) {
    const reqId = this.exigirId(req);
    const id = usuarioId.trim();
    const alvo = await this.assertPodeGerir(id, req);
    if (alvo.role !== 'operador') {
      throw new BadRequestException('Acesso por instalação vale só para operadores');
    }
    const antes = await this.lerAcesso(id);
    const unidades = await this.carregarUnidadesNoEscopo(dto.unidade_ids, req);
    const linhas = expandirPermissoes(unidades.map((u) => u.id), dto.permissoes, dto.excecoes ?? []);
    const escopo = await this.scope.getScope(req);
    await this.gravarAcesso(id, linhas, unidades, dto.janela ?? null, reqId, this.scope.isScoped(escopo) ? escopo : null);
    const depois = await this.lerAcesso(id);

    await this.auditoria.registrar({
      autorId: reqId,
      alvoUsuarioId: id,
      acao: 'permissoes',
      mensagem: 'Permissões alteradas',
      detalhes: { operador: alvo.nome, antes, depois },
      plantaIds: [...new Set(unidades.map((u) => u.planta_id))],
      unidadeIds: [...new Set([...antes.unidade_ids, ...depois.unidade_ids])],
      dispositivo: cliente?.dispositivo ?? null,
    });
    return depois;
  }

  // ==========================================================================
  // Internos
  // ==========================================================================

  private exigirId(req: Requisitante): string {
    const id = req.id?.trim();
    if (!id) throw new ForbiddenException('Usuário não autenticado');
    return id;
  }

  private async novoToken() {
    const token = crypto.randomBytes(32).toString('hex');
    return { token, hash: await bcrypt.hash(token, 10) };
  }

  /** O papel operador tem a permission de acionar? (comando do operador legado) */
  private async papelOperadorComanda(): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ ok: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM role_has_permissions rhp
        JOIN roles r ON r.id = rhp.role_id AND r.name = 'operador'
        JOIN permissions p ON p.id = rhp.permission_id AND p.name = ${PERMISSAO_COMANDO}
      ) AS ok`;
    return !!rows[0]?.ok;
  }

  /**
   * Quem pode gerir o alvo: admin-like (sem escopo) qualquer um; proprietário
   * (ou outro papel escopado) só quem ele criou.
   */
  private async assertPodeGerir(usuarioId: string, req: Requisitante) {
    const alvo = await this.prisma.usuarios.findFirst({
      where: { id: usuarioId.trim(), deleted_at: null },
      select: { id: true, nome: true, email: true, role: true, created_by: true },
    });
    if (!alvo) throw new NotFoundException('Usuário não encontrado');
    const escopo = await this.scope.getScope(req);
    if (this.scope.isScoped(escopo) && alvo.created_by?.trim() !== req.id?.trim()) {
      throw new ForbiddenException('Você só pode gerir operadores que criou');
    }
    return alvo;
  }

  /** Carrega as unidades pedidas e confere que todas existem e estão no escopo. */
  private async carregarUnidadesNoEscopo(ids: string[], req: Requisitante) {
    const limpos = [...new Set(ids.map((x) => x.trim()).filter(Boolean))];
    if (limpos.length === 0) throw new BadRequestException('Selecione ao menos uma instalação');
    const unidades = await this.prisma.unidades.findMany({
      where: { id: { in: limpos }, deleted_at: null },
      select: { id: true, planta_id: true },
    });
    const achadas = new Set(unidades.map((u) => u.id.trim()));
    const faltam = limpos.filter((x) => !achadas.has(x));
    if (faltam.length) throw new BadRequestException(`Instalação não encontrada: ${faltam.join(', ')}`);
    const escopo = await this.scope.getScope(req);
    if (this.scope.isScoped(escopo)) {
      const fora = unidades.filter((u) => !escopo.includes(u.planta_id.trim()));
      if (fora.length) throw new ForbiddenException('Instalação fora do seu escopo');
    }
    return unidades.map((u) => ({ id: u.id.trim(), planta_id: u.planta_id.trim() }));
  }

  /**
   * Regrava o acesso: linhas por unidade + vínculo planta_operadores (plantas das
   * unidades escolhidas) + janela. `escopo` (plantas do requisitante escopado)
   * limita o que é apagado; null = pode apagar tudo do alvo.
   */
  private async gravarAcesso(
    usuarioId: string,
    linhas: LinhaPermissaoUnidade[],
    unidades: Array<{ id: string; planta_id: string }>,
    janela: { inicio: string; fim: string; dias: number[] } | null,
    autorId: string,
    escopo: string[] | null,
  ) {
    const plantasNovas = [...new Set(unidades.map((u) => u.planta_id))];
    const idsUnidades = linhas.map((l) => l.unidade_id);
    const janelaJson = janela ? JSON.stringify({ inicio: janela.inicio, fim: janela.fim, dias: janela.dias }) : null;

    await this.prisma.$transaction(async (tx) => {
      // 1) linhas por unidade: apaga as que saíram (dentro do escopo) e upserta as novas.
      if (escopo) {
        await tx.$executeRaw`
          DELETE FROM usuario_unidade_permissoes up
          USING unidades un
          WHERE up.unidade_id = un.id AND TRIM(up.usuario_id) = ${usuarioId}
            AND TRIM(un.planta_id) = ANY(${escopo}::text[])
            AND NOT (TRIM(up.unidade_id) = ANY(${idsUnidades}::text[]))`;
      } else {
        await tx.$executeRaw`
          DELETE FROM usuario_unidade_permissoes
          WHERE TRIM(usuario_id) = ${usuarioId} AND NOT (TRIM(unidade_id) = ANY(${idsUnidades}::text[]))`;
      }
      for (const l of linhas) {
        await tx.$executeRaw`
          INSERT INTO usuario_unidade_permissoes (usuario_id, unidade_id, comandar, relatorios, updated_by, created_at, updated_at)
          VALUES (${usuarioId}, ${l.unidade_id}, ${l.comandar}, ${l.relatorios}, ${autorId}, now(), now())
          ON CONFLICT (usuario_id, unidade_id) DO UPDATE SET
            comandar = EXCLUDED.comandar, relatorios = EXCLUDED.relatorios,
            updated_by = EXCLUDED.updated_by, updated_at = now()`;
      }

      // 2) planta_operadores: vincula as plantas escolhidas; desvincula (no escopo)
      //    as que ficaram sem nenhuma instalação selecionada.
      for (const plantaId of plantasNovas) {
        await tx.$executeRaw`
          INSERT INTO planta_operadores (planta_id, usuario_id, created_at, updated_at)
          VALUES (${plantaId}, ${usuarioId}, now(), now())
          ON CONFLICT (planta_id, usuario_id) DO NOTHING`;
      }
      if (escopo) {
        await tx.$executeRaw`
          DELETE FROM planta_operadores
          WHERE TRIM(usuario_id) = ${usuarioId}
            AND TRIM(planta_id) = ANY(${escopo}::text[])
            AND NOT (TRIM(planta_id) = ANY(${plantasNovas}::text[]))`;
      } else {
        await tx.$executeRaw`
          DELETE FROM planta_operadores
          WHERE TRIM(usuario_id) = ${usuarioId} AND NOT (TRIM(planta_id) = ANY(${plantasNovas}::text[]))`;
      }

      // 3) janela de comando (NULL = sem restrição).
      await tx.$executeRaw`UPDATE usuarios SET cmd_janela = ${janelaJson}::jsonb, updated_at = now() WHERE TRIM(id) = ${usuarioId}`;
    });
  }

  private async lerAcesso(usuarioId: string) {
    const linhas = await this.prisma.$queryRaw<LinhaPermissaoUnidade[]>`
      SELECT TRIM(up.unidade_id) AS unidade_id, up.comandar, up.relatorios
      FROM usuario_unidade_permissoes up
      JOIN unidades un ON un.id = up.unidade_id AND un.deleted_at IS NULL
      WHERE TRIM(up.usuario_id) = ${usuarioId}
      ORDER BY un.nome`;
    const janelaRows = await this.prisma.$queryRaw<Array<{ cmd_janela: any }>>`
      SELECT cmd_janela FROM usuarios WHERE TRIM(id) = ${usuarioId} LIMIT 1`;
    const janela = janelaRows[0]?.cmd_janela ?? null;

    if (linhas.length > 0) {
      return { ...resumirPermissoes(linhas), janela, origem: 'por_instalacao' as const };
    }
    // Operador legado (só planta_operadores): todas as unidades das plantas vinculadas.
    const legado = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT TRIM(un.id) AS id FROM unidades un
      JOIN planta_operadores po ON po.planta_id = un.planta_id
      WHERE TRIM(po.usuario_id) = ${usuarioId} AND un.deleted_at IS NULL
      ORDER BY un.nome`;
    return {
      unidade_ids: legado.map((u) => u.id),
      permissoes: { visualizar: true as const, comandar: await this.papelOperadorComanda(), relatorios: true },
      excecoes: [],
      janela,
      origem: 'planta' as const,
    };
  }

  private async plantasDoUsuario(usuarioId: string): Promise<string[]> {
    const rows = await this.prisma.planta_operadores.findMany({
      where: { usuario_id: usuarioId.trim() },
      select: { planta_id: true },
    });
    return rows.map((r) => r.planta_id.trim());
  }
}
