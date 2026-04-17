import { Test, TestingModule } from '@nestjs/testing';
import { EquipamentosDiagramaService } from './equipamentos-diagrama.service';
import { PrismaService } from '@aupus/api-shared';
import {
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';

describe('EquipamentosDiagramaService', () => {
  let service: EquipamentosDiagramaService;
  let prismaService: PrismaService;

  const mockPrismaService = {
    diagramas_unitarios: {
      findFirst: jest.fn(),
    },
    equipamentos: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    equipamentos_conexoes: {
      count: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn((callback) => callback(mockPrismaService)),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EquipamentosDiagramaService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<EquipamentosDiagramaService>(
      EquipamentosDiagramaService,
    );
    prismaService = module.get<PrismaService>(PrismaService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('addEquipamento', () => {
    const mockDiagrama = {
      id: 'diagrama-123',
      unidade_id: 'unidade-123',
      deleted_at: null,
    };

    const mockEquipamento = {
      id: 'equip-123',
      nome: 'Inversor 01',
      unidade_id: 'unidade-123',
      diagrama_id: null,
      propriedades: {},
      deleted_at: null,
    };

    const addDto = {
      equipamentoId: 'equip-123',
      posicao: { x: 100, y: 200 },
      rotacao: 0,
      dimensoes: { largura: 64, altura: 64 },
      propriedades: { customLabel: 'INV-01' },
    };

    it('deve adicionar equipamento ao diagrama com sucesso', async () => {
      mockPrismaService.diagramas_unitarios.findFirst.mockResolvedValue(
        mockDiagrama,
      );
      mockPrismaService.equipamentos.findFirst.mockResolvedValue(
        mockEquipamento,
      );
      mockPrismaService.equipamentos.update.mockResolvedValue({
        ...mockEquipamento,
        diagrama_id: 'diagrama-123',
        posicao_x: 100,
        posicao_y: 200,
        rotacao: 0,
        largura_customizada: 64,
        altura_customizada: 64,
        propriedades: { customLabel: 'INV-01' },
      });

      const result = await service.addEquipamento('diagrama-123', addDto);

      expect(prismaService.equipamentos.update).toHaveBeenCalledWith({
        where: { id: 'equip-123' },
        data: expect.objectContaining({
          diagrama_id: 'diagrama-123',
          posicao_x: 100,
          posicao_y: 200,
          rotacao: 0,
        }),
      });
      expect(result).toHaveProperty('diagramaId', 'diagrama-123');
      expect(result.posicao).toEqual({ x: 100, y: 200 });
    });

    it('deve lançar NotFoundException se diagrama não existir', async () => {
      mockPrismaService.diagramas_unitarios.findFirst.mockResolvedValue(null);

      await expect(
        service.addEquipamento('diagrama-inexistente', addDto),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.addEquipamento('diagrama-inexistente', addDto),
      ).rejects.toThrow('Diagrama não encontrado');
    });

    it('deve lançar NotFoundException se equipamento não existir', async () => {
      mockPrismaService.diagramas_unitarios.findFirst.mockResolvedValue(
        mockDiagrama,
      );
      mockPrismaService.equipamentos.findFirst.mockResolvedValue(null);

      await expect(
        service.addEquipamento('diagrama-123', addDto),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.addEquipamento('diagrama-123', addDto),
      ).rejects.toThrow('Equipamento não encontrado');
    });

    it('deve lançar BadRequestException se equipamento não pertence à mesma unidade', async () => {
      mockPrismaService.diagramas_unitarios.findFirst.mockResolvedValue(
        mockDiagrama,
      );
      mockPrismaService.equipamentos.findFirst.mockResolvedValue({
        ...mockEquipamento,
        unidade_id: 'unidade-diferente',
      });

      await expect(
        service.addEquipamento('diagrama-123', addDto),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.addEquipamento('diagrama-123', addDto),
      ).rejects.toThrow('Equipamento não pertence à mesma unidade do diagrama');
    });

    it('deve lançar ConflictException se equipamento já está em outro diagrama', async () => {
      mockPrismaService.diagramas_unitarios.findFirst.mockResolvedValue(
        mockDiagrama,
      );
      mockPrismaService.equipamentos.findFirst.mockResolvedValue({
        ...mockEquipamento,
        diagrama_id: 'diagrama-outro',
      });

      await expect(
        service.addEquipamento('diagrama-123', addDto),
      ).rejects.toThrow(ConflictException);
      await expect(
        service.addEquipamento('diagrama-123', addDto),
      ).rejects.toThrow('Equipamento já está posicionado em outro diagrama');
    });

    it('deve validar coordenadas negativas', async () => {
      mockPrismaService.diagramas_unitarios.findFirst.mockResolvedValue(
        mockDiagrama,
      );
      mockPrismaService.equipamentos.findFirst.mockResolvedValue(
        mockEquipamento,
      );

      const dtoComCoordenadaNegativa = {
        ...addDto,
        posicao: { x: -10, y: 200 },
      };

      await expect(
        service.addEquipamento('diagrama-123', dtoComCoordenadaNegativa),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.addEquipamento('diagrama-123', dtoComCoordenadaNegativa),
      ).rejects.toThrow('Coordenadas devem ser maiores ou iguais a 0');
    });

    it('deve validar rotação fora do range 0-360', async () => {
      mockPrismaService.diagramas_unitarios.findFirst.mockResolvedValue(
        mockDiagrama,
      );
      mockPrismaService.equipamentos.findFirst.mockResolvedValue(
        mockEquipamento,
      );

      const dtoComRotacaoInvalida = {
        ...addDto,
        rotacao: 400,
      };

      await expect(
        service.addEquipamento('diagrama-123', dtoComRotacaoInvalida),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.addEquipamento('diagrama-123', dtoComRotacaoInvalida),
      ).rejects.toThrow('Rotação deve estar entre 0 e 360 graus');
    });

    it('deve mesclar propriedades existentes com novas', async () => {
      const equipamentoComPropriedades = {
        ...mockEquipamento,
        propriedades: { cor: 'azul', tamanho: 'grande' },
      };

      mockPrismaService.diagramas_unitarios.findFirst.mockResolvedValue(
        mockDiagrama,
      );
      mockPrismaService.equipamentos.findFirst.mockResolvedValue(
        equipamentoComPropriedades,
      );
      mockPrismaService.equipamentos.update.mockResolvedValue({
        ...equipamentoComPropriedades,
        diagrama_id: 'diagrama-123',
      });

      await service.addEquipamento('diagrama-123', {
        ...addDto,
        propriedades: { customLabel: 'INV-01' },
      });

      expect(prismaService.equipamentos.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            propriedades: expect.objectContaining({
              cor: 'azul', // Mantém existente
              tamanho: 'grande', // Mantém existente
              customLabel: 'INV-01', // Nova propriedade
            }),
          }),
        }),
      );
    });
  });

  describe('updateEquipamento', () => {
    const mockEquipamento = {
      id: 'equip-123',
      nome: 'Inversor 01',
      diagrama_id: 'diagrama-123',
      posicao_x: 100,
      posicao_y: 200,
      rotacao: 0,
      propriedades: {},
      deleted_at: null,
    };

    const updateDto = {
      posicao: { x: 300, y: 400 },
      rotacao: 45,
      dimensoes: { largura: 80, altura: 80 },
    };

    it('deve atualizar equipamento com sucesso', async () => {
      mockPrismaService.equipamentos.findFirst.mockResolvedValue(
        mockEquipamento,
      );
      mockPrismaService.equipamentos.update.mockResolvedValue({
        ...mockEquipamento,
        posicao_x: 300,
        posicao_y: 400,
        rotacao: 45,
      });

      const result = await service.updateEquipamento(
        'diagrama-123',
        'equip-123',
        updateDto,
      );

      expect(prismaService.equipamentos.update).toHaveBeenCalledWith({
        where: { id: 'equip-123' },
        data: expect.objectContaining({
          posicao_x: 300,
          posicao_y: 400,
          rotacao: 45,
        }),
      });
      expect(result.posicao).toEqual({ x: 300, y: 400 });
      expect(result.rotacao).toBe(45);
    });

    it('deve lançar NotFoundException se equipamento não está no diagrama', async () => {
      mockPrismaService.equipamentos.findFirst.mockResolvedValue(null);

      await expect(
        service.updateEquipamento('diagrama-123', 'equip-inexistente', updateDto),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.updateEquipamento('diagrama-123', 'equip-inexistente', updateDto),
      ).rejects.toThrow('Equipamento não encontrado ou não está no diagrama');
    });
  });

  describe('removeEquipamento', () => {
    const mockEquipamento = {
      id: 'equip-123',
      nome: 'Inversor 01',
      diagrama_id: 'diagrama-123',
      deleted_at: null,
    };

    it('deve remover equipamento do diagrama e suas conexões', async () => {
      mockPrismaService.equipamentos.findFirst.mockResolvedValue(
        mockEquipamento,
      );
      mockPrismaService.$transaction.mockImplementation(async (callback) => {
        const result = await callback(mockPrismaService);
        return result;
      });
      mockPrismaService.equipamentos_conexoes.count
        .mockResolvedValueOnce(2) // conexões origem
        .mockResolvedValueOnce(3); // conexões destino

      const result = await service.removeEquipamento('diagrama-123', 'equip-123');

      expect(prismaService.equipamentos_conexoes.updateMany).toHaveBeenCalled();
      expect(prismaService.equipamentos.update).toHaveBeenCalledWith({
        where: { id: 'equip-123' },
        data: expect.objectContaining({
          diagrama_id: null,
          posicao_x: null,
          posicao_y: null,
          rotacao: null,
        }),
      });
      expect(result).toHaveProperty('equipamentoId', 'equip-123');
      expect(result).toHaveProperty('diagramaId', null);
      expect(result).toHaveProperty('conexoesRemovidas', 5); // 2 + 3
    });

    it('deve lançar NotFoundException se equipamento não está no diagrama', async () => {
      mockPrismaService.equipamentos.findFirst.mockResolvedValue(null);

      await expect(
        service.removeEquipamento('diagrama-123', 'equip-inexistente'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('addEquipamentosBulk', () => {
    const bulkDto = {
      equipamentos: [
        {
          equipamentoId: 'equip-1',
          posicao: { x: 100, y: 200 },
          rotacao: 0,
        },
        {
          equipamentoId: 'equip-2',
          posicao: { x: 300, y: 200 },
          rotacao: 0,
        },
        {
          equipamentoId: 'equip-inexistente',
          posicao: { x: 500, y: 200 },
          rotacao: 0,
        },
      ],
    };

    it('deve processar múltiplos equipamentos e retornar estatísticas', async () => {
      // Mock para primeiro equipamento (sucesso)
      jest
        .spyOn(service, 'addEquipamento')
        .mockResolvedValueOnce({
          id: 'equip-1',
          diagramaId: 'diagrama-123',
          nome: 'Equip 1',
          tag: 'E1',
          posicao: { x: 100, y: 200 },
          rotacao: 0,
          dimensoes: { largura: 64, altura: 64 },
          propriedades: {},
          updatedAt: new Date(),
        } as any)
        // Segundo equipamento (sucesso)
        .mockResolvedValueOnce({
          id: 'equip-2',
          diagramaId: 'diagrama-123',
          nome: 'Equip 2',
          tag: 'E2',
          posicao: { x: 300, y: 200 },
          rotacao: 0,
          dimensoes: { largura: 64, altura: 64 },
          propriedades: {},
          updatedAt: new Date(),
        } as any)
        // Terceiro equipamento (erro)
        .mockRejectedValueOnce(new NotFoundException('Equipamento não encontrado'));

      mockPrismaService.equipamentos.findUnique
        .mockResolvedValueOnce({ id: 'equip-1', diagrama_id: null })
        .mockResolvedValueOnce({ id: 'equip-2', diagrama_id: null })
        .mockResolvedValueOnce(null);

      const result = await service.addEquipamentosBulk('diagrama-123', bulkDto);

      expect(result.adicionados).toBe(2);
      expect(result.erros).toBe(1);
      expect(result.equipamentos).toHaveLength(3);
      expect(result.equipamentos[0]).toHaveProperty('status', 'added');
      expect(result.equipamentos[1]).toHaveProperty('status', 'added');
      expect(result.equipamentos[2]).toHaveProperty('status', 'error');
      expect(result.equipamentos[2]).toHaveProperty('error');
    });
  });
});
