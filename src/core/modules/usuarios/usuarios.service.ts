// src/modules/usuarios/usuarios.service.ts - VERSÃO COMPLETA E CORRIGIDA
import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Logger,
  Optional,
} from '@nestjs/common';
// Builtins do Node, sem efeito colateral na carga: nao ha por que adia-los com
// require() dentro da funcao, que alem de esconder a dependencia obriga o TS a
// tratar o modulo como `any`.
import { promises as arquivos } from 'fs';
import * as caminho from 'path';
import { PrismaService } from '../../prisma/prisma.service';
import { RolesService } from '../roles/roles.service';
import { PermissionsService } from '../permissions/permissions.service';
import { 
  CreateUsuarioDto, 
  UpdateUsuarioDto, 
  UsuarioQueryDto,
  ChangePasswordDto,
  ResetPasswordDto,
  UsuarioStatus,
  UsuarioResponseDto,
  UserPermissionsResponseDto,
  UserPermissionsSummaryDto,
  CategorizedPermissionsDto,
  BulkAssignRolesDto,
  BulkAssignPermissionsDto
} from './dto';
import * as bcrypt from 'bcryptjs';
import { customAlphabet } from 'nanoid';
import { MailService } from '../../mail/mail.service';
import { Papel, papelCanonico, podeCadastrar } from '../auth/papeis';
import { AuditoriaAcessosService } from './auditoria-acessos.service';
import { AcaoGestao, avaliarGestao, mensagemPapel, permissoesAlemDoAutor } from './regras-gestao-usuario';

/** Quem pede (payload do JWT em req.user). */
export interface Requisitante {
  id?: string;
  nome?: string;
  role?: string | null;
  permissions?: string[];
}

/** Campos do cadastro que entram no antes → depois da trilha. */
const CAMPOS_TRILHA = [
  'nome', 'email', 'telefone', 'status', 'cpf_cnpj', 'cidade', 'estado', 'endereco', 'cep',
  'manager_id', 'concessionaria_atual_id', 'organizacao_atual_id', 'is_active',
] as const;

@Injectable()
export class UsuariosService {
  private readonly logger = new Logger(UsuariosService.name);

  constructor(
    private prisma: PrismaService,
    private rolesService: RolesService,
    private permissionsService: PermissionsService,
    private mailService: MailService,
    @Optional() private auditoria?: AuditoriaAcessosService,
  ) {}

  // ==========================================================================
  // Regras de gestão de usuário (NEXON-20, spec seção 3 / PER-11)
  // ==========================================================================

  /** Papel canônico de um usuário: Spatie (model_has_roles) e, sem ele, a coluna legada. */
  async papelDoUsuario(id: string): Promise<{ papel: Papel; role: string | null }> {
    const mhr = await this.prisma.model_has_roles.findFirst({
      where: { model_id: id, model_type: 'App\\Models\\User' },
      include: { roles: true },
    });
    let role = mhr?.roles?.name ?? null;
    if (!role) {
      const u = await this.prisma.usuarios.findFirst({ where: { id }, select: { role: true } });
      role = u?.role ?? null;
    }
    return { papel: papelCanonico(role), role };
  }

  /** Vínculos ativos do operador: com o autor e com outros proprietários. */
  private async vinculosDoOperador(alvoId: string, autorId: string): Promise<{ meu: number; outros: number } | null> {
    try {
      const [r] = await this.prisma.$queryRaw<Array<{ meu: number; outros: number }>>`
        SELECT COUNT(*) FILTER (WHERE proprietario_id = ${autorId.trim()}::bpchar)::int AS meu,
               COUNT(*) FILTER (WHERE proprietario_id <> ${autorId.trim()}::bpchar)::int AS outros
        FROM operador_vinculos
        WHERE operador_id = ${alvoId.trim()}::bpchar AND removido_em IS NULL
          AND (validade IS NULL OR validade >= (now() AT TIME ZONE 'America/Sao_Paulo')::date)`;
      return { meu: Number(r?.meu) || 0, outros: Number(r?.outros) || 0 };
    } catch {
      return null; // SQL 2026-10-20c não aplicado
    }
  }

  /**
   * Operador ligado ao autor: vínculo ativo com ele, ou criado por ele e ainda
   * sem vínculo com outro proprietário (o recém-cadastrado, antes do passo Acesso).
   */
  async operadorLigadoAo(alvoId: string, autorId: string): Promise<boolean> {
    const v = await this.vinculosDoOperador(alvoId, autorId);
    if (v && v.meu > 0) return true;
    const u = await this.prisma.usuarios.findFirst({ where: { id: alvoId.trim() }, select: { created_by: true } });
    return u?.created_by?.trim() === autorId.trim() && (!v || v.outros === 0);
  }

  /**
   * 403 se o requisitante não pode `acao` sobre o usuário `alvoId` (e, se
   * informado, colocá-lo no `novoPapel`). Sem requisitante = chamada interna.
   */
  async assertPodeGerir(
    requester: Requisitante | undefined,
    alvoId: string,
    acao: AcaoGestao,
    novoPapel?: Papel,
    novoRoleName?: string | null,
  ): Promise<{ papel: Papel; role: string | null }> {
    // Chamada interna: sem regra; só busca o papel se alguém vai precisar dele.
    if (!requester?.id) {
      return novoPapel !== undefined ? this.papelDoUsuario(alvoId) : { papel: 'outro', role: null };
    }
    const alvo = await this.papelDoUsuario(alvoId);
    const autor = papelCanonico(requester.role);
    const proprio = requester.id.trim() === alvoId.trim();
    const donoOperador = !proprio && autor === 'proprietario' && alvo.papel === 'operador';
    const ligado = donoOperador ? await this.operadorLigadoAo(alvoId, requester.id) : false;
    const outroDono = donoOperador ? ((await this.vinculosDoOperador(alvoId, requester.id))?.outros ?? 0) > 0 : false;
    const motivo = avaliarGestao({
      autor, autorRole: requester.role, acao, proprio, alvo: alvo.papel, alvoRole: alvo.role,
      alvoLigadoAoAutor: ligado, novoPapel, novoRoleName, alvoTemOutroDono: outroDono,
    });
    if (motivo) throw new ForbiddenException(motivo);
    return alvo;
  }

  /**
   * Papel pedido no corpo; undefined = não pediu. `roleId` e `roleNames` são
   * gravados em sequência (o último vence), então TODOS entram na conta: mais de
   * um papel diferente = 400, nunca "checa um e grava outro".
   */
  async papelPedido(data: { roleId?: number; roleNames?: string[] }): Promise<{ papel: Papel; roleName: string } | undefined> {
    const nomes: string[] = [];
    if (data.roleId) {
      const r = await this.prisma.roles.findFirst({ where: { id: BigInt(data.roleId) } });
      if (!r) throw new BadRequestException('Papel não encontrado');
      nomes.push(r.name);
    }
    for (const n of data.roleNames ?? []) if (n?.trim()) nomes.push(n.trim());
    const distintos = [...new Set(nomes)];
    if (distintos.length === 0) return undefined;
    if (distintos.length > 1) throw new BadRequestException('Envie um papel só (roleId ou roleNames)');
    return { papel: papelCanonico(distintos[0]), roleName: distintos[0] };
  }

  /** Permissões diretas pedidas: só as que o autor tem (PER-3). */
  async assertPermissoesConcedidas(
    requester: Requisitante | undefined,
    data: { permissionIds?: number[]; permissions?: string[] },
  ): Promise<void> {
    if (!requester?.id) return;
    const nomes = new Set<string>(data.permissions ?? []);
    if (data.permissionIds?.length) {
      const ps = await this.prisma.permissions.findMany({
        where: { id: { in: data.permissionIds.map((x) => BigInt(x)) } },
        select: { name: true },
      });
      ps.forEach((p) => nomes.add(p.name));
    }
    const faltam = permissoesAlemDoAutor(papelCanonico(requester.role), requester.permissions, [...nomes]);
    if (faltam.length) {
      throw new ForbiddenException(`Você não pode conceder permissões que não tem: ${faltam.slice(0, 5).join(', ')}`);
    }
  }

  private async trilha(
    acao: Parameters<AuditoriaAcessosService['registrar']>[0]['acao'],
    requester: Requisitante | undefined,
    alvo: { id: string; nome?: string | null },
    mensagem: string,
    detalhes: Record<string, unknown> = {},
  ): Promise<void> {
    await this.auditoria?.registrar({
      autorId: requester?.id ?? null,
      autorNome: requester?.nome ?? null,
      alvoUsuarioId: alvo.id,
      alvoNome: alvo.nome ?? null,
      acao,
      mensagem,
      detalhes,
      objetoTipo: 'usuario',
      objetoId: alvo.id,
    });
  }

  async findAll(query: UsuarioQueryDto, requestingUserId?: string) {
    const {
      page = 1,
      limit = 10,
      search,
      status,
      role,
      roles,
      cidade,
      estado,
      concessionariaId,
      organizacaoId,
      includeInactive = false,
    } = query;

    const skip = (page - 1) * limit;

    // Construir filtros
    const where: any = {};

    // Cada grupo de OR entra AQUI, e nao direto em where.OR.
    //
    // Antes, escopo do proprietario, filtro de roles e busca textual escreviam
    // os tres em where.OR — o ultimo a rodar apagava os anteriores. Na pratica:
    // um proprietario que digitasse qualquer coisa na busca perdia o recorte
    // por created_by e passava a enxergar TODOS os usuarios do sistema.
    const grupos: any[] = [];

    // Filtrar apenas ativos por padrão
    if (!includeInactive) {
      where.deleted_at = null;
      where.is_active = true;
    }

    if (status) {
      where.status = status;
    }

    // ============================================================================
    // FILTRO ESPECIAL PARA PROPRIETÁRIOS - OTIMIZADO
    // Se o usuário logado é proprietário, mostrar apenas operadores que ele criou
    // ============================================================================
    if (requestingUserId) {
      // ✅ OTIMIZAÇÃO: Buscar dados do usuário em UMA query com JOIN
      const requestingUserData = await this.prisma.usuarios.findFirst({
        where: { id: requestingUserId, deleted_at: null },
        select: {
          role: true, // role legacy
        }
      });

      const papelReq = papelCanonico(requestingUserData?.role);

      if (papelReq === 'operador' || papelReq === 'outro') {
        // Operador não gere ninguém: só ele mesmo.
        grupos.push({ id: requestingUserId });
      } else if (papelReq === 'proprietario') {
        // Proprietário vê os operadores que criou ou que têm vínculo com ele + ele mesmo
        let ligados: string[] = [];
        try {
          ligados = (await this.prisma.$queryRaw<Array<{ id: string }>>`
            SELECT DISTINCT operador_id AS id FROM operador_vinculos
            WHERE proprietario_id = ${requestingUserId}::bpchar AND removido_em IS NULL`).map((r) => r.id);
        } catch { /* SQL 2026-10-20c não aplicado: só created_by */ }
        grupos.push({
          OR: [
            { created_by: requestingUserId }, // Operadores que ele criou
            { id: requestingUserId },         // Ele mesmo
            ...(ligados.length ? [{ id: { in: ligados } }] : []),
          ]
        });
        this.logger.log(`🔒 [FINDALL] Proprietário ${requestingUserId} - filtrando por created_by OU próprio ID`);
      } else {
        this.logger.log(`✅ [FINDALL] Usuário ${requestingUserId} NÃO é proprietário - sem filtro created_by`);
      }
    }

    // Filtrar por role (singular) - case-insensitive
    if (role) {
      where.role = {
        equals: role,
        mode: 'insensitive'
      };
    }

    // Filtrar por múltiplas roles (plural) - case-insensitive - tem prioridade sobre singular
    if (roles) {
      const roleArray = roles.split(',').map(r => r.trim());
      grupos.push({
        OR: roleArray.map(r => ({
          role: {
            equals: r,
            mode: 'insensitive'
          }
        }))
      });
    }

    if (cidade) {
      where.cidade = {
        contains: cidade,
        mode: 'insensitive'
      };
    }

    if (estado) {
      where.estado = {
        contains: estado,
        mode: 'insensitive'
      };
    }

    if (concessionariaId) {
      where.concessionaria_atual_id = concessionariaId;
    }

    if (organizacaoId) {
      where.organizacao_atual_id = organizacaoId;
    }

    // Filtro de busca
    if (search) {
      grupos.push({
        OR: [
          { nome: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
          { telefone: { contains: search, mode: 'insensitive' } },
          { cpf_cnpj: { contains: search, mode: 'insensitive' } },
        ]
      });
    }

    // Todos os grupos valem ao mesmo tempo; nenhum sobrescreve o outro.
    if (grupos.length > 0) {
      where.AND = grupos;
    }

    try {
      const startTime = Date.now();

      // Buscar usuários e count separadamente para reduzir carga
      this.logger.log(`⏱️ [FINDALL] Iniciando query de usuários...`);
      const usuarios = await this.prisma.usuarios.findMany({
        where,
        // O id desempata, e sem ele a paginacao mentia.
        //
        // created_at e nullable e tem precisao de SEGUNDO (Timestamp(0)); em
        // DEV, 34 dos 58 usuarios ativos estao com NULL. Ordenar so por ele
        // deixa dezenas de linhas empatadas, e o Postgres nao promete ordem
        // estavel entre empatados: cada requisicao pode devolve-los numa ordem
        // diferente. Com OFFSET/LIMIT isso faz as fatias se sobreporem — o
        // mesmo usuario aparecia em duas ou tres paginas, e outros nao
        // apareciam em nenhuma. Sendo chave primaria, o id da uma ordem total.
        orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
        skip,
        take: limit,
      });
      const queryTime = Date.now() - startTime;
      this.logger.log(`✅ [FINDALL] Query completada em ${queryTime}ms - ${usuarios.length} usuários encontrados`);

      const countStart = Date.now();
      const total = await this.prisma.usuarios.count({ where });
      const countTime = Date.now() - countStart;
      this.logger.log(`✅ [FINDALL] Count completado em ${countTime}ms - Total: ${total}`);

      // Mapear para DTO compatível de forma mais eficiente
      const mapStart = Date.now();
      const usuariosFormatados = await Promise.all(
        usuarios.map(usuario => this.mapToUsuarioResponseDtoOptimized(usuario))
      );
      const mapTime = Date.now() - mapStart;
      this.logger.log(`✅ [FINDALL] Mapeamento completado em ${mapTime}ms`);

      const totalTime = Date.now() - startTime;
      this.logger.log(`🎯 [FINDALL] TEMPO TOTAL: ${totalTime}ms`);

      return {
        data: usuariosFormatados,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      console.error('❌ Erro ao buscar usuários:', error);
      throw new BadRequestException('Erro ao buscar usuários');
    }
  }

  async findOne(id: string): Promise<UsuarioResponseDto> {
    try {
      const usuario = await this.prisma.usuarios.findFirst({
        where: {
          id,
          deleted_at: null
        }
      });

      if (!usuario) {
        throw new NotFoundException('Usuário não encontrado');
      }

      return await this.mapToUsuarioResponseDto(usuario);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      console.error('Erro ao buscar usuário:', error);
      throw new BadRequestException('Erro ao buscar usuário');
    }
  }

  /**
   * Busca usuário por email (usado para autenticação)
   * Retorna o usuário com a senha para validação
   */
  async findByEmail(email: string) {
    try {
      const usuario = await this.prisma.usuarios.findUnique({
        where: { email },
      });

      return usuario; // Retorna null se não encontrar
    } catch (error) {
      console.error('Erro ao buscar usuário por email:', error);
      throw new BadRequestException('Erro ao buscar usuário por email');
    }
  }

  async create(
    data: CreateUsuarioDto,
    creatingUser?: { id?: string; role?: string | null; permissions?: string[] } | string,
  ): Promise<UsuarioResponseDto> {
    try {
      console.log('🚀 [CREATE USER] Iniciando criação de usuário');

      // Compat: aceita string (id) ou objeto (user completo)
      const creatingUserId = typeof creatingUser === 'string' ? creatingUser : creatingUser?.id;

      // Quem cadastra quem (spec NEXON-20, seção 3). Sem papel pedido, nasce
      // Operador — nunca o "primeiro papel da tabela" (que é super_admin).
      const requisitante: Requisitante | undefined = typeof creatingUser === 'object' && creatingUser?.id
        ? creatingUser as Requisitante
        : undefined;
      let pedido = await this.papelPedido(data);
      const papelAlvo: Papel = pedido?.papel ?? 'operador';
      if (requisitante) {
        const autor = papelCanonico(requisitante.role);
        if (!podeCadastrar(autor, papelAlvo)) {
          throw new ForbiddenException(mensagemPapel(papelAlvo));
        }
        if (pedido?.roleName.toLowerCase() === 'super_admin' && String(requisitante.role).toLowerCase() !== 'super_admin') {
          throw new ForbiddenException('Apenas super_admin atribui o papel super_admin');
        }
        await this.assertPermissoesConcedidas(requisitante, data);
      }
      console.log('📝 [CREATE USER] Dados recebidos:', JSON.stringify(data, null, 2));
      console.log('👤 [CREATE USER] Creating User ID recebido:', creatingUserId);

      // Verificar se email já existe
      const existingUser = await this.prisma.usuarios.findFirst({
        where: { email: data.email },
      });

      if (existingUser) {
        if (existingUser.deleted_at) {
          // Liberar o email do registro soft-deleted para permitir reutilização
          await this.prisma.usuarios.update({
            where: { id: existingUser.id },
            data: { email: `deleted_${existingUser.id}_${existingUser.email}` },
          });
          console.log(`♻️ [CREATE USER] Email liberado do usuário soft-deleted ${existingUser.id}`);
        } else {
          // Operador é um usuário único com vários vínculos (PER-12): cadastrar
          // um operador que já existe devolve o mesmo usuário, para o próximo
          // passo (Acesso) criar o vínculo de quem está cadastrando.
          const existente = await this.papelDoUsuario(existingUser.id);
          if (existente.papel === 'operador' && papelAlvo === 'operador') {
            // Só o necessário para o próximo passo: o cadastro dele não é de quem pede.
            return { id: existingUser.id.trim(), nome: existingUser.nome, existente: true } as any;
          }
          throw new ConflictException('Email já está em uso');
        }
      }

      // ============================================================================
      // VALIDAÇÃO PARA PROPRIETÁRIOS
      // Se o usuário criador é proprietário, só pode criar operadores
      // ============================================================================
      if (creatingUserId) {
        // SEMPRE definir created_by quando houver creatingUserId
        data.createdBy = creatingUserId;
        console.log(`✅ [CREATE USER] Definindo data.createdBy como ${creatingUserId}`);

        const creatingUser = await this.prisma.usuarios.findFirst({
          where: { id: creatingUserId, deleted_at: null }
        });

        // Buscar role do usuário criador no sistema Spatie
        const creatorRoleData = await this.prisma.model_has_roles.findFirst({
          where: {
            model_id: creatingUserId,
            model_type: 'App\\Models\\User'
          },
          include: {
            roles: true
          }
        });

        // Verificar se o criador é proprietário (em qualquer um dos sistemas)
        const isProprietario =
          creatorRoleData?.roles?.name === 'propietario' ||
          creatingUser?.role === 'proprietario';

        if (isProprietario) {
          console.log(`🔒 [CREATE USER] Proprietário ${creatingUserId} criando usuário`);

          // Buscar role operador
          const operadorRole = await this.prisma.roles.findFirst({
            where: { name: 'operador' }
          });

          if (!operadorRole) {
            throw new BadRequestException('Role operador não encontrada no sistema');
          }

          // Validar que está criando um operador
          if (data.roleId && data.roleId !== Number(operadorRole.id)) {
            throw new BadRequestException('Proprietários só podem criar usuários do tipo OPERADOR');
          }

          // Forçar roleId como operador se não foi especificado
          if (!data.roleId) {
            data.roleId = Number(operadorRole.id);
            console.log(`✅ [CREATE USER] Definindo roleId automaticamente como operador (${operadorRole.id})`);
          }
        }
      }

      if (!pedido) {
        const op = await this.prisma.roles.findFirst({ where: { name: 'operador' } });
        if (op) {
          data.roleId = Number(op.id);
          pedido = { papel: 'operador', roleName: 'operador' };
        }
      }

      console.log('🔍 [CREATE USER] Antes de criar - data.createdBy:', data.createdBy);

      // Gerar ID
      const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 26);
      const userId = nanoid();

      // Senha padrão
      const senhaTemporaria = 'Aupus123!';
      const hashedPassword = await bcrypt.hash(senhaTemporaria, 12);

      // Buscar role padrão para compatibilidade com outra aplicação
      const defaultRole = await this.prisma.roles.findFirst({
        where: { name: 'user' }
      }) || await this.prisma.roles.findFirst(); // Primeira role disponível como fallback

      if (!defaultRole) {
        throw new BadRequestException('Nenhuma role encontrada no sistema');
      }

      console.log(`🎯 [CREATE USER] Usando role padrão: ${defaultRole.name}`);

      // Criar usuário com role padrão para compatibilidade
      const novoUsuario = await this.prisma.usuarios.create({
        data: {
          id: userId,
          nome: data.nome,
          email: data.email,
          telefone: data.telefone,
          instagram: data.instagram,
          status: data.status || UsuarioStatus.ATIVO,
          cpf_cnpj: data.cpfCnpj,
          cidade: data.cidade,
          estado: data.estado,
          endereco: data.endereco,
          cep: data.cep,
          role: this.mapSpatieRoleToValidDbRole(defaultRole.name), // Para compatibilidade com outra aplicação
          manager_id: data.managerId,
          concessionaria_atual_id: data.concessionariaAtualId,
          organizacao_atual_id: data.organizacaoAtualId,
          created_by: data.createdBy, // ← NOVO: rastrear quem criou
          is_active: true,
          senha: hashedPassword,
        }
      });

      // Processar atribuição de roles e permissions via sistema híbrido
      await this.processInitialRoleAndPermissionAssignment(userId, data);

      console.log('✅ [CREATE USER] Usuário criado com sucesso');

      await this.trilha('usuario_criado', typeof creatingUser === 'object' ? creatingUser as Requisitante : undefined,
        { id: userId, nome: data.nome },
        `Usuário ${data.nome} criado como ${pedido?.roleName ?? 'sem papel'}`,
        { papel: pedido?.papel ?? null, role: pedido?.roleName ?? null, email: data.email, telefone: data.telefone ?? null });

      // Enviar email de boas-vindas (fire-and-forget)
      this.mailService
        .sendWelcomeEmail(data.email, data.nome, senhaTemporaria)
        .catch(err => this.logger.error(`Erro ao enviar email de boas-vindas: ${err.message}`));

      const result = await this.mapToUsuarioResponseDto(novoUsuario);

      // Adicionar informações extras para resposta de criação
      return {
        ...result,
        senhaTemporaria, // Para informar ao frontend
        primeiroAcesso: true,
      } as any;
    } catch (error) {
      if (error instanceof ConflictException || error instanceof BadRequestException || error instanceof ForbiddenException) {
        throw error;
      }
      console.error('Erro ao criar usuário:', error);
      throw new BadRequestException('Erro ao criar usuário: ' + error.message);
    }
  }

  private async discoverValidRoles() {
    try {
      console.log('🔍 [DISCOVER ROLES] Descobrindo roles válidas...');
      
      // Tentar descobrir o constraint
      const constraints = await this.prisma.$queryRaw`
        SELECT 
          conname, 
          pg_get_constraintdef(oid) as constraint_def
        FROM pg_constraint 
        WHERE conrelid = 'usuarios'::regclass 
        AND contype = 'c'
      ` as any[];

      console.log('📋 [DISCOVER ROLES] Constraints encontrados:');
      constraints.forEach((constraint, index) => {
        console.log(`${index + 1}. ${constraint.conname}: ${constraint.constraint_def}`);
      });

      // Tentar buscar alguns usuários existentes para ver que roles eles têm
      const existingUsers = await this.prisma.usuarios.findMany({
        select: { role: true },
        take: 10,
        distinct: ['role']
      });

      console.log('👥 [DISCOVER ROLES] Roles existentes nos usuários:');
      const existingRoles = existingUsers.map(u => u.role).filter(r => r);
      console.log(existingRoles);

    } catch (error) {
      console.log('⚠️ [DISCOVER ROLES] Erro ao descobrir roles:', error.message);
    }
  }

  async update(
    id: string,
    data: UpdateUsuarioDto,
    requester?: Requisitante,
  ): Promise<UsuarioResponseDto> {
    try {
      const usuario = await this.prisma.usuarios.findFirst({
        where: {
          id,
          deleted_at: null
        },
      });

      if (!usuario) {
        throw new NotFoundException('Usuário não encontrado');
      }

      // Quem edita quem (PER-11): mesma matriz do cadastro, dentro do escopo.
      const pedido = await this.papelPedido(data);
      const desativando = data.status !== undefined && data.status !== UsuarioStatus.ATIVO && usuario.status === UsuarioStatus.ATIVO;
      if (data.clearRole && requester?.id && papelCanonico(requester.role) !== 'admin') {
        throw new ForbiddenException('Apenas Admin remove o papel de um usuário');
      }
      const papelAntes = await this.assertPodeGerir(
        requester, id, desativando ? 'desativar' : 'editar', pedido?.papel, pedido?.roleName,
      );
      await this.assertPermissoesConcedidas(requester, data);

      // Verificar email duplicado
      if (data.email && data.email !== usuario.email) {
        const existingUser = await this.prisma.usuarios.findFirst({
          where: { 
            email: data.email,
            deleted_at: null,
            id: { not: id },
          },
        });

        if (existingUser) {
          throw new ConflictException('Email já está em uso');
        }
      }

      // Preparar dados para atualização
      const updateData: any = {};
      if (data.nome !== undefined) updateData.nome = data.nome;
      if (data.email !== undefined) updateData.email = data.email;
      if (data.telefone !== undefined) updateData.telefone = data.telefone;
      if (data.instagram !== undefined) updateData.instagram = data.instagram;
      if (data.status !== undefined) updateData.status = data.status;
      if (data.cpfCnpj !== undefined) updateData.cpf_cnpj = data.cpfCnpj;
      if (data.cidade !== undefined) updateData.cidade = data.cidade;
      if (data.estado !== undefined) updateData.estado = data.estado;
      if (data.endereco !== undefined) updateData.endereco = data.endereco;
      if (data.cep !== undefined) updateData.cep = data.cep;
      if (data.managerId !== undefined) updateData.manager_id = data.managerId;
      if (data.concessionariaAtualId !== undefined) updateData.concessionaria_atual_id = data.concessionariaAtualId;
      if (data.organizacaoAtualId !== undefined) updateData.organizacao_atual_id = data.organizacaoAtualId;
      
      updateData.updated_at = new Date();

      // Atualizar usuário base
      const usuarioAtualizado = await this.prisma.usuarios.update({
        where: { id },
        data: updateData
      });

      // Processar atualizações do sistema híbrido de roles/permissions
      await this.processRoleAndPermissionUpdates(id, data);

      // Trilha: só o que mudou (antes → depois), papel e ativação à parte.
      const antes: Record<string, unknown> = {};
      const depois: Record<string, unknown> = {};
      for (const c of CAMPOS_TRILHA) {
        const a = (usuario as any)[c] ?? null;
        const d = (usuarioAtualizado as any)[c] ?? null;
        if (String(a) !== String(d)) { antes[c] = a; depois[c] = d; }
      }
      const alvo = { id, nome: usuarioAtualizado.nome };
      if (Object.keys(depois).length) {
        await this.trilha('usuario_alterado', requester, alvo,
          `Cadastro de ${usuarioAtualizado.nome} alterado: ${Object.keys(depois).join(', ')}`, { antes, depois });
      }
      if (pedido && pedido.papel !== papelAntes.papel) {
        await this.trilha('papel_alterado', requester, alvo,
          `Papel de ${usuarioAtualizado.nome}: ${papelAntes.role ?? '—'} → ${pedido.roleName}`,
          { antes: papelAntes.role, depois: pedido.roleName });
      }
      if (usuario.status !== usuarioAtualizado.status) {
        const ativou = usuarioAtualizado.status === UsuarioStatus.ATIVO;
        await this.trilha(ativou ? 'usuario_reativado' : 'usuario_desativado', requester, alvo,
          `${usuarioAtualizado.nome} ${ativou ? 'reativado' : 'desativado'}`,
          { antes: usuario.status, depois: usuarioAtualizado.status });
      }

      return await this.mapToUsuarioResponseDto(usuarioAtualizado);
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ConflictException || error instanceof ForbiddenException) {
        throw error;
      }
      console.error('Erro ao atualizar usuário:', error);
      throw new BadRequestException('Erro ao atualizar usuário');
    }
  }

  async remove(id: string, requester?: Requisitante) {
    try {
      const usuario = await this.prisma.usuarios.findFirst({
        where: {
          id,
          deleted_at: null
        },
      });

      if (!usuario) {
        throw new NotFoundException('Usuário não encontrado');
      }

      await this.assertPodeGerir(requester, id, 'excluir');

      await this.prisma.usuarios.update({
        where: { id },
        data: {
          deleted_at: new Date(),
          is_active: false,
          status: UsuarioStatus.INATIVO,
        },
      });

      await this.trilha('usuario_excluido', requester, { id, nome: usuario.nome },
        `Usuário ${usuario.nome} excluído`, { email: usuario.email, papel: usuario.role });

      return { message: 'Usuário excluído com sucesso' };
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ForbiddenException) {
        throw error;
      }
      console.error('Erro ao excluir usuário:', error);
      throw new BadRequestException('Erro ao excluir usuário');
    }
  }

  /**
   * Troca de senha pelo próprio usuário (exige a senha atual).
   * Só o dono do id — ou quem tem usuarios.manage — pode chamar (antes qualquer
   * autenticado trocava a senha de qualquer id sabendo a senha atual).
   */
  async changePassword(
    id: string,
    data: ChangePasswordDto,
    requester?: { id?: string; permissions?: string[]; sid?: string | null },
  ) {
    try {
      if (requester) {
        const proprio = requester.id?.trim() === id.trim();
        if (!proprio && !(requester.permissions ?? []).includes('usuarios.manage')) {
          throw new ForbiddenException('Você só pode alterar a sua própria senha');
        }
      }

      const usuario = await this.prisma.usuarios.findFirst({
        where: { 
          id, 
          deleted_at: null 
        },
      });

      if (!usuario) {
        throw new NotFoundException('Usuário não encontrado');
      }

      if (!usuario.senha) {
        throw new BadRequestException('Usuário não possui senha definida');
      }

      // Verificar senha atual
      const senhaValida = await bcrypt.compare(data.senhaAtual, usuario.senha);
      if (!senhaValida) {
        throw new BadRequestException('Senha atual incorreta');
      }

      // Hash da nova senha
      const novaSenhaHash = await bcrypt.hash(data.novaSenha, 12);

      await this.prisma.usuarios.update({
        where: { id },
        data: {
          senha: novaSenhaHash,
          updated_at: new Date(),
        },
      });
      await this.marcarSenhaAlterada(id);
      // Mantém a sessão de quem trocou; as outras param de renovar.
      await this.revogarSessoes(id, requester?.id?.trim() === id.trim() ? requester?.sid ?? null : null);

      return { message: 'Senha alterada com sucesso' };
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException ||
        error instanceof ForbiddenException
      ) {
        throw error;
      }
      console.error('Erro ao alterar senha:', error);
      throw new BadRequestException('Erro ao alterar senha');
    }
  }

  /**
   * Reset administrativo (define a senha de OUTRO usuário, sem a atual).
   * Exige usuarios.manage (no controller) E escopo: proprietário só reseta quem
   * ele criou; admin não reseta outro admin (só super_admin) — mesma regra do update.
   */
  async resetPassword(
    id: string,
    data: ResetPasswordDto,
    requester?: Requisitante,
  ) {
    try {
      if (data.confirmarSenha !== undefined && data.novaSenha !== data.confirmarSenha) {
        throw new BadRequestException('As senhas não conferem');
      }

      const usuario = await this.prisma.usuarios.findFirst({
        where: {
          id,
          deleted_at: null
        },
      });

      if (!usuario) {
        throw new NotFoundException('Usuário não encontrado');
      }

      await this.assertPodeGerir(requester, id, 'senha');

      const novaSenhaHash = await bcrypt.hash(data.novaSenha, 12);

      await this.prisma.usuarios.update({
        where: { id },
        data: {
          senha: novaSenhaHash,
          updated_at: new Date(),
        },
      });
      await this.marcarSenhaAlterada(id);
      await this.revogarSessoes(id, null);
      await this.trilha('usuario_alterado', requester, { id, nome: usuario.nome },
        `Senha de ${usuario.nome} redefinida`, { campo: 'senha' });

      return {
        message: 'Senha resetada com sucesso',
        senhaTemporaria: data.novaSenha
      };
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException ||
        error instanceof ForbiddenException
      ) {
        throw error;
      }
      console.error('Erro ao resetar senha:', error);
      throw new BadRequestException('Erro ao resetar senha');
    }
  }

  // ==========================================================================
  // Colunas SQL-cruas de usuarios (fora do schema Prisma de propósito — a
  // sincronização replica `usuarios` pelo DMMF). Tolerantes à coluna ausente.
  // ==========================================================================

  /** Carimba usuarios.senha_alterada_em = now(). */
  async marcarSenhaAlterada(id: string): Promise<void> {
    try {
      await this.prisma.$executeRaw`UPDATE usuarios SET senha_alterada_em = now() WHERE TRIM(id) = ${id.trim()}`;
    } catch (e) {
      this.logger.warn(`senha_alterada_em não gravado (coluna ausente?): ${(e as Error).message}`);
    }
  }

  async getSenhaAlteradaEm(id: string): Promise<Date | null> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ senha_alterada_em: Date | null }>>`
        SELECT senha_alterada_em FROM usuarios WHERE TRIM(id) = ${id.trim()} LIMIT 1`;
      return rows[0]?.senha_alterada_em ?? null;
    } catch {
      return null;
    }
  }

  /** Encerra as sessões (auth_sessoes) do usuário, menos `exceto`. */
  async revogarSessoes(id: string, exceto: string | null): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        UPDATE auth_sessoes SET revoked_at = now()
        WHERE TRIM(usuario_id) = ${id.trim()} AND revoked_at IS NULL AND TRIM(id) <> ${exceto?.trim() ?? ''}`;
    } catch (e) {
      this.logger.warn(`sessões não revogadas (tabela ausente?): ${(e as Error).message}`);
    }
  }

  async updateAvatar(userId: string, filename: string) {
    try {
      const usuario = await this.prisma.usuarios.findFirst({
        where: {
          id: userId,
          deleted_at: null
        },
      });

      if (!usuario) {
        throw new NotFoundException('Usuário não encontrado');
      }

      // Se o usuário já tem um avatar, deletar o arquivo antigo
      if (usuario.avatar_url) {
        try {
          const oldFilePath = caminho.join(__dirname, '../../..', usuario.avatar_url);
          await arquivos.unlink(oldFilePath).catch(err => {
            console.log('Arquivo antigo não encontrado ou já removido:', err.message);
          });
        } catch (error) {
          console.log('Erro ao deletar avatar antigo:', error);
          // Continua mesmo se falhar ao deletar o arquivo antigo
        }
      }

      const imageUrl = `/uploads/avatars/${filename}`;

      await this.prisma.usuarios.update({
        where: { id: userId },
        data: {
          avatar_url: imageUrl,
          updated_at: new Date(),
        },
      });

      console.log(`✅ Avatar atualizado para usuário ${userId}: ${imageUrl}`);
      return { imageUrl };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      console.error('Erro ao atualizar avatar:', error);
      throw new BadRequestException('Erro ao atualizar avatar');
    }
  }

  // ============================================================================
  // MÉTODOS DE GESTÃO DE ROLES E PERMISSIONS - VERSÃO COMPLETA
  // ============================================================================

  /**
   * Busca informações detalhadas sobre as permissões de um usuário
   */
  async getUserPermissions(userId: string): Promise<UserPermissionsResponseDto> {
    try {
      const usuario = await this.prisma.usuarios.findFirst({
        where: { 
          id: userId, 
          deleted_at: null 
        }
      });

      if (!usuario) {
        throw new NotFoundException('Usuário não encontrado');
      }

      // Buscar role do usuário com suas permissões
      const userRole = await this.prisma.model_has_roles.findFirst({
        where: {
          model_id: userId,
          model_type: 'App\\Models\\User'
        },
        include: {
          roles: {
            include: {
              role_has_permissions: {
                include: {
                  permissions: true
                }
              }
            }
          }
        }
      });

      // Buscar permissões diretas do usuário
      const userDirectPermissions = await this.prisma.model_has_permissions.findMany({
        where: {
          model_id: userId,
          model_type: 'App\\Models\\User'
        },
        include: {
          permissions: true
        }
      });

      // Formatar role
      const role = userRole ? {
        id: Number(userRole.roles.id),
        name: userRole.roles.name,
        guard_name: userRole.roles.guard_name
      } : null;

      // Formatar permissões do role
      const rolePermissions = userRole?.roles.role_has_permissions.map(rhp => ({
        id: Number(rhp.permissions.id),
        name: rhp.permissions.name,
        guard_name: rhp.permissions.guard_name,
        source: 'role' as const
      })) || [];

      // Formatar permissões diretas
      const directPermissions = userDirectPermissions.map(mhp => ({
        id: Number(mhp.permissions.id),
        name: mhp.permissions.name,
        guard_name: mhp.permissions.guard_name,
        source: 'direct' as const
      }));

      // Combinar permissões (permissão direta sobrescreve role)
      const allPermissions: Array<{
        id: number;
        name: string;
        guard_name: string;
        source: 'role' | 'direct';
      }> = [...directPermissions];
      const directPermissionIds = directPermissions.map(p => p.id);
      
      rolePermissions.forEach(rolePermission => {
        if (!directPermissionIds.includes(rolePermission.id)) {
          allPermissions.push(rolePermission);
        }
      });

      return {
        role,
        permissions: allPermissions.sort((a, b) => a.name.localeCompare(b.name)),
        permissionNames: allPermissions.map(p => p.name)
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      console.error('Erro ao buscar permissões do usuário:', error);
      throw new BadRequestException('Erro ao buscar permissões do usuário');
    }
  }

  /**
   * Buscar permissões detalhadas do usuário com informações extras
   */
  async getUserPermissionsDetailed(userId: string): Promise<UserPermissionsResponseDto> {
    return this.getUserPermissions(userId);
  }

  /**
   * Cria um resumo estatístico das permissões do usuário
   */
  async getUserPermissionsSummary(userId: string): Promise<UserPermissionsSummaryDto> {
    try {
      const permissionsData = await this.getUserPermissions(userId);
      
      const rolePermissions = permissionsData.permissions.filter(p => p.source === 'role');
      const directPermissions = permissionsData.permissions.filter(p => p.source === 'direct');
      
      // Extrair categorias dos nomes das permissões
      const categories = [...new Set(
        permissionsData.permissions.map(p => {
          // Extrair categoria do nome da permissão (antes do primeiro ponto)
          const parts = p.name.split('.');
          return parts.length > 1 ? parts[0] : 'Outros';
        })
      )].sort();

      return {
        role: permissionsData.role?.name || null,
        totalPermissions: permissionsData.permissions.length,
        rolePermissions: rolePermissions.length,
        directPermissions: directPermissions.length,
        categories
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      console.error('Erro ao criar resumo de permissões:', error);
      throw new BadRequestException('Erro ao criar resumo de permissões');
    }
  }

  /**
   * Organiza as permissões do usuário por categorias
   */
  async getUserPermissionsCategorized(userId: string): Promise<CategorizedPermissionsDto> {
    try {
      const permissionsData = await this.getUserPermissions(userId);
      
      const categorized: CategorizedPermissionsDto = {};
      
      permissionsData.permissions.forEach(permission => {
        // Extrair categoria do nome da permissão
        const parts = permission.name.split('.');
        const category = parts.length > 1 ? parts[0] : 'Outros';
        
        if (!categorized[category]) {
          categorized[category] = [];
        }
        
        categorized[category].push(permission);
      });

      // Ordenar permissões dentro de cada categoria
      Object.keys(categorized).forEach(category => {
        categorized[category].sort((a, b) => a.name.localeCompare(b.name));
      });

      return categorized;
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      console.error('Erro ao categorizar permissões:', error);
      throw new BadRequestException('Erro ao categorizar permissões');
    }
  }

  /**
   * Verifica se um usuário tem uma permissão específica
   */
  async checkUserPermission(userId: string, permissionName: string): Promise<{ hasPermission: boolean }> {
    try {
      const permissionsData = await this.getUserPermissions(userId);
      const hasPermission = permissionsData.permissionNames.includes(permissionName);
      
      return { hasPermission };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      console.error('Erro ao verificar permissão:', error);
      throw new BadRequestException('Erro ao verificar permissão');
    }
  }

  /**
   * Verifica múltiplas permissões do usuário
   */
  async checkUserPermissions(
    userId: string, 
    permissionNames: string[], 
    mode: 'any' | 'all' = 'any'
  ): Promise<{ hasPermissions: boolean; details: Record<string, boolean> }> {
    try {
      const permissionsData = await this.getUserPermissions(userId);
      
      const details: Record<string, boolean> = {};
      const userPermissionNames = permissionsData.permissionNames;
      
      permissionNames.forEach(permission => {
        details[permission] = userPermissionNames.includes(permission);
      });

      const hasPermissions = mode === 'any'
        ? permissionNames.some(permission => userPermissionNames.includes(permission))
        : permissionNames.every(permission => userPermissionNames.includes(permission));

      return { hasPermissions, details };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      console.error('Erro ao verificar permissões:', error);
      throw new BadRequestException('Erro ao verificar permissões');
    }
  }

  /**
   * Atribui uma role para um usuário (substitui a role atual)
   * Sincroniza tanto o sistema Spatie quanto a coluna role para compatibilidade
   */
  /** POST /usuarios/:id/assign-role com a matriz de quem cadastra quem e trilha. */
  async atribuirPapel(userId: string, roleId: number, requester?: Requisitante) {
    const pedido = await this.papelPedido({ roleId });
    const antes = await this.assertPodeGerir(requester, userId, 'editar', pedido?.papel, pedido?.roleName);
    const r = await this.assignRole(userId, roleId);
    if (pedido && antes.role !== pedido.roleName) {
      const u = await this.prisma.usuarios.findFirst({ where: { id: userId }, select: { nome: true } });
      await this.trilha('papel_alterado', requester, { id: userId, nome: u?.nome },
        `Papel de ${u?.nome ?? userId}: ${antes.role ?? '—'} → ${pedido.roleName}`,
        { antes: antes.role, depois: pedido.roleName });
    }
    return r;
  }

  async assignRole(userId: string, roleId: number): Promise<{ message: string; role: any }> {
    try {
      const usuario = await this.prisma.usuarios.findFirst({
        where: { 
          id: userId, 
          deleted_at: null 
        }
      });

      if (!usuario) {
        throw new NotFoundException('Usuário não encontrado');
      }
      
      // Verificar se o role existe
      const role = await this.prisma.roles.findUnique({
        where: { id: BigInt(roleId) },
        include: {
          role_has_permissions: {
            include: {
              permissions: true
            }
          }
        }
      });

      if (!role) {
        throw new NotFoundException('Role não encontrado');
      }

      // Atualizar AMBOS os sistemas em uma transação
      await this.prisma.$transaction(async (tx) => {
        // 1. Sistema Spatie - remover roles existentes
        await tx.model_has_roles.deleteMany({
          where: {
            model_id: userId,
            model_type: 'App\\Models\\User'
          }
        });

        // 2. Sistema Spatie - atribuir novo role
        await tx.model_has_roles.create({
          data: {
            role_id: BigInt(roleId),
            model_id: userId,
            model_type: 'App\\Models\\User'
          }
        });

        // 3. Coluna legacy - sincronizar para compatibilidade com outra aplicação
        await tx.usuarios.update({
          where: { id: userId },
          data: { 
            role: this.mapSpatieRoleToValidDbRole(role.name),
            updated_at: new Date()
          }
        });
      });

      const roleData = {
        id: Number(role.id),
        name: role.name,
        guard_name: role.guard_name,
        permissions: role.role_has_permissions.map(rhp => ({
          id: Number(rhp.permissions.id),
          name: rhp.permissions.name,
          guard_name: rhp.permissions.guard_name
        }))
      };

      return { 
        message: `Role ${role.name} atribuído com sucesso`,
        role: roleData
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      console.error('Erro ao atribuir role:', error);
      throw new BadRequestException('Erro ao atribuir role');
    }
  }

  /**
   * Atribui uma permissão direta ao usuário
   */
  async assignPermission(userId: string, permissionId: number): Promise<{ message: string; permission: any }> {
    try {
      const usuario = await this.prisma.usuarios.findFirst({
        where: { 
          id: userId, 
          deleted_at: null 
        }
      });

      if (!usuario) {
        throw new NotFoundException('Usuário não encontrado');
      }
      
      // Verificar se a permission existe
      const permission = await this.prisma.permissions.findUnique({
        where: { id: BigInt(permissionId) }
      });

      if (!permission) {
        throw new NotFoundException('Permissão não encontrada');
      }

      // Verificar se já tem essa permissão
      const existingPermission = await this.prisma.model_has_permissions.findFirst({
        where: {
          permission_id: BigInt(permissionId),
          model_id: userId,
          model_type: 'App\\Models\\User'
        }
      });

      if (existingPermission) {
        throw new ConflictException('Usuário já possui esta permissão');
      }

      // Atribuir permissão
      await this.prisma.model_has_permissions.create({
        data: {
          permission_id: BigInt(permissionId),
          model_id: userId,
          model_type: 'App\\Models\\User'
        }
      });

      const permissionData = {
        id: Number(permission.id),
        name: permission.name,
        guard_name: permission.guard_name
      };

      return { 
        message: `Permissão ${permission.name} atribuída com sucesso`,
        permission: permissionData
      };
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ConflictException) {
        throw error;
      }
      console.error('Erro ao atribuir permissão:', error);
      throw new BadRequestException('Erro ao atribuir permissão');
    }
  }

  /**
   * Remove uma permissão direta do usuário
   */
  async removePermission(userId: string, permissionId: number): Promise<{ message: string }> {
    try {
      const usuario = await this.prisma.usuarios.findFirst({
        where: { 
          id: userId, 
          deleted_at: null 
        }
      });

      if (!usuario) {
        throw new NotFoundException('Usuário não encontrado');
      }
      
      // Verificar se a permission existe
      const permission = await this.prisma.permissions.findUnique({
        where: { id: BigInt(permissionId) }
      });

      if (!permission) {
        throw new NotFoundException('Permissão não encontrada');
      }

      // Remover permissão
      const deleted = await this.prisma.model_has_permissions.deleteMany({
        where: {
          permission_id: BigInt(permissionId),
          model_id: userId,
          model_type: 'App\\Models\\User'
        }
      });

      if (deleted.count === 0) {
        throw new NotFoundException('Usuário não possui esta permissão');
      }

      return { message: `Permissão ${permission.name} removida com sucesso` };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      console.error('Erro ao remover permissão:', error);
      throw new BadRequestException('Erro ao remover permissão');
    }
  }

  /**
   * Sincroniza permissões diretas do usuário (substitui todas)
   */
  async syncUserPermissions(userId: string, permissionIds: number[]): Promise<{ message: string; permissions: any[] }> {
    try {
      const usuario = await this.prisma.usuarios.findFirst({
        where: { 
          id: userId, 
          deleted_at: null 
        }
      });

      if (!usuario) {
        throw new NotFoundException('Usuário não encontrado');
      }

      // Verificar se todas as permissões existem
      const permissions = await this.prisma.permissions.findMany({
        where: {
          id: { in: permissionIds.map(id => BigInt(id)) }
        }
      });

      if (permissions.length !== permissionIds.length) {
        const foundIds = permissions.map(p => Number(p.id));
        const missingIds = permissionIds.filter(id => !foundIds.includes(id));
        throw new BadRequestException(`Permissões não encontradas: ${missingIds.join(', ')}`);
      }

      // Remover todas as permissões diretas atuais
      await this.prisma.model_has_permissions.deleteMany({
        where: {
          model_id: userId,
          model_type: 'App\\Models\\User'
        }
      });

      // Adicionar as novas permissões
      let newPermissions: any[] = [];
      if (permissionIds.length > 0) {
        await this.prisma.model_has_permissions.createMany({
          data: permissionIds.map(permissionId => ({
            permission_id: BigInt(permissionId),
            model_id: userId,
            model_type: 'App\\Models\\User'
          }))
        });

        // Formatar permissões para resposta
        newPermissions = permissions.map(p => ({
          id: Number(p.id),
          name: p.name,
          guard_name: p.guard_name
        }));
      }

      return { 
        message: 'Permissões sincronizadas com sucesso',
        permissions: newPermissions
      };
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }
      console.error('Erro ao sincronizar permissões:', error);
      throw new BadRequestException('Erro ao sincronizar permissões');
    }
  }

  async bulkAssignRoles(bulkData: BulkAssignRolesDto): Promise<{ success: number; failures: any[] }> {
    let success = 0;
    const failures: any[] = [];

    for (const assignment of bulkData.assignments) {
      try {
        await this.assignRole(assignment.userId, assignment.roleId);
        success++;
      } catch (error) {
        failures.push({
          userId: assignment.userId,
          roleId: assignment.roleId,
          error: error.message
        });
      }
    }

    return { success, failures };
  }

  async bulkAssignPermissions(bulkData: BulkAssignPermissionsDto): Promise<{ success: number; failures: any[] }> {
    let success = 0;
    const failures: any[] = [];

    for (const assignment of bulkData.assignments) {
      try {
        await this.syncUserPermissions(assignment.userId, assignment.permissionIds);
        success++;
      } catch (error) {
        failures.push({
          userId: assignment.userId,
          permissionIds: assignment.permissionIds,
          error: error.message
        });
      }
    }

    return { success, failures };
  }

  async getAllAvailableRoles() {
    try {
      return await this.rolesService.findAll();
    } catch (error) {
      console.error('Erro ao buscar roles disponíveis:', error);
      throw new BadRequestException('Erro ao buscar roles disponíveis');
    }
  }

  async getAllAvailablePermissions() {
    try {
      return await this.permissionsService.findAll();
    } catch (error) {
      console.error('Erro ao buscar permissões disponíveis:', error);
      throw new BadRequestException('Erro ao buscar permissões disponíveis');
    }
  }

  async getAvailablePermissionsGrouped() {
    try {
      return await this.permissionsService.findGrouped();
    } catch (error) {
      console.error('Erro ao buscar permissões agrupadas:', error);
      throw new BadRequestException('Erro ao buscar permissões agrupadas');
    }
  }

  /**
   * Método auxiliar para migrar usuários existentes do sistema legacy para Spatie
   * Use apenas quando necessário para sincronização de dados
   */
  async syncLegacyRolesToSpatie(): Promise<{ migrated: number; errors: any[] }> {
    try {
      let migrated = 0;
      const errors: any[] = [];

      // Buscar usuários que têm role na coluna mas não no sistema Spatie
      const usuariosComRole = await this.prisma.usuarios.findMany({
        where: {
          role: { not: null },
          deleted_at: null,
          is_active: true
        }
      });

      for (const usuario of usuariosComRole) {
        try {
          // Verificar se já tem role no sistema Spatie
          const existingSpatie = await this.prisma.model_has_roles.findFirst({
            where: {
              model_id: usuario.id,
              model_type: 'App\\Models\\User'
            }
          });

          if (!existingSpatie && usuario.role) {
            // Buscar a role pelo nome
            const role = await this.prisma.roles.findFirst({
              where: { name: usuario.role }
            });

            if (role) {
              // Criar associação no sistema Spatie
              await this.prisma.model_has_roles.create({
                data: {
                  role_id: role.id,
                  model_id: usuario.id,
                  model_type: 'App\\Models\\User'
                }
              });
              migrated++;
            } else {
              errors.push({
                userId: usuario.id,
                error: `Role '${usuario.role}' não encontrada na tabela roles`
              });
            }
          }
        } catch (error) {
          errors.push({
            userId: usuario.id,
            error: error.message
          });
        }
      }

      return { migrated, errors };
    } catch (error) {
      console.error('Erro na sincronização legacy -> Spatie:', error);
      throw new BadRequestException('Erro na sincronização de roles');
    }
  }

  /**
   * Método de debug para verificar o estado atual de roles e permissions de um usuário
   */
  async debugUserPermissions(userId: string): Promise<any> {
    try {
      console.log(`🔍 [DEBUG] Verificando permissões para usuário: ${userId}`);

      // 1. Dados básicos do usuário
      const usuario = await this.prisma.usuarios.findFirst({
        where: { id: userId, deleted_at: null }
      });

      if (!usuario) {
        return { error: 'Usuário não encontrado' };
      }

      // 2. Role no sistema Spatie
      const spatieRole = await this.prisma.model_has_roles.findFirst({
        where: {
          model_id: userId,
          model_type: 'App\\Models\\User'
        },
        include: {
          roles: {
            include: {
              role_has_permissions: {
                include: {
                  permissions: true
                }
              }
            }
          }
        }
      });

      // 3. Permissions diretas no sistema Spatie
      const spatieDirectPermissions = await this.prisma.model_has_permissions.findMany({
        where: {
          model_id: userId,
          model_type: 'App\\Models\\User'
        },
        include: {
          permissions: true
        }
      });

      // 4. Resultado do getUserPermissions
      const processedPermissions = await this.getUserPermissions(userId).catch(error => ({
        error: error.message,
        role: null,
        permissions: []
      }));

      return {
        userId,
        basicData: {
          nome: usuario.nome,
          email: usuario.email,
          roleLegacy: usuario.role, // Coluna role da tabela usuarios
          status: usuario.status,
          is_active: usuario.is_active
        },
        spatieData: {
          role: spatieRole ? {
            id: Number(spatieRole.roles.id),
            name: spatieRole.roles.name,
            guard_name: spatieRole.roles.guard_name,
            rolePermissions: spatieRole.roles.role_has_permissions.map(rhp => ({
              id: Number(rhp.permissions.id),
              name: rhp.permissions.name,
              guard_name: rhp.permissions.guard_name
            }))
          } : null,
          directPermissions: spatieDirectPermissions.map(mhp => ({
            id: Number(mhp.permissions.id),
            name: mhp.permissions.name,
            guard_name: mhp.permissions.guard_name
          }))
        },
        processedResult: processedPermissions,
        counts: {
          rolePermissions: spatieRole?.roles.role_has_permissions.length || 0,
          directPermissions: spatieDirectPermissions.length,
          totalProcessed: processedPermissions.permissions?.length || 0
        }
      };

    } catch (error) {
      console.error('Erro no debug de permissões:', error);
      return { 
        userId, 
        error: error.message,
        stack: error.stack 
      };
    }
  }

  /**
   * Processa atribuição inicial de roles e permissions durante a criação
   */
  private async processInitialRoleAndPermissionAssignment(userId: string, data: CreateUsuarioDto): Promise<void> {
    try {
      // 1. Atribuir role específica se fornecida (sobrescreve a role padrão)
      if (data.roleId) {
        await this.assignRole(userId, data.roleId);
      }

      // 2. Atribuir permissions diretas se fornecidas
      if (data.permissionIds && data.permissionIds.length > 0) {
        await this.syncUserPermissions(userId, data.permissionIds);
      }

      // 3. Suporte legacy para roleNames (deprecated)
      if (data.roleNames && data.roleNames.length > 0) {
        // Atribuir primeira role da lista
        const role = await this.prisma.roles.findFirst({
          where: { name: data.roleNames[0] }
        });
        
        if (role) {
          await this.assignRole(userId, Number(role.id));
        }
      }

      // 4. Suporte legacy para permissions por nome (deprecated)
      if (data.permissions && data.permissions.length > 0) {
        // Converter nomes de permissions para IDs
        const permissions = await this.prisma.permissions.findMany({
          where: { 
            name: { in: data.permissions } 
          }
        });

        const permissionIds = permissions.map(p => Number(p.id));
        if (permissionIds.length > 0) {
          await this.syncUserPermissions(userId, permissionIds);
        }
      }

    } catch (error) {
      console.error('Erro ao processar atribuição inicial de roles/permissions:', error);
      // Não fazer throw aqui para não quebrar a criação do usuário
      // O usuário será criado com role padrão
    }
  }

  /**
   * Processa atualizações de roles e permissions durante o update
   */
  private async processRoleAndPermissionUpdates(userId: string, data: UpdateUsuarioDto): Promise<void> {
    try {
      // 1. Limpar role se solicitado
      if (data.clearRole) {
        await this.prisma.model_has_roles.deleteMany({
          where: {
            model_id: userId,
            model_type: 'App\\Models\\User'
          }
        });

        // Atualizar coluna legacy para null
        await this.prisma.usuarios.update({
          where: { id: userId },
          data: { role: null }
        });
      }

      // 2. Atribuir nova role se fornecida
      if (data.roleId) {
        await this.assignRole(userId, data.roleId);
      }

      // 3. Limpar permissions diretas se solicitado
      if (data.clearDirectPermissions) {
        await this.prisma.model_has_permissions.deleteMany({
          where: {
            model_id: userId,
            model_type: 'App\\Models\\User'
          }
        });
      }

      // 4. Sincronizar permissions se fornecidas
      if (data.permissionIds && Array.isArray(data.permissionIds)) {
        await this.syncUserPermissions(userId, data.permissionIds);
      }

      // 5. Suporte legacy para roleNames e permissions (deprecated)
      if (data.roleNames && data.roleNames.length > 0) {
        // Buscar primeira role pelo nome e atribuir
        const role = await this.prisma.roles.findFirst({
          where: { name: data.roleNames[0] }
        });
        
        if (role) {
          await this.assignRole(userId, Number(role.id));
        }
      }

      if (data.permissions && data.permissions.length > 0) {
        // Converter nomes de permissions para IDs
        const permissions = await this.prisma.permissions.findMany({
          where: { 
            name: { in: data.permissions } 
          }
        });

        const permissionIds = permissions.map(p => Number(p.id));
        if (permissionIds.length > 0) {
          await this.syncUserPermissions(userId, permissionIds);
        }
      }

    } catch (error) {
      console.error('Erro ao processar atualizações de roles/permissions:', error);
      throw new BadRequestException('Erro ao atualizar roles e permissions');
    }
  }

  // ============================================================================
  // MÉTODOS AUXILIARES PARA CONSTRAINT DE ROLE
  // ============================================================================

  /**
   * Retorna o nome da role do Spatie diretamente para a coluna role
   * NOTA: A constraint CHECK foi removida em 2025-12-09, então agora a coluna aceita qualquer valor
   * Mantido para compatibilidade com aplicação legacy, mas não faz mais mapeamento
   */
  private mapSpatieRoleToValidDbRole(spatieRoleName: string): string {
    if (!spatieRoleName) return 'vendedor'; // fallback seguro apenas se NULL

    // ✅ ATUALIZADO: Constraint CHECK foi removida, retornar o valor original
    console.log(`✅ [ROLE SYNC] Sincronizando role '${spatieRoleName}' na coluna legacy`);
    return spatieRoleName;
  }

  /**
   * Descobre quais valores são permitidos no constraint da coluna role
   */
  async discoverValidRoleConstraint(): Promise<{ constraintName: string; allowedValues: string[] }> {
    try {
      console.log('🔍 [CONSTRAINT DISCOVERY] Descobrindo constraint da coluna role...');
      
      const constraints = await this.prisma.$queryRaw`
        SELECT 
          conname, 
          pg_get_constraintdef(oid) as constraint_def
        FROM pg_constraint 
        WHERE conrelid = 'usuarios'::regclass 
        AND contype = 'c'
        AND conname LIKE '%role%'
      ` as any[];

      console.log('📋 [CONSTRAINT DISCOVERY] Constraints encontrados:', constraints);

      for (const constraint of constraints) {
        const { conname, constraint_def } = constraint;
        
        // Extrair valores do constraint (ex: "CHECK (role IN ('admin', 'vendedor', ...))")
        const match = constraint_def.match(/\(role\s*IN\s*\((.*?)\)\)/i);
        if (match) {
          const valuesString = match[1];
          const allowedValues = valuesString
            .split(',')
            .map((v: string) => v.trim().replace(/['"]/g, ''))
            .filter((v: string) => v.length > 0);

          console.log(`✅ [CONSTRAINT DISCOVERY] Constraint '${conname}' permite: [${allowedValues.join(', ')}]`);
          
          return {
            constraintName: conname,
            allowedValues
          };
        }
      }

      console.log('⚠️ [CONSTRAINT DISCOVERY] Nenhum constraint de role encontrado, usando valores padrão');
      return {
        constraintName: 'unknown',
        allowedValues: ['admin', 'gerente', 'vendedor', 'consultor'] // valores assumidos
      };

    } catch (error) {
      console.error('❌ [CONSTRAINT DISCOVERY] Erro ao descobrir constraint:', error);
      return {
        constraintName: 'error',
        allowedValues: ['admin', 'gerente', 'vendedor', 'consultor'] // fallback seguro
      };
    }
  }

  /**
   * Valida se um valor de role é aceito pelo constraint do banco
   */
  private async validateRoleConstraint(roleValue: string): Promise<boolean> {
    try {
      const { allowedValues } = await this.discoverValidRoleConstraint();
      const isValid = allowedValues.includes(roleValue);
      
      if (!isValid) {
        console.log(`❌ [ROLE VALIDATION] Role '${roleValue}' não é válida. Valores permitidos: [${allowedValues.join(', ')}]`);
      } else {
        console.log(`✅ [ROLE VALIDATION] Role '${roleValue}' é válida`);
      }
      
      return isValid;
    } catch (error) {
      console.error('❌ [ROLE VALIDATION] Erro na validação:', error);
      return false; // em caso de erro, assumir inválido para ser seguro
    }
  }

  // ============================================================================
  // MÉTODOS AUXILIARES
  // ============================================================================

  private async mapToUsuarioResponseDtoOptimized(usuario: any): Promise<UsuarioResponseDto> {
    // ✅ SIMPLIFICADO: Usar apenas a coluna role da tabela usuarios
    const role = usuario.role || 'vendedor'; // Default apenas se NULL

    return {
      id: usuario.id,
      status: usuario.status as UsuarioStatus,
      concessionaria_atual_id: usuario.concessionaria_atual_id,
      organizacao_atual: usuario.organizacao_atual_id,
      nome: usuario.nome,
      email: usuario.email,
      telefone: usuario.telefone,
      instagram: usuario.instagram,
      cpf_cnpj: usuario.cpf_cnpj,
      cidade: usuario.cidade,
      estado: usuario.estado,
      endereco: usuario.endereco,
      cep: usuario.cep,
      manager_id: usuario.manager_id,
      avatar_url: usuario.avatar_url,
      role: role, // ← Campo role direto
      all_permissions: [],
      roles: [role], // ← Array com a role para compatibilidade
      created_at: usuario.created_at,
      updated_at: usuario.updated_at,
    };
  }

  private async mapToUsuarioResponseDto(usuario: any): Promise<UsuarioResponseDto> {
    try {
      // Buscar permissões e roles do usuário de forma mais robusta
      const userPermissions = await this.getUserPermissions(usuario.id).catch((error) => {
        console.error(`Erro ao buscar permissions para usuário ${usuario.id}:`, error);
        return {
          role: null,
          permissions: [],
          permissionNames: []
        };
      });

      // Garantir que all_permissions seja um array de objetos corretos
      const allPermissions = userPermissions.permissions || [];

      return {
        id: usuario.id,
        status: usuario.status as UsuarioStatus,
        concessionaria_atual_id: usuario.concessionaria_atual_id,
        organizacao_atual: usuario.organizacao_atual_id,
        nome: usuario.nome,
        email: usuario.email,
        telefone: usuario.telefone,
        instagram: usuario.instagram,
        cpf_cnpj: usuario.cpf_cnpj,
        cidade: usuario.cidade,
        estado: usuario.estado,
        endereco: usuario.endereco,
        cep: usuario.cep,
        manager_id: usuario.manager_id,
        avatar_url: usuario.avatar_url, // ← ADICIONADO
        all_permissions: allPermissions, // Array de objetos com id, name, guard_name, source
        roles: userPermissions.role ? [userPermissions.role] : [], // ✅ CORRIGIDO: retornar objeto completo
        role_details: userPermissions.role || undefined,
        created_at: usuario.created_at,
        updated_at: usuario.updated_at,
      };
    } catch (error) {
      console.error('Erro crítico no mapeamento do usuário:', error);
      // Fallback para dados básicos se algo der errado
      return {
        id: usuario.id,
        status: usuario.status as UsuarioStatus,
        concessionaria_atual_id: usuario.concessionaria_atual_id,
        organizacao_atual: usuario.organizacao_atual_id,
        nome: usuario.nome,
        email: usuario.email,
        telefone: usuario.telefone,
        instagram: usuario.instagram,
        cpf_cnpj: usuario.cpf_cnpj,
        cidade: usuario.cidade,
        estado: usuario.estado,
        endereco: usuario.endereco,
        cep: usuario.cep,
        manager_id: usuario.manager_id,
        avatar_url: usuario.avatar_url, // ← ADICIONADO
        all_permissions: [], // Array vazio em caso de erro
        roles: [],
        role_details: undefined,
        created_at: usuario.created_at,
        updated_at: usuario.updated_at,
      };
    }
  }

  /**
   * Método para descobrir valores válidos no constraint da coluna role
   * Útil para debugging e administração
   */
  async getValidRoleConstraintValues(): Promise<string[]> {
    try {
      const result = await this.prisma.$queryRaw`
        SELECT conname, consrc 
        FROM pg_constraint 
        WHERE conrelid = 'usuarios'::regclass 
        AND contype = 'c'
        AND conname LIKE '%role%'
      ` as any[];

      if (result && result.length > 0) {
        // Extrair valores do constraint check
        const constraintSrc = result[0].consrc;
        // Regex para extrair valores entre aspas simples
        const matches = constraintSrc.match(/'[^']+'/g);
        if (matches) {
          return matches.map((match: string) => match.replace(/'/g, ''));
        }
      }

      // Fallback se não conseguir descobrir via query
      return ['gerente', 'vendedor', 'admin'];
    } catch (error) {
      console.error('Erro ao descobrir valores do constraint:', error);
      return ['gerente', 'vendedor', 'admin']; // valores conhecidos
    }
  }
}