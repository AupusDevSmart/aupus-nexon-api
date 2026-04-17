import { Test, TestingModule } from '@nestjs/testing';
import { DiagramasService } from './diagramas.service';
import { PrismaService } from '@aupus/api-shared';
import { NotFoundException } from '@nestjs/common';

describe('DiagramasService', () => {
  let service: DiagramasService;
  let prismaService: PrismaService;

  const mockPrismaService = {
    diagramas_unitarios: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    unidades: {
      findUnique: jest.fn(),
    },
    equipamentos: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    tipos_equipamentos: {
      findMany: jest.fn(),
    },
    equipamentos_conexoes: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn((callback) => callback(mockPrismaService)),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DiagramasService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<DiagramasService>(DiagramasService);
    prismaService = module.get<PrismaService>(PrismaService);

    // Limpar mocks antes de cada teste
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    const createDiagramaDto = {
      unidadeId: 'unidade-123',
      nome: 'Diagrama Teste',
      descricao: 'Descrição teste',
      configuracoes: {
        zoom: 1.0,
        grid: { enabled: true, size: 20, snapToGrid: true },
      },
    };

    it('deve criar um diagrama com sucesso', async () => {
      const mockUnidade = { id: 'unidade-123', nome: 'Unidade Teste' };
      const mockDiagrama = {
        id: 'diagrama-123',
        unidade_id: 'unidade-123',
        nome: 'Diagrama Teste',
        descricao: 'Descrição teste',
        versao: '1.0',
        ativo: true,
        configuracoes: {
          zoom: 1.0,
          grid: { enabled: true, size: 20, snapToGrid: true },
          canvas: { width: 2000, height: 1500, backgroundColor: '#f5f5f5' },
          viewport: { x: 0, y: 0, scale: 1.0 },
        },
        thumbnail_url: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockPrismaService.unidades.findUnique.mockResolvedValue(mockUnidade);
      mockPrismaService.diagramas_unitarios.create.mockResolvedValue(mockDiagrama);

      const result = await service.create(createDiagramaDto);

      expect(prismaService.unidades.findUnique).toHaveBeenCalledWith({
        where: { id: 'unidade-123', deleted_at: null },
      });
      expect(prismaService.diagramas_unitarios.create).toHaveBeenCalled();
      expect(result).toHaveProperty('id', 'diagrama-123');
      expect(result).toHaveProperty('nome', 'Diagrama Teste');
      expect(result).toHaveProperty('versao', '1.0');
    });

    it('deve lançar NotFoundException se unidade não existir', async () => {
      mockPrismaService.unidades.findUnique.mockResolvedValue(null);

      await expect(service.create(createDiagramaDto)).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.create(createDiagramaDto)).rejects.toThrow(
        'Unidade não encontrada',
      );
    });

    it('deve aplicar configurações padrão se não fornecidas', async () => {
      const dtoSemConfig = {
        unidadeId: 'unidade-123',
        nome: 'Diagrama Teste',
      };

      const mockUnidade = { id: 'unidade-123', nome: 'Unidade Teste' };
      mockPrismaService.unidades.findUnique.mockResolvedValue(mockUnidade);
      mockPrismaService.diagramas_unitarios.create.mockImplementation(
        (args) => ({
          id: 'diagrama-123',
          ...args.data,
          created_at: new Date(),
          updated_at: new Date(),
        }),
      );

      await service.create(dtoSemConfig);

      expect(prismaService.diagramas_unitarios.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            configuracoes: expect.objectContaining({
              zoom: 1.0,
              grid: expect.any(Object),
              canvas: expect.any(Object),
              viewport: expect.any(Object),
            }),
          }),
        }),
      );
    });
  });

  describe('findOne', () => {
    const mockDiagrama = {
      id: 'diagrama-123',
      unidade_id: 'unidade-123',
      nome: 'Diagrama Teste',
      descricao: 'Descrição',
      versao: '1.0',
      ativo: true,
      configuracoes: {},
      thumbnail_url: null,
      created_at: new Date(),
      updated_at: new Date(),
      deleted_at: null,
    };

    const mockUnidade = {
      id: 'unidade-123',
      nome: 'Unidade Teste',
      tipo: 'UFV',
      potencia: 1000,
    };

    it('deve retornar um diagrama com equipamentos e conexões', async () => {
      mockPrismaService.diagramas_unitarios.findFirst.mockResolvedValue(
        mockDiagrama,
      );
      mockPrismaService.unidades.findUnique.mockResolvedValue(mockUnidade);
      mockPrismaService.equipamentos.findMany.mockResolvedValue([]);
      mockPrismaService.tipos_equipamentos.findMany.mockResolvedValue([]);
      mockPrismaService.equipamentos_conexoes.findMany.mockResolvedValue([]);

      const result = await service.findOne('diagrama-123');

      expect(prismaService.diagramas_unitarios.findFirst).toHaveBeenCalledWith({
        where: { id: 'diagrama-123', deleted_at: null },
      });
      expect(result).toHaveProperty('id', 'diagrama-123');
      expect(result).toHaveProperty('unidade');
      expect(result).toHaveProperty('equipamentos');
      expect(result).toHaveProperty('conexoes');
      expect(result).toHaveProperty('estatisticas');
    });

    it('deve lançar NotFoundException se diagrama não existir', async () => {
      mockPrismaService.diagramas_unitarios.findFirst.mockResolvedValue(null);

      await expect(service.findOne('diagrama-inexistente')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.findOne('diagrama-inexistente')).rejects.toThrow(
        'Diagrama não encontrado',
      );
    });

    it('deve incluir equipamentos posicionados no diagrama', async () => {
      const mockEquipamentos = [
        {
          id: 'equip-1',
          nome: 'Inversor 1',
          tag: 'INV-01',
          tipo_equipamento_id: 'tipo-1',
          classificacao: 'UC',
          posicao_x: 100,
          posicao_y: 200,
          rotacao: 0,
          largura_customizada: null,
          altura_customizada: null,
          status: 'NORMAL',
          propriedades: {},
        },
      ];

      const mockTipos = [
        {
          id: 'tipo-1',
          codigo: 'INV',
          nome: 'Inversor',
          categoria: 'CONVERSAO',
          largura_padrao: 64,
          altura_padrao: 64,
          icone_svg: '<svg>...</svg>',
        },
      ];

      mockPrismaService.diagramas_unitarios.findFirst.mockResolvedValue(
        mockDiagrama,
      );
      mockPrismaService.unidades.findUnique.mockResolvedValue(mockUnidade);
      mockPrismaService.equipamentos.findMany.mockResolvedValue(
        mockEquipamentos,
      );
      mockPrismaService.tipos_equipamentos.findMany.mockResolvedValue(mockTipos);
      mockPrismaService.equipamentos_conexoes.findMany.mockResolvedValue([]);

      const result = await service.findOne('diagrama-123');

      expect(result.equipamentos).toHaveLength(1);
      expect(result.equipamentos[0]).toHaveProperty('id', 'equip-1');
      expect(result.equipamentos[0]).toHaveProperty('tipo');
      expect(result.equipamentos[0].tipo).toHaveProperty('codigo', 'INV');
    });
  });

  describe('update', () => {
    const mockDiagramaExistente = {
      id: 'diagrama-123',
      unidade_id: 'unidade-123',
      nome: 'Diagrama Original',
      versao: '1.0',
      configuracoes: { zoom: 1.0 },
      deleted_at: null,
    };

    it('deve atualizar um diagrama com sucesso', async () => {
      const updateDto = {
        nome: 'Diagrama Atualizado',
        descricao: 'Nova descrição',
        ativo: true,
      };

      mockPrismaService.diagramas_unitarios.findFirst.mockResolvedValue(
        mockDiagramaExistente,
      );
      mockPrismaService.diagramas_unitarios.update.mockResolvedValue({
        ...mockDiagramaExistente,
        ...updateDto,
        versao: '1.1',
        updated_at: new Date(),
      });

      const result = await service.update('diagrama-123', updateDto);

      expect(prismaService.diagramas_unitarios.update).toHaveBeenCalled();
      expect(result).toHaveProperty('nome', 'Diagrama Atualizado');
      expect(result).toHaveProperty('versao', '1.1');
    });

    it('deve lançar NotFoundException se diagrama não existir', async () => {
      mockPrismaService.diagramas_unitarios.findFirst.mockResolvedValue(null);

      await expect(
        service.update('diagrama-inexistente', { nome: 'Teste' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('deve incrementar versão ao atualizar', async () => {
      mockPrismaService.diagramas_unitarios.findFirst.mockResolvedValue({
        ...mockDiagramaExistente,
        versao: '2.5',
      });
      mockPrismaService.diagramas_unitarios.update.mockResolvedValue({
        ...mockDiagramaExistente,
        versao: '2.6',
      });

      const result = await service.update('diagrama-123', { nome: 'Teste' });

      expect(result.versao).toBe('2.6');
    });

    it('deve mesclar configurações existentes com novas', async () => {
      const novasConfiguracoes = { viewport: { x: 100, y: 50 } };

      mockPrismaService.diagramas_unitarios.findFirst.mockResolvedValue(
        mockDiagramaExistente,
      );
      mockPrismaService.diagramas_unitarios.update.mockImplementation((args) =>
        Promise.resolve({
          ...mockDiagramaExistente,
          configuracoes: args.data.configuracoes,
        }),
      );

      await service.update('diagrama-123', {
        configuracoes: novasConfiguracoes,
      });

      expect(prismaService.diagramas_unitarios.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            configuracoes: expect.objectContaining({
              zoom: 1.0, // Mantém configuração existente
              viewport: { x: 100, y: 50 }, // Nova configuração
            }),
          }),
        }),
      );
    });
  });

  describe('remove', () => {
    it('deve remover diagrama e limpar relacionamentos', async () => {
      const mockDiagrama = {
        id: 'diagrama-123',
        nome: 'Diagrama Teste',
        deleted_at: null,
      };

      mockPrismaService.diagramas_unitarios.findFirst.mockResolvedValue(
        mockDiagrama,
      );
      mockPrismaService.$transaction.mockImplementation(async (callback) =>
        callback(mockPrismaService),
      );

      const result = await service.remove('diagrama-123');

      expect(prismaService.equipamentos_conexoes.updateMany).toHaveBeenCalled();
      expect(prismaService.equipamentos.updateMany).toHaveBeenCalled();
      expect(prismaService.diagramas_unitarios.update).toHaveBeenCalledWith({
        where: { id: 'diagrama-123' },
        data: { deleted_at: expect.any(Date) },
      });
      expect(result).toHaveProperty('message', 'Diagrama removido com sucesso');
    });

    it('deve lançar NotFoundException se diagrama não existir', async () => {
      mockPrismaService.diagramas_unitarios.findFirst.mockResolvedValue(null);

      await expect(service.remove('diagrama-inexistente')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('deve fazer soft delete (não deletar fisicamente)', async () => {
      const mockDiagrama = {
        id: 'diagrama-123',
        nome: 'Diagrama Teste',
        deleted_at: null,
      };

      mockPrismaService.diagramas_unitarios.findFirst.mockResolvedValue(
        mockDiagrama,
      );
      mockPrismaService.$transaction.mockImplementation(async (callback) =>
        callback(mockPrismaService),
      );

      await service.remove('diagrama-123');

      // Verifica que usou update com deleted_at, não delete
      expect(prismaService.diagramas_unitarios.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            deleted_at: expect.any(Date),
          }),
        }),
      );
    });
  });
});
