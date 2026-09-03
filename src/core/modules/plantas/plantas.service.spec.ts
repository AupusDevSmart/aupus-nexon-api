// src/modules/plantas/plantas.service.spec.ts - VERSÃO ATUALIZADA COM NOVOS TESTES
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { PlantasService } from './plantas.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionScopeService } from '../auth/permission-scope.service';
import { CreatePlantaDto } from './dto/create-planta.dto';
import { UpdatePlantaDto } from './dto/update-planta.dto';
import { FindAllPlantasDto } from './dto/find-all-plantas.dto';
import { Prisma } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';

// Mock do PrismaService
const mockPrismaService = () => ({
  usuarios: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
  plantas: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
  },
});

type MockPrismaService = ReturnType<typeof mockPrismaService>;

describe('PlantasService', () => {
  let service: PlantasService;
  let prismaService: MockPrismaService;

  // Mock data
  const mockUsuario = {
    id: 'usr_test_123456789012345678',
    nome: 'Empresa Test Ltda',
    cpf_cnpj: '12.345.678/0001-90'
  };

  const mockPlantaDto: CreatePlantaDto = {
    nome: 'Planta Test',
    cnpj: '98.765.432/0001-10',
    proprietarioId: 'usr_test_123456789012345678',
    horarioFuncionamento: '08:00 às 18:00',
    localizacao: 'Zona Industrial',
    endereco: {
      logradouro: 'Av. Test, 1000',
      bairro: 'Centro',
      cidade: 'São Paulo',
      uf: 'SP',
      cep: '01234-567'
    }
  };

  const mockPlantaCriada = {
    id: 'plt_test_123456789012345678',
    nome: 'Planta Test',
    cnpj: '98.765.432/0001-10',
    localizacao: 'Zona Industrial',
    horario_funcionamento: '08:00 às 18:00',
    logradouro: 'Av. Test, 1000',
    bairro: 'Centro',
    cidade: 'São Paulo',
    uf: 'SP',
    cep: '01234-567',
    proprietario_id: 'usr_test_123456789012345678',
    created_at: new Date('2024-01-15T10:30:00.000Z'),
    updated_at: new Date('2024-01-15T10:30:00.000Z'),
    deleted_at: null,
    proprietario: mockUsuario
  };

  const mockPlantas = [
    mockPlantaCriada,
    {
      ...mockPlantaCriada,
      id: 'plt_test_223456789012345678',
      nome: 'Planta Test 2',
      cnpj: '11.222.333/0001-44',
    }
  ];

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlantasService,
        {
          provide: PrismaService,
          useFactory: mockPrismaService,
        },
        {
          // PlantasService ganhou esta dependencia com o scope por planta.
          // Default: usuario sem escopo — ve tudo, e assertPlantaInScope nao barra.
          // Teste que precise exercitar escopo sobrescreve o retorno destes mocks.
          provide: PermissionScopeService,
          useFactory: () => ({
            getScope: jest.fn().mockResolvedValue(null),
            isScoped: jest.fn().mockResolvedValue(false),
            assertPlantaInScope: jest.fn().mockResolvedValue(undefined),
          }),
        },
      ],
    }).compile();

    service = module.get<PlantasService>(PlantasService);
    prismaService = module.get<PrismaService>(PrismaService) as unknown as MockPrismaService;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ✅ TESTES EXISTENTES - CREATE (mantidos)
  describe('create', () => {
    it('should create a planta successfully', async () => {
      // Arrange
      prismaService.usuarios.findUnique.mockResolvedValue(mockUsuario);
      prismaService.plantas.findUnique.mockResolvedValue(null);
      prismaService.plantas.create.mockResolvedValue(mockPlantaCriada);

      // Act
      const result = await service.create(mockPlantaDto);

      // Assert
      expect(result).toBeDefined();
      expect(result.id).toBe('plt_test_123456789012345678');
      expect(result.nome).toBe('Planta Test');
      expect(result.cnpj).toBe('98.765.432/0001-10');
      expect(result.proprietario?.nome).toBe('Empresa Test Ltda');
      expect(result.endereco.cidade).toBe('São Paulo');
    });

    it('should throw NotFoundException when proprietario does not exist', async () => {
      // Arrange
      prismaService.usuarios.findUnique.mockResolvedValue(null);

      // Act & Assert
      await expect(service.create(mockPlantaDto)).rejects.toThrow(
        new NotFoundException(`Proprietário com ID ${mockPlantaDto.proprietarioId} não encontrado ou inativo`)
      );
    });

    it('should throw ConflictException when CNPJ already exists', async () => {
      // Arrange
      prismaService.usuarios.findUnique.mockResolvedValue(mockUsuario);
      prismaService.plantas.findUnique.mockResolvedValue(mockPlantaCriada);

      // Act & Assert
      await expect(service.create(mockPlantaDto)).rejects.toThrow(
        new ConflictException(`Já existe uma planta cadastrada com o CNPJ ${mockPlantaDto.cnpj}`)
      );
    });
  });

  // ✅ NOVOS TESTES - FIND ALL
  describe('findAll', () => {
    const mockQueryDto: FindAllPlantasDto = {
      page: 1,
      limit: 10,
      search: '',
      proprietarioId: 'all',
      orderBy: 'nome',
      orderDirection: 'asc'
    };

    it('should return paginated plantas successfully', async () => {
      // Arrange
      prismaService.plantas.findMany.mockResolvedValue(mockPlantas);
      prismaService.plantas.count.mockResolvedValue(2);

      // Act
      const result = await service.findAll(mockQueryDto);

      // Assert
      expect(result).toBeDefined();
      expect(result.data).toHaveLength(2);
      expect(result.pagination.total).toBe(2);
      expect(result.pagination.page).toBe(1);
      expect(result.pagination.limit).toBe(10);
      expect(result.pagination.totalPages).toBe(1);

      expect(prismaService.plantas.findMany).toHaveBeenCalledWith({
        where: {
          deleted_at: null,
          AND: []
        },
        include: {
          proprietario: {
            select: {
              id: true,
              nome: true,
              cpf_cnpj: true
            }
          }
        },
        orderBy: { nome: 'asc' },
        skip: 0,
        take: 10
      });
    });

    it('should filter by search term correctly', async () => {
      // Arrange
      const queryWithSearch = { ...mockQueryDto, search: 'Industrial' };
      prismaService.plantas.findMany.mockResolvedValue([mockPlantaCriada]);
      prismaService.plantas.count.mockResolvedValue(1);

      // Act
      const result = await service.findAll(queryWithSearch);

      // Assert
      expect(result.data).toHaveLength(1);
      expect(prismaService.plantas.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              { nome: { contains: 'Industrial', mode: 'insensitive' } },
              { cnpj: { contains: 'Industrial', mode: 'insensitive' } },
              { localizacao: { contains: 'Industrial', mode: 'insensitive' } },
              { cidade: { contains: 'Industrial', mode: 'insensitive' } },
              { logradouro: { contains: 'Industrial', mode: 'insensitive' } }
            ]
          })
        })
      );
    });

    it('should filter by proprietarioId correctly', async () => {
      // Arrange
      const queryWithProprietario = { ...mockQueryDto, proprietarioId: 'usr_test_123456789012345678' };
      prismaService.plantas.findMany.mockResolvedValue([mockPlantaCriada]);
      prismaService.plantas.count.mockResolvedValue(1);

      // Act
      const result = await service.findAll(queryWithProprietario);

      // Assert
      expect(result.data).toHaveLength(1);
      expect(prismaService.plantas.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: [
              { proprietario_id: 'usr_test_123456789012345678' }
            ]
          })
        })
      );
    });

    it('should handle pagination correctly', async () => {
      // Arrange
      const queryPage2 = { ...mockQueryDto, page: 2, limit: 5 };
      prismaService.plantas.findMany.mockResolvedValue([]);
      prismaService.plantas.count.mockResolvedValue(7);

      // Act
      const result = await service.findAll(queryPage2);

      // Assert
      expect(result.pagination.page).toBe(2);
      expect(result.pagination.limit).toBe(5);
      expect(result.pagination.total).toBe(7);
      expect(result.pagination.totalPages).toBe(2);
      expect(prismaService.plantas.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 5,
          take: 5
        })
      );
    });

    it('should handle different orderBy options', async () => {
      // Arrange
      const queryOrderByCnpj = { ...mockQueryDto, orderBy: 'cnpj', orderDirection: 'desc' as const };
      prismaService.plantas.findMany.mockResolvedValue(mockPlantas);
      prismaService.plantas.count.mockResolvedValue(2);

      // Act
      await service.findAll(queryOrderByCnpj);

      // Assert
      expect(prismaService.plantas.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { cnpj: 'desc' }
        })
      );
    });
  });

  // ✅ NOVOS TESTES - FIND ONE
  describe('findOne', () => {
    it('should return a planta by id successfully', async () => {
      // Arrange
      const plantaId = 'plt_test_123456789012345678';
      prismaService.plantas.findFirst.mockResolvedValue(mockPlantaCriada);

      // Act
      const result = await service.findOne(plantaId);

      // Assert
      expect(result).toBeDefined();
      expect(result.id).toBe(plantaId);
      expect(result.nome).toBe('Planta Test');
      expect(prismaService.plantas.findFirst).toHaveBeenCalledWith({
        where: {
          id: plantaId,
          deleted_at: null
        },
        include: {
          proprietario: {
            select: {
              id: true,
              nome: true,
              cpf_cnpj: true
            }
          }
        }
      });
    });

    it('should throw NotFoundException when planta is not found', async () => {
      // Arrange
      const plantaId = 'plt_nonexistent_123456789012345678';
      prismaService.plantas.findFirst.mockResolvedValue(null);

      // Act & Assert
      await expect(service.findOne(plantaId)).rejects.toThrow(
        new NotFoundException(`Planta com ID ${plantaId} não encontrada`)
      );
    });
  });

  // ✅ NOVOS TESTES - UPDATE
  describe('update', () => {
    const plantaId = 'plt_test_123456789012345678';
    const mockUpdateDto: UpdatePlantaDto = {
      nome: 'Planta Test Atualizada',
      localizacao: 'Nova Localização',
      endereco: {
        cidade: 'Rio de Janeiro',
        uf: 'RJ'
      }
    };

    it('should update a planta successfully', async () => {
      // Arrange
      prismaService.plantas.findFirst.mockResolvedValue(mockPlantaCriada);
      
      const updatedPlanta = {
        ...mockPlantaCriada,
        nome: 'Planta Test Atualizada',
        localizacao: 'Nova Localização',
        cidade: 'Rio de Janeiro',
        uf: 'RJ'
      };
      
      prismaService.plantas.update.mockResolvedValue(updatedPlanta);

      // Act
      const result = await service.update(plantaId, mockUpdateDto);

      // Assert
      expect(result).toBeDefined();
      expect(result.nome).toBe('Planta Test Atualizada');
      expect(result.localizacao).toBe('Nova Localização');
      expect(result.endereco.cidade).toBe('Rio de Janeiro');

      expect(prismaService.plantas.update).toHaveBeenCalledWith({
        where: { id: plantaId },
        data: {
          nome: 'Planta Test Atualizada',
          localizacao: 'Nova Localização',
          cidade: 'Rio de Janeiro',
          uf: 'RJ'
        },
        include: {
          proprietario: {
            select: {
              id: true,
              nome: true,
              cpf_cnpj: true
            }
          }
        }
      });
    });

    it('should throw NotFoundException when planta to update does not exist', async () => {
      // Arrange
      prismaService.plantas.findFirst.mockResolvedValue(null);

      // Act & Assert
      await expect(service.update(plantaId, mockUpdateDto)).rejects.toThrow(
        new NotFoundException(`Planta com ID ${plantaId} não encontrada`)
      );

      expect(prismaService.plantas.update).not.toHaveBeenCalled();
    });

    it('should throw ConflictException when updating CNPJ to existing one', async () => {
      // Arrange
      const updateWithCnpj = { ...mockUpdateDto, cnpj: '11.222.333/0001-44' };
      
      prismaService.plantas.findFirst
        .mockResolvedValueOnce(mockPlantaCriada) // Para verificar se a planta existe
        .mockResolvedValueOnce({ id: 'another_planta_id', cnpj: '11.222.333/0001-44' }); // Para verificar CNPJ duplicado

      // Act & Assert
      await expect(service.update(plantaId, updateWithCnpj)).rejects.toThrow(
        new ConflictException('Já existe outra planta cadastrada com o CNPJ 11.222.333/0001-44')
      );

      expect(prismaService.plantas.update).not.toHaveBeenCalled();
    });

    it('should validate new proprietario when updating', async () => {
      // Arrange
      const updateWithNewProprietario = { ...mockUpdateDto, proprietarioId: 'usr_new_123456789012345678' };
      
      prismaService.plantas.findFirst.mockResolvedValue(mockPlantaCriada);
      prismaService.usuarios.findUnique.mockResolvedValue(null); // Proprietário não existe

      // Act & Assert
      await expect(service.update(plantaId, updateWithNewProprietario)).rejects.toThrow(
        new NotFoundException('Proprietário com ID usr_new_123456789012345678 não encontrado ou inativo')
      );

      expect(prismaService.plantas.update).not.toHaveBeenCalled();
    });
  });

  // ✅ TESTES EXISTENTES - FIND PROPRIETARIOS (mantidos)
  describe('findProprietarios', () => {
    it('should return list of proprietarios successfully', async () => {
      // Arrange
      const mockProprietarios = [
        {
          id: 'usr_prop1_123456789012345678',
          nome: 'Proprietário 1',
          cpf_cnpj: '12.345.678/0001-90'
        },
        {
          id: 'usr_prop2_123456789012345678',
          nome: 'Proprietário 2',
          cpf_cnpj: '987.654.321-00'
        }
      ];

      prismaService.usuarios.findMany.mockResolvedValue(mockProprietarios);

      // Act
      const result = await service.findProprietarios();

      // Assert
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: 'usr_prop1_123456789012345678',
        nome: 'Proprietário 1',
        cpf_cnpj: '12.345.678/0001-90',
        tipo: 'pessoa_juridica'
      });
      expect(result[1]).toEqual({
        id: 'usr_prop2_123456789012345678',
        nome: 'Proprietário 2',
        cpf_cnpj: '987.654.321-00',
        tipo: 'pessoa_fisica'
      });
    });

    it('should return empty array when no proprietarios found', async () => {
      // Arrange
      prismaService.usuarios.findMany.mockResolvedValue([]);

      // Act
      const result = await service.findProprietarios();

      // Assert
      expect(result).toEqual([]);
    });
  });

  // ✅ TESTES EXISTENTES - MÉTODOS PRIVADOS (mantidos)
  describe('getTipoProprietario (private method)', () => {
    it('should identify pessoa_fisica correctly (CPF)', () => {
      const result = (service as any).getTipoProprietario('123.456.789-00');
      expect(result).toBe('pessoa_fisica');
    });

    it('should identify pessoa_juridica correctly (CNPJ)', () => {
      const result = (service as any).getTipoProprietario('12.345.678/0001-90');
      expect(result).toBe('pessoa_juridica');
    });

    it('should default to pessoa_juridica when cpf_cnpj is null', () => {
      const result = (service as any).getTipoProprietario(null);
      expect(result).toBe('pessoa_juridica');
    });
  });

  describe('formatPlantaResponse (private method)', () => {
    it('should format database response correctly', () => {
      // Act
      const result = (service as any).formatPlantaResponse(mockPlantaCriada);

      // Assert
      expect(result).toEqual({
        id: 'plt_test_123456789012345678',
        nome: 'Planta Test',
        cnpj: '98.765.432/0001-10',
        localizacao: 'Zona Industrial',
        horarioFuncionamento: '08:00 às 18:00',
        endereco: {
          logradouro: 'Av. Test, 1000',
          bairro: 'Centro',
          cidade: 'São Paulo',
          uf: 'SP',
          cep: '01234-567',
        },
        proprietarioId: 'usr_test_123456789012345678',
        proprietario: {
          id: 'usr_test_123456789012345678',
          nome: 'Empresa Test Ltda',
          cpf_cnpj: '12.345.678/0001-90',
          tipo: 'pessoa_juridica',
        },
        criadoEm: new Date('2024-01-15T10:30:00.000Z'),
        atualizadoEm: new Date('2024-01-15T10:30:00.000Z'),
      });
    });

    it('should handle response without proprietario', () => {
      // Arrange
      const plantaSemProprietario = { ...mockPlantaCriada };
      delete plantaSemProprietario.proprietario;

      // Act
      const result = (service as any).formatPlantaResponse(plantaSemProprietario);

      // Assert
      expect(result.proprietario).toBeUndefined();
      expect(result.proprietarioId).toBe('usr_test_123456789012345678');
    });
  });
});