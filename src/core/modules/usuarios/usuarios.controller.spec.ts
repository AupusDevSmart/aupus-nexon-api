import { Test, TestingModule } from '@nestjs/testing';
import { UsuariosController } from './usuarios.controller';
import { UsuariosService } from './usuarios.service';
import { 
  CreateUsuarioDto, 
  UpdateUsuarioDto, 
  UsuarioQueryDto,
  ChangePasswordDto,
  ResetPasswordDto,
  UsuarioStatus,
  Permissao
} from './dto';

describe('UsuariosController', () => {
  let controller: UsuariosController;
  let service: UsuariosService;

  // Mock do service
  const mockUsuariosService = {
    findAll: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    changePassword: jest.fn(),
    resetPassword: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsuariosController],
      providers: [
        {
          provide: UsuariosService,
          useValue: mockUsuariosService,
        },
      ],
    }).compile();

    controller = module.get<UsuariosController>(UsuariosController);
    service = module.get<UsuariosService>(UsuariosService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('findAll', () => {
    it('should return array of users with pagination', async () => {
      const query: UsuarioQueryDto = {
        page: 1,
        limit: 10,
        search: 'João',
        status: UsuarioStatus.ATIVO,
        includeInactive: false
      };
      
      const expectedResult = {
        data: [
          { 
            id: '1', 
            nome: 'João Silva', 
            email: 'joao@email.com',
            status: UsuarioStatus.ATIVO,
            roleNames: ['admin']
          },
          { 
            id: '2', 
            nome: 'João Pedro', 
            email: 'joaopedro@email.com',
            status: UsuarioStatus.ATIVO,
            roleNames: ['propietario']
          }
        ],
        total: 2,
        page: 1,
        limit: 10,
        totalPages: 1
      };

      mockUsuariosService.findAll.mockResolvedValue(expectedResult);

      const result = await controller.findAll(query);

      expect(service.findAll).toHaveBeenCalledWith(query);
      expect(result).toEqual(expectedResult);
    });

    it('should call service with empty query when no filters provided', async () => {
      const query: UsuarioQueryDto = {};
      const expectedResult = {
        data: [],
        total: 0,
        page: 1,
        limit: 10,
        totalPages: 0
      };

      mockUsuariosService.findAll.mockResolvedValue(expectedResult);

      const result = await controller.findAll(query);

      expect(service.findAll).toHaveBeenCalledWith(query);
      expect(result).toEqual(expectedResult);
    });
  });

  describe('findOne', () => {
    it('should return a user when found', async () => {
      const userId = '1';
      const expectedUser = {
        id: '1',
        nome: 'João Silva',
        email: 'joao@email.com',
        status: UsuarioStatus.ATIVO,
        roleNames: ['admin'],
        permissions: ['Dashboard', 'Usuarios'] as Permissao[],
        createdAt: new Date(),
        updatedAt: new Date()
      };

      mockUsuariosService.findOne.mockResolvedValue(expectedUser);

      const result = await controller.findOne(userId);

      expect(service.findOne).toHaveBeenCalledWith(userId);
      expect(result).toEqual(expectedUser);
    });

    it('should handle when user is not found', async () => {
      const userId = 'non-existent';
      mockUsuariosService.findOne.mockRejectedValue(new Error('Usuário não encontrado'));

      await expect(controller.findOne(userId)).rejects.toThrow('Usuário não encontrado');
      expect(service.findOne).toHaveBeenCalledWith(userId);
    });
  });

  describe('create', () => {
    it('should create a new user successfully', async () => {
      const createUserDto: CreateUsuarioDto = {
        nome: 'Novo Usuário',
        email: 'novo@email.com',
        telefone: '(11) 99999-9999',
        status: UsuarioStatus.ATIVO,
        roleNames: ['admin'],
        permissions: ['Dashboard', 'Usuarios'] as Permissao[]
      };

      const expectedUser = {
        id: '1',
        nome: 'Novo Usuário',
        email: 'novo@email.com',
        telefone: '(11) 99999-9999',
        status: UsuarioStatus.ATIVO,
        roleNames: ['admin'],
        permissions: ['Dashboard', 'Usuarios'] as Permissao[],
        createdAt: new Date(),
        updatedAt: new Date()
      };

      mockUsuariosService.create.mockResolvedValue(expectedUser);

      const result = await controller.create(createUserDto);

      expect(service.create).toHaveBeenCalledWith(createUserDto);
      expect(result).toEqual(expectedUser);
    });

    it('should handle email already exists error', async () => {
      const createUserDto: CreateUsuarioDto = {
        nome: 'Usuário Existente',
        email: 'existente@email.com',
        telefone: '(11) 99999-9999',
        status: UsuarioStatus.ATIVO,
        roleNames: ['admin']
      };

      mockUsuariosService.create.mockRejectedValue(new Error('Email já está em uso'));

      await expect(controller.create(createUserDto)).rejects.toThrow('Email já está em uso');
      expect(service.create).toHaveBeenCalledWith(createUserDto);
    });
  });

  describe('update', () => {
    it('should update user successfully', async () => {
      const userId = '1';
      const updateUserDto: UpdateUsuarioDto = {
        nome: 'Nome Atualizado',
        telefone: '(11) 88888-8888',
        status: UsuarioStatus.INATIVO
      };

      const expectedUser = {
        id: '1',
        nome: 'Nome Atualizado',
        email: 'user@email.com',
        telefone: '(11) 88888-8888',
        status: UsuarioStatus.INATIVO,
        updatedAt: new Date()
      };

      mockUsuariosService.update.mockResolvedValue(expectedUser);

      const result = await controller.update(userId, updateUserDto);

      expect(service.update).toHaveBeenCalledWith(userId, updateUserDto);
      expect(result).toEqual(expectedUser);
    });

    it('should handle user not found on update', async () => {
      const userId = 'non-existent';
      const updateUserDto: UpdateUsuarioDto = {
        nome: 'Nome Atualizado'
      };

      mockUsuariosService.update.mockRejectedValue(new Error('Usuário não encontrado'));

      await expect(controller.update(userId, updateUserDto)).rejects.toThrow('Usuário não encontrado');
      expect(service.update).toHaveBeenCalledWith(userId, updateUserDto);
    });
  });

  describe('remove', () => {
    it('should remove user successfully (soft delete)', async () => {
      const userId = '1';
      const expectedResult = {
        message: 'Usuário excluído com sucesso',
        id: userId
      };

      mockUsuariosService.remove.mockResolvedValue(expectedResult);

      const result = await controller.remove(userId);

      expect(service.remove).toHaveBeenCalledWith(userId);
      expect(result).toEqual(expectedResult);
    });

    it('should handle user not found on remove', async () => {
      const userId = 'non-existent';
      mockUsuariosService.remove.mockRejectedValue(new Error('Usuário não encontrado'));

      await expect(controller.remove(userId)).rejects.toThrow('Usuário não encontrado');
      expect(service.remove).toHaveBeenCalledWith(userId);
    });
  });

  describe('changePassword', () => {
    it('should change password successfully', async () => {
      const userId = '1';
      const changePasswordDto: ChangePasswordDto = {
        senhaAtual: 'senhaAntiga123',
        novaSenha: 'novaSenha123'
      };

      const expectedResult = {
        message: 'Senha alterada com sucesso'
      };

      mockUsuariosService.changePassword.mockResolvedValue(expectedResult);

      const result = await controller.changePassword(userId, changePasswordDto);

      expect(service.changePassword).toHaveBeenCalledWith(userId, changePasswordDto);
      expect(result).toEqual(expectedResult);
    });

    it('should handle invalid current password', async () => {
      const userId = '1';
      const changePasswordDto: ChangePasswordDto = {
        senhaAtual: 'senhaErrada',
        novaSenha: 'novaSenha123'
      };

      mockUsuariosService.changePassword.mockRejectedValue(new Error('Senha atual incorreta'));

      await expect(controller.changePassword(userId, changePasswordDto)).rejects.toThrow('Senha atual incorreta');
      expect(service.changePassword).toHaveBeenCalledWith(userId, changePasswordDto);
    });
  });

  describe('resetPassword', () => {
    it('should reset password successfully', async () => {
      const userId = '1';
      const resetPasswordDto: ResetPasswordDto = {
        novaSenha: 'senhaResetada123',
        confirmarSenha: 'senhaResetada123'
      };

      const expectedResult = {
        message: 'Senha resetada com sucesso'
      };

      mockUsuariosService.resetPassword.mockResolvedValue(expectedResult);

      const result = await controller.resetPassword(userId, resetPasswordDto);

      expect(service.resetPassword).toHaveBeenCalledWith(userId, resetPasswordDto);
      expect(result).toEqual(expectedResult);
    });

    it('should handle password mismatch on reset', async () => {
      const userId = '1';
      const resetPasswordDto: ResetPasswordDto = {
        novaSenha: 'senha123',
        confirmarSenha: 'senhadiferente'
      };

      mockUsuariosService.resetPassword.mockRejectedValue(new Error('Senhas não coincidem'));

      await expect(controller.resetPassword(userId, resetPasswordDto)).rejects.toThrow('Senhas não coincidem');
      expect(service.resetPassword).toHaveBeenCalledWith(userId, resetPasswordDto);
    });
  });
});