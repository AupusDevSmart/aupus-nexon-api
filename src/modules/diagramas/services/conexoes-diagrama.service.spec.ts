import { Test, TestingModule } from '@nestjs/testing';
import { ConexoesDiagramaService } from './conexoes-diagrama.service';
import { PrismaService } from '@aupus/api-shared';
import { NotFoundException, BadRequestException } from '@nestjs/common';

// Enums do DTO
enum PortaEnum {
  TOP = 'top',
  BOTTOM = 'bottom',
  LEFT = 'left',
  RIGHT = 'right',
}

describe('ConexoesDiagramaService', () => {
  let service: ConexoesDiagramaService;
  let prismaService: PrismaService;

  const mockPrismaService = {
    diagramas_unitarios: {
      findFirst: jest.fn(),
    },
    equipamentos: {
      findFirst: jest.fn(),
    },
    equipamentos_conexoes: {
      create: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConexoesDiagramaService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<ConexoesDiagramaService>(ConexoesDiagramaService);
    prismaService = module.get<PrismaService>(PrismaService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    const mockDiagrama = {
      id: 'diagrama-123',
      nome: 'Diagrama Teste',
      deleted_at: null,
    };

    const mockEquipOrigem = {
      id: 'equip-origem',
      nome: 'Inversor 01',
      diagrama_id: 'diagrama-123',
      deleted_at: null,
    };

    const mockEquipDestino = {
      id: 'equip-destino',
      nome: 'Transformador 01',
      diagrama_id: 'diagrama-123',
      deleted_at: null,
    };

    const createDto = {
      origem: {
        equipamentoId: 'equip-origem',
        porta: PortaEnum.RIGHT,
      },
      destino: {
        equipamentoId: 'equip-destino',
        porta: PortaEnum.LEFT,
      },
    };

    it('deve criar conexão entre equipamentos com sucesso', async () => {
      mockPrismaService.diagramas_unitarios.findFirst.mockResolvedValue(
        mockDiagrama,
      );
      mockPrismaService.equipamentos.findFirst
        .mockResolvedValueOnce(mockEquipOrigem)
        .mockResolvedValueOnce(mockEquipDestino);
      mockPrismaService.equipamentos_conexoes.create.mockResolvedValue({
        id: 'conexao-123',
        diagrama_id: 'diagrama-123',
        equipamento_origem_id: 'equip-origem',
        porta_origem: 'right',
        equipamento_destino_id: 'equip-destino',
        porta_destino: 'left',
        created_at: new Date(),
        updated_at: new Date(),
        equipamento_origem: mockEquipOrigem,
        equipamento_destino: mockEquipDestino,
      });

      const result = await service.create('diagrama-123', createDto);

      expect(prismaService.equipamentos_conexoes.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          diagrama_id: 'diagrama-123',
          equipamento_origem_id: 'equip-origem',
          porta_origem: 'right',
          equipamento_destino_id: 'equip-destino',
          porta_destino: 'left',
        }),
        include: expect.any(Object),
      });
      expect(result).toHaveProperty('id', 'conexao-123');
      expect(result.origem).toHaveProperty('equipamentoId', 'equip-origem');
      expect(result.destino).toHaveProperty('equipamentoId', 'equip-destino');
    });

    it('deve lançar NotFoundException se diagrama não existir', async () => {
      mockPrismaService.diagramas_unitarios.findFirst.mockResolvedValue(null);

      await expect(
        service.create('diagrama-inexistente', createDto),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.create('diagrama-inexistente', createDto),
      ).rejects.toThrow('Diagrama não encontrado');
    });

    it('deve lançar BadRequestException se equipamento origem não está no diagrama', async () => {
      mockPrismaService.diagramas_unitarios.findFirst.mockResolvedValue(
        mockDiagrama,
      );
      mockPrismaService.equipamentos.findFirst.mockResolvedValueOnce(null);

      await expect(service.create('diagrama-123', createDto)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.create('diagrama-123', createDto)).rejects.toThrow(
        'Equipamento de origem não encontrado ou não está no diagrama',
      );
    });

    it('deve lançar BadRequestException se equipamento destino não está no diagrama', async () => {
      mockPrismaService.diagramas_unitarios.findFirst.mockResolvedValue(
        mockDiagrama,
      );
      mockPrismaService.equipamentos.findFirst
        .mockResolvedValueOnce(mockEquipOrigem)
        .mockResolvedValueOnce(null);

      await expect(service.create('diagrama-123', createDto)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.create('diagrama-123', createDto)).rejects.toThrow(
        'Equipamento de destino não encontrado ou não está no diagrama',
      );
    });

    it('deve validar portas válidas', async () => {
      mockPrismaService.diagramas_unitarios.findFirst.mockResolvedValue(
        mockDiagrama,
      );
      mockPrismaService.equipamentos.findFirst
        .mockResolvedValueOnce(mockEquipOrigem)
        .mockResolvedValueOnce(mockEquipDestino);

      const dtoComPortaInvalida = {
        ...createDto,
        origem: { equipamentoId: 'equip-origem', porta: 'invalid' },
      };

      await expect(
        service.create('diagrama-123', dtoComPortaInvalida as any),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.create('diagrama-123', dtoComPortaInvalida as any),
      ).rejects.toThrow('Porta de origem inválida');
    });

  });

  describe('update', () => {
    it('deve lançar BadRequestException informando endpoint descontinuado', async () => {
      await expect(
        service.update('diagrama-123', 'conexao-123', {}),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.update('diagrama-123', 'conexao-123', {}),
      ).rejects.toThrow('Endpoint descontinuado');
    });
  });

  describe('remove', () => {
    const mockConexao = {
      id: 'conexao-123',
      diagrama_id: 'diagrama-123',
      deleted_at: null,
    };

    it('deve remover conexão com sucesso (soft delete)', async () => {
      mockPrismaService.equipamentos_conexoes.findFirst.mockResolvedValue(
        mockConexao,
      );
      mockPrismaService.equipamentos_conexoes.update.mockResolvedValue({
        ...mockConexao,
        deleted_at: new Date(),
      });

      const result = await service.remove('diagrama-123', 'conexao-123');

      expect(prismaService.equipamentos_conexoes.update).toHaveBeenCalledWith({
        where: { id: 'conexao-123' },
        data: { deleted_at: expect.any(Date) },
      });
      expect(result).toHaveProperty('id', 'conexao-123');
      expect(result).toHaveProperty('message', 'Conexão removida com sucesso');
    });

    it('deve lançar NotFoundException se conexão não existir', async () => {
      mockPrismaService.equipamentos_conexoes.findFirst.mockResolvedValue(null);

      await expect(
        service.remove('diagrama-123', 'conexao-inexistente'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('createBulk', () => {
    const bulkDto = {
      conexoes: [
        {
          origem: { equipamentoId: 'equip-1', porta: PortaEnum.RIGHT },
          destino: { equipamentoId: 'equip-2', porta: PortaEnum.LEFT },
        },
        {
          origem: { equipamentoId: 'equip-2', porta: PortaEnum.RIGHT },
          destino: { equipamentoId: 'equip-3', porta: PortaEnum.LEFT },
        },
        {
          origem: { equipamentoId: 'equip-inexistente', porta: PortaEnum.RIGHT },
          destino: { equipamentoId: 'equip-4', porta: PortaEnum.LEFT },
        },
      ],
    };

    it('deve processar múltiplas conexões e retornar estatísticas', async () => {
      jest
        .spyOn(service, 'create')
        .mockResolvedValueOnce({
          id: 'conexao-1',
          diagramaId: 'diagrama-123',
          origem: { equipamentoId: 'equip-1', porta: PortaEnum.RIGHT },
          destino: { equipamentoId: 'equip-2', porta: PortaEnum.LEFT },
        } as any)
        .mockResolvedValueOnce({
          id: 'conexao-2',
          diagramaId: 'diagrama-123',
          origem: { equipamentoId: 'equip-2', porta: PortaEnum.RIGHT },
          destino: { equipamentoId: 'equip-3', porta: PortaEnum.LEFT },
        } as any)
        .mockRejectedValueOnce(
          new BadRequestException('Equipamento de origem não encontrado'),
        );

      const result = await service.createBulk('diagrama-123', bulkDto);

      expect(result.criadas).toBe(2);
      expect(result.erros).toBe(1);
      expect(result.conexoes).toHaveLength(3);
      expect(result.conexoes[0]).toHaveProperty('status', 'created');
      expect(result.conexoes[1]).toHaveProperty('status', 'created');
      expect(result.conexoes[2]).toHaveProperty('status', 'error');
      expect(result.conexoes[2]).toHaveProperty('error');
    });
  });
});
