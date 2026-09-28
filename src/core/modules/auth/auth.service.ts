import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsuariosService } from '../usuarios/usuarios.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../../mail/mail.service';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { LoginDto } from './dto/login.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordWithTokenDto } from './dto/reset-password.dto';
import { SessoesService } from './sessoes.service';
import { ClienteInfo } from '../../common/cliente-info';

/** Validade do link de redefinição de senha, em minutos. */
const RESET_TOKEN_EXP_MINUTES = 60;

/**
 * Serviço de autenticação
 * Responsável por gerenciar login, validação de credenciais e geração de tokens JWT
 */
@Injectable()
export class AuthService {
  constructor(
    private usuariosService: UsuariosService,
    private jwtService: JwtService,
    private prisma: PrismaService,
    private mailService: MailService,
    private sessoes: SessoesService,
  ) {}

  /**
   * Valida as credenciais do usuário
   * @param email Email do usuário
   * @param senha Senha em texto plano
   * @returns Dados do usuário (sem senha) se válido
   * @throws UnauthorizedException se credenciais inválidas
   * @throws ForbiddenException se usuário inativo
   */
  async validateUser(email: string, senha: string): Promise<any> {
    console.log(`🔐 [AUTH] Validando credenciais para: ${email}`);

    // Buscar usuário por email
    const usuario = await this.usuariosService.findByEmail(email);

    if (!usuario) {
      console.log(`❌ [AUTH] Usuário não encontrado: ${email}`);
      throw new UnauthorizedException('Email ou senha inválidos');
    }

    // Verificar se o usuário está ativo
    if (usuario.status !== 'Ativo' || !usuario.is_active || usuario.deleted_at) {
      console.log(`🚫 [AUTH] Usuário inativo: ${email}`);
      throw new ForbiddenException(
        'Usuário inativo. Entre em contato com o administrador.',
      );
    }

    // Verificar se o usuário tem senha definida
    if (!usuario.senha) {
      console.log(`⚠️ [AUTH] Usuário sem senha definida: ${email}`);
      throw new BadRequestException(
        'Usuário não possui senha definida. Entre em contato com o administrador.',
      );
    }

    // Verificar a senha
    const senhaValida = await bcrypt.compare(senha, usuario.senha);

    if (!senhaValida) {
      console.log(`❌ [AUTH] Senha inválida para: ${email}`);
      throw new UnauthorizedException('Email ou senha inválidos');
    }

    console.log(`✅ [AUTH] Credenciais válidas para: ${email}`);

    // Remove senha do objeto antes de retornar
    const { senha: _, ...result } = usuario;
    return result;
  }

  /**
   * Realiza login e retorna tokens JWT
   * @param loginDto Credenciais de login
   * @returns Tokens de acesso e dados do usuário
   */
  async login(loginDto: LoginDto, cliente?: ClienteInfo): Promise<AuthResponseDto> {
    console.log(`🚀 [AUTH] Iniciando login para: ${loginDto.email}`);

    // Validar credenciais
    const usuario = await this.validateUser(loginDto.email, loginDto.senha);

    // Buscar permissões completas do usuário
    const permissoes = await this.usuariosService
      .getUserPermissions(usuario.id)
      .catch((error) => {
        console.error(
          `⚠️ [AUTH] Erro ao buscar permissões do usuário ${usuario.id}:`,
          error,
        );
        return {
          role: null,
          permissions: [],
          permissionNames: [],
        };
      });

    // Sessão (auth_sessoes): sid vai no access E no refresh token. Se a tabela
    // ainda não existe (SQL não aplicado), segue sem sid — comportamento legado.
    const sessao = await this.sessoes.criar(usuario.id, cliente);

    // Payload do JWT
    const payload = {
      sub: usuario.id,
      email: usuario.email,
      nome: usuario.nome,
      role: permissoes.role?.name || null,
      permissions: permissoes.permissionNames || [],
      ...(sessao ? { sid: sessao.sid } : {}),
    };

    console.log(`🔑 [AUTH] Gerando tokens para usuário: ${usuario.id}`);

    // Gerar access token (1 hora)
    const access_token = this.jwtService.sign(payload, { expiresIn: '1h' });

    // Gerar refresh token (7 dias)
    const refresh_token = this.jwtService.sign(
      { sub: usuario.id, type: 'refresh', ...(sessao ? { sid: sessao.sid, jti: sessao.jti } : {}) },
      { expiresIn: '7d' },
    );

    console.log(`✅ [AUTH] Login bem-sucedido para: ${loginDto.email}`);

    // Buscar dados completos do usuário para retornar
    const usuarioCompleto = await this.usuariosService
      .findOne(usuario.id)
      .catch((error) => {
        console.error(
          `⚠️ [AUTH] Erro ao buscar dados completos do usuário:`,
          error,
        );
        // Fallback com dados básicos
        return {
          ...usuario,
          all_permissions: permissoes.permissions || [],
          role_details: permissoes.role || null,
        };
      });

    // Anexar role + permissoes + plantas para o frontend (PermissionsContext)
    const plantas_vinculadas = await this.getPlantasAcessiveis(usuario.id, permissoes.role?.name);
    (usuarioCompleto as any).role = permissoes.role?.name ?? null;
    (usuarioCompleto as any).role_details = permissoes.role;
    (usuarioCompleto as any).all_permissions = permissoes.permissionNames;
    (usuarioCompleto as any).plantas_vinculadas = plantas_vinculadas;
    (usuarioCompleto as any).senha_alterada_em = await this.usuariosService.getSenhaAlteradaEm(usuario.id);

    console.log(`📦 [AUTH] Dados do usuário para retornar:`, {
      id: usuarioCompleto.id,
      nome: usuarioCompleto.nome,
      email: usuarioCompleto.email,
      has_all_permissions: !!usuarioCompleto.all_permissions,
      permissions_count: usuarioCompleto.all_permissions?.length || 0,
    });

    return {
      access_token,
      refresh_token,
      token_type: 'Bearer',
      expires_in: 3600, // 1 hora em segundos
      user: usuarioCompleto as any,
    };
  }

  /**
   * Renova o access token usando refresh token
   * @param refreshToken Refresh token JWT
   * @returns Novos access e refresh tokens
   * @throws UnauthorizedException se token inválido
   */
  async refreshToken(
    refreshToken: string,
    cliente?: ClienteInfo,
  ): Promise<{ access_token: string; refresh_token: string; token_type: string; expires_in: number }> {
    console.log(`🔄 [AUTH] Renovando token...`);

    try {
      // Verificar e decodificar o refresh token
      const payload = this.jwtService.verify(refreshToken);

      // Validar que é realmente um refresh token
      if (payload.type !== 'refresh') {
        console.log(`❌ [AUTH] Token fornecido não é um refresh token`);
        throw new UnauthorizedException('Token inválido');
      }

      // Buscar usuário
      const usuario = await this.usuariosService
        .findOne(payload.sub)
        .catch(() => null);

      if (!usuario) {
        console.log(`❌ [AUTH] Usuário não encontrado para token: ${payload.sub}`);
        throw new UnauthorizedException('Usuário não encontrado');
      }

      // Verificar se usuário está ativo
      if (usuario.status !== 'Ativo') {
        console.log(`🚫 [AUTH] Usuário inativo no refresh: ${payload.sub}`);
        throw new UnauthorizedException('Usuário inativo ou inválido');
      }

      // Buscar permissões atualizadas
      const permissoes = await this.usuariosService
        .getUserPermissions(usuario.id)
        .catch((error) => {
          console.error(`⚠️ [AUTH] Erro ao buscar permissões:`, error);
          return {
            role: null,
            permissions: [],
            permissionNames: [],
          };
        });

      // Sessão: token COM sid precisa de sessão viva e rotaciona o jti; token
      // SEM sid (legado, antes das sessões) continua valendo e ganha uma sessão.
      let sid: string | null = null;
      let jti: string | null = null;
      if (payload.sid) {
        const r = await this.sessoes.rotacionar(String(payload.sid), usuario.id, payload.jti, cliente);
        if (!r.jti) {
          console.log(`🚫 [AUTH] Refresh recusado (sessão ${payload.sid}: ${r.resultado})`);
          throw new UnauthorizedException(
            r.resultado === 'revogada' ? 'Sessão encerrada. Entre novamente.' : 'Refresh token inválido ou expirado',
          );
        }
        sid = String(payload.sid);
        jti = r.jti;
      } else {
        const nova = await this.sessoes.criar(usuario.id, cliente);
        if (nova) {
          sid = nova.sid;
          jti = nova.jti;
        }
      }

      // Criar novo payload com dados atualizados
      const newPayload = {
        sub: usuario.id,
        email: usuario.email,
        nome: usuario.nome,
        role: permissoes.role?.name || null,
        permissions: permissoes.permissionNames || [],
        ...(sid ? { sid } : {}),
      };

      // Gerar novos tokens
      const access_token = this.jwtService.sign(newPayload, {
        expiresIn: '1h',
      });

      const refresh_token = this.jwtService.sign(
        { sub: usuario.id, type: 'refresh', ...(sid ? { sid, jti } : {}) },
        { expiresIn: '7d' },
      );

      console.log(`✅ [AUTH] Token renovado com sucesso para: ${usuario.id}`);

      return {
        access_token,
        refresh_token,
        token_type: 'Bearer',
        expires_in: 3600,
      };
    } catch (error) {
      console.error(`❌ [AUTH] Erro ao renovar token:`, error.message);

      if (error instanceof UnauthorizedException) {
        throw error;
      }

      throw new UnauthorizedException('Refresh token inválido ou expirado');
    }
  }

  /**
   * Retorna dados do usuário atual autenticado, com role, permissoes e plantas vinculadas.
   * Usado pelo frontend para carregar o PermissionsContext no login/refresh.
   */
  async getCurrentUser(userId: string) {
    console.log(`👤 [AUTH] Buscando dados do usuário: ${userId}`);

    const usuario = await this.usuariosService.findOne(userId).catch(() => null);

    if (!usuario) {
      console.log(`❌ [AUTH] Usuário não encontrado: ${userId}`);
      throw new UnauthorizedException('Usuário não encontrado');
    }

    // Buscar role + permissoes (via role + diretas)
    const permissoes = await this.usuariosService
      .getUserPermissions(userId)
      .catch((error) => {
        console.error(`⚠️ [AUTH] Erro ao buscar permissoes do usuario ${userId}:`, error);
        return { role: null, permissions: [], permissionNames: [] };
      });

    // Buscar plantas que o usuario pode acessar (filtro de dados)
    // - operador: plantas vinculadas via planta_operadores
    // - proprietario: plantas onde ele e proprietario_id
    // - demais roles: [] (sem filtro, backend nao restringe)
    const plantas_vinculadas = await this.getPlantasAcessiveis(userId, permissoes.role?.name);

    console.log(`✅ [AUTH] /auth/me: ${userId} role=${permissoes.role?.name ?? 'none'} perms=${permissoes.permissionNames.length} plantas=${plantas_vinculadas.length}`);

    return {
      ...usuario,
      role: permissoes.role?.name ?? null,
      role_details: permissoes.role,
      all_permissions: permissoes.permissionNames,
      plantas_vinculadas,
      senha_alterada_em: await this.usuariosService.getSenhaAlteradaEm(userId),
    };
  }

  /**
   * Retorna os ids das plantas que o usuario pode acessar (para data-scoping).
   * Roles analista+ retornam array vazio (sem filtro).
   */
  private async getPlantasAcessiveis(userId: string, roleName: string | null | undefined): Promise<string[]> {
    if (roleName === 'operador') {
      const vinculos = await this.prisma.planta_operadores.findMany({
        where: { usuario_id: userId },
        select: { planta_id: true },
      });
      return vinculos.map((v) => v.planta_id);
    }

    if (roleName === 'proprietario') {
      const plantas = await this.prisma.plantas.findMany({
        where: { proprietario_id: userId, deleted_at: null },
        select: { id: true },
      });
      return plantas.map((p) => p.id);
    }

    return [];
  }

  /**
   * Solicita a redefinição de senha.
   * Sempre retorna a mesma mensagem (anti-enumeração). Se o usuário existir e estiver ativo,
   * gera um token aleatório, guarda apenas o hash em password_reset_tokens e envia o email.
   */
  async forgotPassword(dto: ForgotPasswordDto): Promise<{ message: string }> {
    const mensagemGenerica = {
      message: 'Se o email estiver cadastrado, enviaremos as instruções de redefinição.',
    };

    const email = dto.email.trim();
    const usuario = await this.usuariosService.findByEmail(email).catch(() => null);

    // Não revela se o email existe; só envia para contas ativas.
    if (!usuario || usuario.status !== 'Ativo' || !usuario.is_active || usuario.deleted_at) {
      console.log(`🔑 [AUTH] forgot-password ignorado (inexistente/inativo): ${email}`);
      return mensagemGenerica;
    }

    // Token bruto vai no link; no banco fica apenas o hash.
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = await bcrypt.hash(token, 10);

    await this.prisma.password_reset_tokens.upsert({
      where: { email: usuario.email },
      create: { email: usuario.email, token: tokenHash, created_at: new Date() },
      update: { token: tokenHash, created_at: new Date() },
    });

    // Fire-and-forget: não bloqueia a resposta nem vaza falha de SMTP para o usuário.
    this.mailService
      .sendPasswordResetEmail(
        usuario.email,
        usuario.nome,
        token,
        usuario.email,
        RESET_TOKEN_EXP_MINUTES,
      )
      .catch((err) =>
        console.error(`⚠️ [AUTH] Erro ao enviar email de redefinição: ${err.message}`),
      );

    console.log(`📧 [AUTH] Email de redefinição enfileirado para: ${email}`);
    return mensagemGenerica;
  }

  /**
   * Conclui a redefinição de senha usando o token enviado por email.
   * Valida existência, expiração (60 min), correspondência do hash e igualdade das senhas.
   */
  async resetPassword(dto: ResetPasswordWithTokenDto): Promise<{ message: string }> {
    if (dto.novaSenha !== dto.confirmarSenha) {
      throw new BadRequestException('As senhas não conferem');
    }

    // Resolve o usuário primeiro para usar o email canônico do banco como chave em
    // todas as queries (token + update), evitando divergência por caixa/espacos.
    const usuario = await this.usuariosService
      .findByEmail(dto.email.trim())
      .catch(() => null);

    if (!usuario) {
      throw new BadRequestException('Token inválido ou expirado');
    }

    const email = usuario.email;

    // 1) Token de "esqueci minha senha" (password_reset_tokens, 60 min).
    let tokenValido = false;
    const registro = await this.prisma.password_reset_tokens.findUnique({
      where: { email },
    });
    if (registro) {
      const criadoEm = registro.created_at ? new Date(registro.created_at).getTime() : 0;
      const expirado = Date.now() - criadoEm > RESET_TOKEN_EXP_MINUTES * 60 * 1000;
      if (expirado) {
        await this.prisma.password_reset_tokens.delete({ where: { email } }).catch(() => null);
      } else {
        tokenValido = await bcrypt.compare(dto.token, registro.token);
      }
    }

    // 2) Token de CONVITE de operador (usuario_convites, validade em dias). Aceitar
    //    = definir a senha pela primeira vez → ativa o usuário.
    let conviteId: string | null = null;
    if (!tokenValido) {
      conviteId = await this.validarConvite(usuario.id, dto.token);
      if (!conviteId) {
        throw new BadRequestException('Token inválido ou expirado');
      }
    }

    // Atualiza a senha e invalida o token (uso único).
    const novaSenhaHash = await bcrypt.hash(dto.novaSenha, 12);
    await this.prisma.usuarios.update({
      where: { email },
      data: {
        senha: novaSenhaHash,
        updated_at: new Date(),
        ...(conviteId ? { status: 'Ativo', is_active: true } : {}),
      },
    });
    await this.usuariosService.marcarSenhaAlterada(usuario.id);
    if (conviteId) {
      await this.prisma.$executeRaw`
        UPDATE usuario_convites SET aceito_em = now(), updated_at = now() WHERE TRIM(id) = ${conviteId}`;
      console.log(`✅ [AUTH] Convite ${conviteId} aceito: ${email}`);
    } else {
      await this.prisma.password_reset_tokens.delete({ where: { email } }).catch(() => null);
    }
    // Senha nova → as sessões abertas (aparelho perdido, etc.) deixam de renovar.
    await this.sessoes.revogarOutras(usuario.id, null);

    console.log(`✅ [AUTH] Senha redefinida com sucesso para: ${email}`);
    return { message: 'Senha redefinida com sucesso' };
  }

  /**
   * Convite pendente (não aceito, não cancelado, dentro da validade) cujo hash
   * casa com o token. Tabela ausente (SQL não aplicado) → null.
   */
  private async validarConvite(usuarioId: string, token: string): Promise<string | null> {
    try {
      const convites = await this.prisma.$queryRaw<Array<{ id: string; token_hash: string }>>`
        SELECT TRIM(id) AS id, token_hash FROM usuario_convites
        WHERE TRIM(usuario_id) = ${usuarioId.trim()}
          AND aceito_em IS NULL AND cancelado_em IS NULL AND expira_em > now()
        ORDER BY enviado_em DESC LIMIT 3`;
      for (const c of convites) {
        if (await bcrypt.compare(token, c.token_hash)) return c.id;
      }
    } catch (e) {
      console.warn(`⚠️ [AUTH] validarConvite: ${(e as Error).message}`);
    }
    return null;
  }

  /**
   * Realiza logout (pode ser expandido para blacklist de tokens)
   * @param userId ID do usuário
   */
  async logout(userId: string, sid?: string | null): Promise<{ message: string }> {
    console.log(`👋 [AUTH] Logout do usuário: ${userId}`);

    // Com sessão: encerra só a deste aparelho (o refresh dela passa a dar 401).
    if (sid) await this.sessoes.revogar(userId, sid).catch(() => null);

    // TODO: Implementar blacklist de tokens se necessário
    // Por enquanto, o logout é gerenciado pelo frontend removendo o token

    return { message: 'Logout realizado com sucesso' };
  }
}
