import { Test, TestingModule } from '@nestjs/testing';
import { UsuariosService } from './usuarios.service';
import { RolesService } from '../roles/roles.service';
import { PermissionsService } from '../permissions/permissions.service';
import { MailService } from '../../mail/mail.service';
import { PrismaService } from '../../prisma/prisma.service';
import { 
  NotFoundException, 
  ConflictException, 
  BadRequestException 
} from '@nestjs/common';
import { 
  CreateUsuarioDto, 
  UpdateUsuarioDto, 
  UsuarioQueryDto,
  ChangePasswordDto,
  ResetPasswordDto,
  UsuarioStatus,
  UserPermissionsResponseDto,
  UserPermissionsSummaryDto,
  CategorizedPermissionsDto,
  BulkAssignRolesDto,
  BulkAssignPermissionsDto
} from './dto';
import * as bcrypt from 'bcryptjs';

// Mock do bcrypt
jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('hashed-password'),
  compare: jest.fn().mockResolvedValue(true)
}));

// Mock do nanoid
jest.mock('nanoid', () => ({
  customAlphabet: jest.fn(() => jest.fn(() => 'mock-user-id-123456789012345678'))
}));

describe('UsuariosService - Testes Completos com Roles e Permissions', () => {
  let service: UsuariosService;
  let prisma: PrismaService;
  let rolesService: RolesService;
  let permissionsService: PermissionsService;

  // Mock completo do PrismaService
  const mockPrismaService = {
    usuarios: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    roles: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    permissions: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    model_has_roles: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      createMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    model_has_permissions: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      createMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  };

  // Mock dos serviços
  const mockRolesService = {
    findAll: jest.fn(),
    findOne: jest.fn(),
  };

  const mockPermissionsService = {
    findAll: jest.fn(),
    findOne: jest.fn(),
    findGrouped: jest.fn(),
  };

  // Dados de teste
  const usuarioMock = {
    id: 'usr_2024_test_12345',
    nome: 'João Silva Santos',
    email: 'joao.silva@empresa.com.br',
    telefone: '(11) 98765-4321',
    instagram: '@joao_silva',
    status: UsuarioStatus.ATIVO,
    cpf_cnpj: '123.456.789-00',
    cidade: 'São Paulo',
    estado: 'SP',
    endereco: 'Rua das Flores, 123',
    cep: '01234-567',
    role: 'admin',
    manager_id: 'mgr_123456789',
    concessionaria_atual_id: 'conc_sp_001',
    organizacao_atual_id: 'org_sp_001',
    is_active: true,
    senha: 'hashed-password',
    created_at: new Date('2024-01-15T10:30:00Z'),
    updated_at: new Date('2024-08-19T14:25:00Z'),
    deleted_at: null,
  };

  const rolesMock = [
    { id: BigInt(1), name: 'admin', guard_name: 'web', created_at: new Date(), updated_at: new Date() },
    { id: BigInt(2), name: 'user', guard_name: 'web', created_at: new Date(), updated_at: new Date() }
  ];

  const permissionsMock = [
    { id: BigInt(1), name: 'Dashboard', guard_name: 'web', created_at: new Date(), updated_at: new Date() },
    { id: BigInt(2), name: 'Usuarios', guard_name: 'web', created_at: new Date(), updated_at: new Date() },
    { id: BigInt(3), name: 'MonitoramentoConsumo', guard_name: 'web', created_at: new Date(), updated_at: new Date() }
  ];

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsuariosService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: RolesService,
          useValue: mockRolesService,
        },
        {
          provide: PermissionsService,
          useValue: mockPermissionsService,
        },
        {
          // UsuariosService injeta MailService no construtor mas nao chama nenhum
          // metodo dele hoje — mock vazio basta para o Nest resolver a dependencia.
          provide: MailService,
          useValue: {},
        },
      ],
    }).compile();

    service = module.get<UsuariosService>(UsuariosService);
    prisma = module.get<PrismaService>(PrismaService);
    rolesService = module.get<RolesService>(RolesService);
    permissionsService = module.get<PermissionsService>(PermissionsService);

    // Reset mocks
    jest.clearAllMocks();
    (bcrypt.hash as jest.Mock).mockResolvedValue('hashed-password');
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
  });

  // ============================================================================
  // TESTES DOS MÉTODOS BÁSICOS (CRUD)
  // ============================================================================

  describe('findAll', () => {
    it('should return paginated users with all filters', async () => {
      const query: UsuarioQueryDto = {
        page: 1,
        limit: 10,
        search: 'João',
        status: UsuarioStatus.ATIVO,
        role: 'admin',
        cidade: 'São Paulo',
        estado: 'SP',
        concessionariaId: 'conc_sp_001',
        organizacaoId: 'org_sp_001',
        includeInactive: false,
      };

      mockPrismaService.usuarios.findMany.mockResolvedValue([usuarioMock]);
      mockPrismaService.usuarios.count.mockResolvedValue(1);
      
      // Mock para mapToUsuarioResponseDto
      mockPrismaService.model_has_roles.findFirst.mockResolvedValue({
        roles: {
          id: BigInt(1),
          name: 'admin',
          guard_name: 'web',
          role_has_permissions: []
        }
      });
      mockPrismaService.model_has_permissions.findMany.mockResolvedValue([]);

      const result = await service.findAll(query);

      expect(result.data).toHaveLength(1);
      expect(result.pagination.page).toBe(1);
      expect(result.pagination.limit).toBe(10);
      expect(result.pagination.total).toBe(1);
      expect(mockPrismaService.usuarios.findMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          deleted_at: null,
          is_active: true,
          status: UsuarioStatus.ATIVO,
          role: 'admin',
          OR: expect.any(Array)
        }),
        orderBy: { created_at: 'desc' },
        skip: 0,
        take: 10,
      });
    });
  });

  describe('findOne', () => {
    it('should return user by id with permissions and roles', async () => {
      mockPrismaService.usuarios.findFirst.mockResolvedValue(usuarioMock);
      
      // Mock para getUserPermissions
      mockPrismaService.model_has_roles.findFirst.mockResolvedValue({
        roles: {
          id: BigInt(1),
          name: 'admin',
          guard_name: 'web',
          role_has_permissions: [{
            permissions: { id: BigInt(1), name: 'Dashboard', guard_name: 'web' }
          }]
        }
      });
      mockPrismaService.model_has_permissions.findMany.mockResolvedValue([]);

      const result = await service.findOne('usr_2024_test_12345');

      expect(result.id).toBe('usr_2024_test_12345');
      expect(result.nome).toBe('João Silva Santos');
      expect(result.email).toBe('joao.silva@empresa.com.br');
    });

    it('should throw NotFoundException when user not found', async () => {
      mockPrismaService.usuarios.findFirst.mockResolvedValue(null);

      await expect(service.findOne('invalid-id')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('should create user with discovery of valid roles', async () => {
      const createDto: CreateUsuarioDto = {
        nome: 'Novo Usuário',
        email: 'novo@teste.com',
        status: UsuarioStatus.ATIVO
      };

      const createdUser = {
        id: 'novo-usuario-id',
        nome: 'Novo Usuário',
        email: 'novo@teste.com',
        status: UsuarioStatus.ATIVO,
        role: 'user',
        created_at: new Date(),
        updated_at: new Date(),
        is_active: true,
        senha: 'hashed-password'
      };

      // Mock das verificações
      mockPrismaService.usuarios.findFirst.mockResolvedValueOnce(null); // Email não existe
      mockPrismaService.$queryRaw.mockResolvedValue([]); // discoverValidRoles

      // Mock do teste de roles
      mockPrismaService.usuarios.create
        .mockRejectedValueOnce(new Error('Invalid role')) // Falha com 'admin'
        .mockResolvedValueOnce({ id: 'test-user-1', role: 'user' }) // Sucesso com 'user'
        .mockResolvedValueOnce(createdUser); // Usuário real criado

      mockPrismaService.usuarios.delete.mockResolvedValue({});

      // Mock para mapToUsuarioResponseDto - usar dados do usuário criado
      mockPrismaService.model_has_roles.findFirst.mockResolvedValue(null);
      mockPrismaService.model_has_permissions.findMany.mockResolvedValue([]);

      const result = await service.create(createDto);

      expect(result.nome).toBe('Novo Usuário');
      expect(result.senhaTemporaria).toBe('Aupus123!');
      expect(result.primeiroAcesso).toBe(true);
      expect(mockPrismaService.usuarios.create).toHaveBeenCalledTimes(3); // 2 testes + 1 real
    });

    it('should throw ConflictException when email already exists', async () => {
      const createDto: CreateUsuarioDto = {
        nome: 'Usuário Duplicado',
        email: 'existente@teste.com',
        status: UsuarioStatus.ATIVO
      };

      mockPrismaService.usuarios.findFirst.mockResolvedValue(usuarioMock);

      await expect(service.create(createDto)).rejects.toThrow(ConflictException);
    });
  });

  describe('update', () => {
    it('should update user successfully', async () => {
      const updateDto: UpdateUsuarioDto = {
        nome: 'João Silva Atualizado',
        email: 'joao.atualizado@empresa.com'
      };

      mockPrismaService.usuarios.findFirst
        .mockResolvedValueOnce(usuarioMock) // Usuário existe
        .mockResolvedValueOnce(null); // Email não está em uso

      const updatedUser = { ...usuarioMock, ...updateDto, updated_at: new Date() };
      mockPrismaService.usuarios.update.mockResolvedValue(updatedUser);

      // Mock para mapToUsuarioResponseDto
      mockPrismaService.model_has_roles.findFirst.mockResolvedValue(null);
      mockPrismaService.model_has_permissions.findMany.mockResolvedValue([]);

      const result = await service.update('usr_2024_test_12345', updateDto);

      expect(result.nome).toBe('João Silva Atualizado');
      expect(mockPrismaService.usuarios.update).toHaveBeenCalledWith({
        where: { id: 'usr_2024_test_12345' },
        data: expect.objectContaining({
          nome: 'João Silva Atualizado',
          email: 'joao.atualizado@empresa.com',
          updated_at: expect.any(Date)
        })
      });
    });
  });

  describe('remove', () => {
    it('should soft delete user', async () => {
      mockPrismaService.usuarios.findFirst.mockResolvedValue(usuarioMock);
      mockPrismaService.usuarios.update.mockResolvedValue({});

      const result = await service.remove('usr_2024_test_12345');

      expect(result.message).toBe('Usuário excluído com sucesso');
      expect(mockPrismaService.usuarios.update).toHaveBeenCalledWith({
        where: { id: 'usr_2024_test_12345' },
        data: {
          deleted_at: expect.any(Date),
          is_active: false,
          status: UsuarioStatus.INATIVO,
        }
      });
    });
  });

  // ============================================================================
  // TESTES DE GESTÃO DE SENHAS
  // ============================================================================

  describe('changePassword', () => {
    it('should change password successfully', async () => {
      const changePasswordDto: ChangePasswordDto = {
        senhaAtual: 'senha-atual',
        novaSenha: 'nova-senha-123'
      };

      mockPrismaService.usuarios.findFirst.mockResolvedValue(usuarioMock);
      mockPrismaService.usuarios.update.mockResolvedValue({});
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const result = await service.changePassword('usr_2024_test_12345', changePasswordDto);

      expect(result.message).toBe('Senha alterada com sucesso');
      expect(bcrypt.compare).toHaveBeenCalledWith('senha-atual', 'hashed-password');
      expect(bcrypt.hash).toHaveBeenCalledWith('nova-senha-123', 12);
    });

    it('should throw error for incorrect current password', async () => {
      const changePasswordDto: ChangePasswordDto = {
        senhaAtual: 'senha-errada',
        novaSenha: 'nova-senha-123'
      };

      mockPrismaService.usuarios.findFirst.mockResolvedValue(usuarioMock);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(service.changePassword('usr_2024_test_12345', changePasswordDto))
        .rejects.toThrow(BadRequestException);
    });
  });

  describe('resetPassword', () => {
    it('should reset password successfully', async () => {
      const resetPasswordDto: ResetPasswordDto = {
        novaSenha: 'senha-resetada-123',
        confirmarSenha: 'senha-resetada-123'
      };

      mockPrismaService.usuarios.findFirst.mockResolvedValue(usuarioMock);
      mockPrismaService.usuarios.update.mockResolvedValue({});

      const result = await service.resetPassword('usr_2024_test_12345', resetPasswordDto);

      expect(result.message).toBe('Senha resetada com sucesso');
      expect(result.senhaTemporaria).toBe('senha-resetada-123');
    });
  });

  // ============================================================================
  // TESTES DE GESTÃO DE PERMISSIONS E ROLES
  // ============================================================================

  describe('getUserPermissions', () => {
    it('should return user permissions from role and direct', async () => {
      mockPrismaService.usuarios.findFirst.mockResolvedValue(usuarioMock);
      
      // Mock role com permissions
      mockPrismaService.model_has_roles.findFirst.mockResolvedValue({
        roles: {
          id: BigInt(1),
          name: 'admin',
          guard_name: 'web',
          role_has_permissions: [
            {
              permissions: { id: BigInt(1), name: 'Dashboard', guard_name: 'web' }
            },
            {
              permissions: { id: BigInt(2), name: 'Usuarios', guard_name: 'web' }
            }
          ]
        }
      });

      // Mock direct permissions
      mockPrismaService.model_has_permissions.findMany.mockResolvedValue([
        {
          permissions: { id: BigInt(3), name: 'MonitoramentoConsumo', guard_name: 'web' }
        }
      ]);

      const result = await service.getUserPermissions('usr_2024_test_12345');

      expect(result.role).toEqual({
        id: 1,
        name: 'admin',
        guard_name: 'web'
      });
      expect(result.permissions).toHaveLength(3);
      expect(result.permissions.find(p => p.source === 'role')).toBeTruthy();
      expect(result.permissions.find(p => p.source === 'direct')).toBeTruthy();
      expect(result.permissionNames).toContain('Dashboard');
      expect(result.permissionNames).toContain('Usuarios');
      expect(result.permissionNames).toContain('MonitoramentoConsumo');
    });

    it('should handle user without roles or permissions', async () => {
      mockPrismaService.usuarios.findFirst.mockResolvedValue(usuarioMock);
      mockPrismaService.model_has_roles.findFirst.mockResolvedValue(null);
      mockPrismaService.model_has_permissions.findMany.mockResolvedValue([]);

      const result = await service.getUserPermissions('usr_2024_test_12345');

      expect(result.role).toBeNull();
      expect(result.permissions).toHaveLength(0);
      expect(result.permissionNames).toHaveLength(0);
    });
  });

  describe('getUserPermissionsSummary', () => {
    it('should return permissions summary', async () => {
      // Reutilizar mock do getUserPermissions
      mockPrismaService.usuarios.findFirst.mockResolvedValue(usuarioMock);
      mockPrismaService.model_has_roles.findFirst.mockResolvedValue({
        roles: {
          id: BigInt(1),
          name: 'admin',
          guard_name: 'web',
          role_has_permissions: [
            { permissions: { id: BigInt(1), name: 'Dashboard.View', guard_name: 'web' } },
            { permissions: { id: BigInt(2), name: 'Users.Create', guard_name: 'web' } }
          ]
        }
      });
      mockPrismaService.model_has_permissions.findMany.mockResolvedValue([
        { permissions: { id: BigInt(3), name: 'Reports.Export', guard_name: 'web' } }
      ]);

      const result = await service.getUserPermissionsSummary('usr_2024_test_12345');

      expect(result.role).toBe('admin');
      expect(result.totalPermissions).toBe(3);
      expect(result.rolePermissions).toBe(2);
      expect(result.directPermissions).toBe(1);
      expect(result.categories).toContain('Dashboard');
      expect(result.categories).toContain('Users');
      expect(result.categories).toContain('Reports');
    });
  });

  describe('getUserPermissionsCategorized', () => {
    it('should return permissions categorized', async () => {
      mockPrismaService.usuarios.findFirst.mockResolvedValue(usuarioMock);
      mockPrismaService.model_has_roles.findFirst.mockResolvedValue({
        roles: {
          id: BigInt(1),
          name: 'admin',
          guard_name: 'web',
          role_has_permissions: [
            { permissions: { id: BigInt(1), name: 'Dashboard.View', guard_name: 'web' } },
            { permissions: { id: BigInt(2), name: 'Dashboard.Edit', guard_name: 'web' } },
            { permissions: { id: BigInt(3), name: 'Users.Create', guard_name: 'web' } }
          ]
        }
      });
      mockPrismaService.model_has_permissions.findMany.mockResolvedValue([]);

      const result = await service.getUserPermissionsCategorized('usr_2024_test_12345');

      expect(result['Dashboard']).toHaveLength(2);
      expect(result['Users']).toHaveLength(1);
      expect(result['Dashboard'][0].name).toBe('Dashboard.Edit'); // Ordenado alfabeticamente
      expect(result['Dashboard'][1].name).toBe('Dashboard.View');
    });
  });

  describe('checkUserPermission', () => {
    it('should return true when user has permission', async () => {
      mockPrismaService.usuarios.findFirst.mockResolvedValue(usuarioMock);
      mockPrismaService.model_has_roles.findFirst.mockResolvedValue({
        roles: {
          id: BigInt(1),
          name: 'admin',
          guard_name: 'web',
          role_has_permissions: [
            { permissions: { id: BigInt(1), name: 'Dashboard', guard_name: 'web' } }
          ]
        }
      });
      mockPrismaService.model_has_permissions.findMany.mockResolvedValue([]);

      const result = await service.checkUserPermission('usr_2024_test_12345', 'Dashboard');

      expect(result.hasPermission).toBe(true);
    });

    it('should return false when user does not have permission', async () => {
      mockPrismaService.usuarios.findFirst.mockResolvedValue(usuarioMock);
      mockPrismaService.model_has_roles.findFirst.mockResolvedValue(null);
      mockPrismaService.model_has_permissions.findMany.mockResolvedValue([]);

      const result = await service.checkUserPermission('usr_2024_test_12345', 'NonExistent');

      expect(result.hasPermission).toBe(false);
    });
  });

  describe('checkUserPermissions', () => {
    it('should check multiple permissions with "any" mode', async () => {
      mockPrismaService.usuarios.findFirst.mockResolvedValue(usuarioMock);
      mockPrismaService.model_has_roles.findFirst.mockResolvedValue({
        roles: {
          id: BigInt(1),
          name: 'admin',
          guard_name: 'web',
          role_has_permissions: [
            { permissions: { id: BigInt(1), name: 'Dashboard', guard_name: 'web' } }
          ]
        }
      });
      mockPrismaService.model_has_permissions.findMany.mockResolvedValue([]);

      const result = await service.checkUserPermissions(
        'usr_2024_test_12345', 
        ['Dashboard', 'NonExistent'], 
        'any'
      );

      expect(result.hasPermissions).toBe(true);
      expect(result.details['Dashboard']).toBe(true);
      expect(result.details['NonExistent']).toBe(false);
    });

    it('should check multiple permissions with "all" mode', async () => {
      mockPrismaService.usuarios.findFirst.mockResolvedValue(usuarioMock);
      mockPrismaService.model_has_roles.findFirst.mockResolvedValue({
        roles: {
          id: BigInt(1),
          name: 'admin',
          guard_name: 'web',
          role_has_permissions: [
            { permissions: { id: BigInt(1), name: 'Dashboard', guard_name: 'web' } }
          ]
        }
      });
      mockPrismaService.model_has_permissions.findMany.mockResolvedValue([]);

      const result = await service.checkUserPermissions(
        'usr_2024_test_12345', 
        ['Dashboard', 'NonExistent'], 
        'all'
      );

      expect(result.hasPermissions).toBe(false);
    });
  });

  describe('assignRole', () => {
    it('should assign role to user successfully', async () => {
      mockPrismaService.usuarios.findFirst.mockResolvedValue(usuarioMock);
      mockPrismaService.roles.findUnique.mockResolvedValue({
        id: BigInt(2),
        name: 'manager',
        guard_name: 'web',
        role_has_permissions: [
          { permissions: { id: BigInt(1), name: 'Dashboard', guard_name: 'web' } }
        ]
      });
      mockPrismaService.model_has_roles.deleteMany.mockResolvedValue({});
      mockPrismaService.model_has_roles.create.mockResolvedValue({});

      const result = await service.assignRole('usr_2024_test_12345', 2);

      expect(result.message).toBe('Role manager atribuído com sucesso');
      expect(result.role.name).toBe('manager');
      expect(mockPrismaService.model_has_roles.deleteMany).toHaveBeenCalledWith({
        where: {
          model_id: 'usr_2024_test_12345',
          model_type: 'App\\Models\\User'
        }
      });
      expect(mockPrismaService.model_has_roles.create).toHaveBeenCalledWith({
        data: {
          role_id: BigInt(2),
          model_id: 'usr_2024_test_12345',
          model_type: 'App\\Models\\User'
        }
      });
    });

    it('should throw NotFoundException when role does not exist', async () => {
      mockPrismaService.usuarios.findFirst.mockResolvedValue(usuarioMock);
      mockPrismaService.roles.findUnique.mockResolvedValue(null);

      await expect(service.assignRole('usr_2024_test_12345', 999))
        .rejects.toThrow(NotFoundException);
    });
  });

  describe('assignPermission', () => {
    it('should assign direct permission to user', async () => {
      mockPrismaService.usuarios.findFirst.mockResolvedValue(usuarioMock);
      mockPrismaService.permissions.findUnique.mockResolvedValue({
        id: BigInt(5),
        name: 'SpecialAccess',
        guard_name: 'web'
      });
      mockPrismaService.model_has_permissions.findFirst.mockResolvedValue(null); // Não tem a permissão
      mockPrismaService.model_has_permissions.create.mockResolvedValue({});

      const result = await service.assignPermission('usr_2024_test_12345', 5);

      expect(result.message).toBe('Permissão SpecialAccess atribuída com sucesso');
      expect(result.permission.name).toBe('SpecialAccess');
    });

    it('should throw ConflictException when user already has permission', async () => {
      mockPrismaService.usuarios.findFirst.mockResolvedValue(usuarioMock);
      mockPrismaService.permissions.findUnique.mockResolvedValue(permissionsMock[0]);
      mockPrismaService.model_has_permissions.findFirst.mockResolvedValue({}); // Já tem a permissão

      await expect(service.assignPermission('usr_2024_test_12345', 1))
        .rejects.toThrow(ConflictException);
    });
  });

  describe('removePermission', () => {
    it('should remove direct permission from user', async () => {
      mockPrismaService.usuarios.findFirst.mockResolvedValue(usuarioMock);
      mockPrismaService.permissions.findUnique.mockResolvedValue(permissionsMock[0]);
      mockPrismaService.model_has_permissions.deleteMany.mockResolvedValue({ count: 1 });

      const result = await service.removePermission('usr_2024_test_12345', 1);

      expect(result.message).toBe('Permissão Dashboard removida com sucesso');
    });

    it('should throw NotFoundException when user does not have permission', async () => {
      mockPrismaService.usuarios.findFirst.mockResolvedValue(usuarioMock);
      mockPrismaService.permissions.findUnique.mockResolvedValue(permissionsMock[0]);
      mockPrismaService.model_has_permissions.deleteMany.mockResolvedValue({ count: 0 });

      await expect(service.removePermission('usr_2024_test_12345', 1))
        .rejects.toThrow(NotFoundException);
    });
  });

  describe('syncUserPermissions', () => {
    it('should sync user permissions successfully', async () => {
      mockPrismaService.usuarios.findFirst.mockResolvedValue(usuarioMock);
      mockPrismaService.permissions.findMany.mockResolvedValue([
        permissionsMock[0], // Dashboard
        permissionsMock[1], // Usuarios
      ]);
      mockPrismaService.model_has_permissions.deleteMany.mockResolvedValue({});
      mockPrismaService.model_has_permissions.createMany.mockResolvedValue({});

      const result = await service.syncUserPermissions('usr_2024_test_12345', [1, 2]);

      expect(result.message).toBe('Permissões sincronizadas com sucesso');
      expect(result.permissions).toHaveLength(2);
      expect(result.permissions[0].name).toBe('Dashboard');
      expect(result.permissions[1].name).toBe('Usuarios');
    });

    it('should throw BadRequestException when some permissions do not exist', async () => {
      mockPrismaService.usuarios.findFirst.mockResolvedValue(usuarioMock);
      mockPrismaService.permissions.findMany.mockResolvedValue([permissionsMock[0]]); // Apenas 1 de 2

      await expect(service.syncUserPermissions('usr_2024_test_12345', [1, 999]))
        .rejects.toThrow(BadRequestException);
    });
  });

  // ============================================================================
  // TESTES DE OPERAÇÕES EM LOTE
  // ============================================================================

  describe('bulkAssignRoles', () => {
    it('should assign roles to multiple users', async () => {
      const bulkData: BulkAssignRolesDto = {
        assignments: [
          { userId: 'user1', roleId: 1 },
          { userId: 'user2', roleId: 2 }
        ]
      };

      // Mock successful assignments para ambos usuários
      mockPrismaService.usuarios.findFirst
        .mockResolvedValueOnce(usuarioMock) // user1 encontrado
        .mockResolvedValueOnce({...usuarioMock, id: 'user2'}); // user2 encontrado

      mockPrismaService.roles.findUnique
        .mockResolvedValueOnce({
          id: BigInt(1),
          name: 'admin',
          guard_name: 'web',
          role_has_permissions: []
        })
        .mockResolvedValueOnce({
          id: BigInt(2),
          name: 'manager',
          guard_name: 'web', 
          role_has_permissions: []
        });

      mockPrismaService.model_has_roles.deleteMany.mockResolvedValue({});
      mockPrismaService.model_has_roles.create.mockResolvedValue({});

      const result = await service.bulkAssignRoles(bulkData);

      expect(result.success).toBe(2);
      expect(result.failures).toHaveLength(0);
    });

    it('should handle failures in bulk role assignment', async () => {
      const bulkData: BulkAssignRolesDto = {
        assignments: [
          { userId: 'invalid-user', roleId: 1 },
          { userId: 'user2', roleId: 999 }
        ]
      };

      // Mock failures
      mockPrismaService.usuarios.findFirst
        .mockResolvedValueOnce(null) // User not found
        .mockResolvedValueOnce(usuarioMock); // User found
      mockPrismaService.roles.findUnique
        .mockResolvedValueOnce(rolesMock[0]) // Won't be called for first
        .mockResolvedValueOnce(null); // Role not found

      const result = await service.bulkAssignRoles(bulkData);

      expect(result.success).toBe(0);
      expect(result.failures).toHaveLength(2);
    });
  });

  describe('bulkAssignPermissions', () => {
    it('should sync permissions for multiple users', async () => {
      const bulkData: BulkAssignPermissionsDto = {
        assignments: [
          { userId: 'user1', permissionIds: [1, 2] },
          { userId: 'user2', permissionIds: [2, 3] }
        ]
      };

      mockPrismaService.usuarios.findFirst.mockResolvedValue(usuarioMock);
      mockPrismaService.permissions.findMany.mockResolvedValue([
        permissionsMock[0], permissionsMock[1]
      ]);
      mockPrismaService.model_has_permissions.deleteMany.mockResolvedValue({});
      mockPrismaService.model_has_permissions.createMany.mockResolvedValue({});

      const result = await service.bulkAssignPermissions(bulkData);

      expect(result.success).toBe(2);
      expect(result.failures).toHaveLength(0);
    });
  });

  // ============================================================================
  // TESTES DOS MÉTODOS AUXILIARES
  // ============================================================================

  describe('getAllAvailableRoles', () => {
    it('should return all available roles', async () => {
      const rolesList = [
        { id: 1, name: 'admin', guard_name: 'web' },
        { id: 2, name: 'user', guard_name: 'web' }
      ];
      mockRolesService.findAll.mockResolvedValue(rolesList);

      const result = await service.getAllAvailableRoles();

      expect(result).toEqual(rolesList);
      expect(mockRolesService.findAll).toHaveBeenCalled();
    });
  });

  describe('getAllAvailablePermissions', () => {
    it('should return all available permissions', async () => {
      const permissionsList = [
        { id: 1, name: 'Dashboard', guard_name: 'web' },
        { id: 2, name: 'Usuarios', guard_name: 'web' }
      ];
      mockPermissionsService.findAll.mockResolvedValue(permissionsList);

      const result = await service.getAllAvailablePermissions();

      expect(result).toEqual(permissionsList);
      expect(mockPermissionsService.findAll).toHaveBeenCalled();
    });
  });

  describe('getAvailablePermissionsGrouped', () => {
    it('should return permissions grouped by category', async () => {
      const groupedPermissions = {
        'Dashboard': [{ id: 1, name: 'Dashboard', guard_name: 'web' }],
        'Users': [{ id: 2, name: 'Usuarios', guard_name: 'web' }]
      };
      mockPermissionsService.findGrouped.mockResolvedValue(groupedPermissions);

      const result = await service.getAvailablePermissionsGrouped();

      expect(result).toEqual(groupedPermissions);
      expect(mockPermissionsService.findGrouped).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // TESTES DE CENÁRIOS DE ERRO
  // ============================================================================

  describe('Error Handling', () => {
    it('should handle database connection errors gracefully', async () => {
      mockPrismaService.usuarios.findMany.mockRejectedValue(new Error('Database connection failed'));

      await expect(service.findAll({})).rejects.toThrow(BadRequestException);
    });

    it('should handle invalid user ID format', async () => {
      mockPrismaService.usuarios.findFirst.mockRejectedValue(new Error('Invalid ID format'));

      await expect(service.findOne('invalid-id-format')).rejects.toThrow(BadRequestException);
    });

    it('should handle permission system errors', async () => {
      mockPrismaService.usuarios.findFirst.mockResolvedValue(usuarioMock);
      mockPrismaService.model_has_roles.findFirst.mockRejectedValue(new Error('Permission system error'));

      await expect(service.getUserPermissions('usr_2024_test_12345')).rejects.toThrow(BadRequestException);
    });
  });

  // ============================================================================
  // TESTES DE PERFORMANCE E EDGE CASES
  // ============================================================================

  describe('Edge Cases', () => {
    it('should handle user with no permissions or roles', async () => {
      mockPrismaService.usuarios.findFirst.mockResolvedValue(usuarioMock);
      mockPrismaService.model_has_roles.findFirst.mockResolvedValue(null);
      mockPrismaService.model_has_permissions.findMany.mockResolvedValue([]);

      const result = await service.getUserPermissions('usr_2024_test_12345');

      expect(result.role).toBeNull();
      expect(result.permissions).toHaveLength(0);
      expect(result.permissionNames).toHaveLength(0);
    });

    it('should handle large number of permissions', async () => {
      const manyPermissions = Array.from({ length: 100 }, (_, i) => ({
        id: BigInt(i + 1),
        name: `Permission${i + 1}`,
        guard_name: 'web'
      }));

      mockPrismaService.usuarios.findFirst.mockResolvedValue(usuarioMock);
      mockPrismaService.permissions.findMany.mockResolvedValue(manyPermissions);
      mockPrismaService.model_has_permissions.deleteMany.mockResolvedValue({});
      mockPrismaService.model_has_permissions.createMany.mockResolvedValue({});

      const permissionIds = manyPermissions.map(p => Number(p.id));
      const result = await service.syncUserPermissions('usr_2024_test_12345', permissionIds);

      expect(result.permissions).toHaveLength(100);
      expect(result.message).toBe('Permissões sincronizadas com sucesso');
    });

    it('should handle empty bulk operations', async () => {
      const emptyBulkRoles: BulkAssignRolesDto = { assignments: [] };
      const emptyBulkPermissions: BulkAssignPermissionsDto = { assignments: [] };

      const rolesResult = await service.bulkAssignRoles(emptyBulkRoles);
      const permissionsResult = await service.bulkAssignPermissions(emptyBulkPermissions);

      expect(rolesResult.success).toBe(0);
      expect(rolesResult.failures).toHaveLength(0);
      expect(permissionsResult.success).toBe(0);
      expect(permissionsResult.failures).toHaveLength(0);
    });
  });
});