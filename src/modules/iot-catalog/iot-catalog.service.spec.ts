import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '@aupus/api-shared';
import { IotCatalogService } from './iot-catalog.service';

/**
 * Mock minimo de PrismaService — so os metodos das tabelas iot_device_*
 * que o service consome. Cada teste re-stuba conforme necessario.
 */
function makePrismaMock() {
  return {
    iot_device_tipos: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    iot_device_modelos: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };
}

describe('IotCatalogService', () => {
  let service: IotCatalogService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    const moduleRef = await Test.createTestingModule({
      providers: [
        IotCatalogService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(IotCatalogService);
  });

  // ==========================================================================
  // TIPOS
  // ==========================================================================

  describe('createTipo', () => {
    it('1. cria com pontos default {ai,bi,bo} quando omitido', async () => {
      prisma.iot_device_tipos.findUnique.mockResolvedValue(null);
      prisma.iot_device_tipos.create.mockResolvedValue({ id: 'fake', codigo: 'novo', nome: 'Novo' });

      await service.createTipo({ codigo: 'novo', nome: 'Novo' });

      const createArg = prisma.iot_device_tipos.create.mock.calls[0][0];
      expect(createArg.data.pontos).toEqual({ ai: [], bi: [], bo: [] });
      expect(createArg.data.id).toMatch(/^[a-f0-9]{26}$/); // 26 hex chars
    });

    it('2. rejeita ConflictException se codigo ja existe', async () => {
      prisma.iot_device_tipos.findUnique.mockResolvedValue({ id: 'existing', codigo: 'dup' });

      await expect(
        service.createTipo({ codigo: 'dup', nome: 'Duplicado' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.iot_device_tipos.create).not.toHaveBeenCalled();
    });
  });

  describe('updateTipo', () => {
    it('3. rejeita NotFoundException se id nao existe', async () => {
      prisma.iot_device_tipos.findUnique.mockResolvedValue(null);
      await expect(
        service.updateTipo('inexistente', { nome: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('4. rejeita ConflictException se novo codigo colide com outro tipo', async () => {
      prisma.iot_device_tipos.findUnique.mockResolvedValue({ id: 'this-id', codigo: 'old' });
      prisma.iot_device_tipos.findFirst.mockResolvedValue({ id: 'other-id', codigo: 'taken' });

      await expect(
        service.updateTipo('this-id', { codigo: 'taken' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('removeTipo', () => {
    it('5. rejeita NotFoundException se id nao existe', async () => {
      prisma.iot_device_tipos.findUnique.mockResolvedValue(null);
      await expect(service.removeTipo('inexistente')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ==========================================================================
  // MODELOS
  // ==========================================================================

  const TIPO_INVERSOR = { id: 'tipo1', codigo: 'inversor_solar', nome: 'Inversor Solar' };

  describe('createModelo', () => {
    it('6. rejeita NotFoundException se tipo (codigo) nao existe', async () => {
      prisma.iot_device_tipos.findUnique.mockResolvedValue(null);
      await expect(
        service.createModelo({
          tipo: 'inexistente',
          fabricante: 'X',
          modelo: 'Y',
          protocolo: 'rtu',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('7. rejeita ConflictException em fabricante+modelo duplicado', async () => {
      prisma.iot_device_tipos.findUnique.mockResolvedValue(TIPO_INVERSOR);
      prisma.iot_device_modelos.findUnique.mockResolvedValue({ id: 'existing' });

      await expect(
        service.createModelo({
          tipo: 'inversor_solar',
          fabricante: 'Sungrow',
          modelo: 'SG250CX',
          protocolo: 'rtu',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('8. rejeita BadRequestException com mensagem se mapeamento mal-formado', async () => {
      prisma.iot_device_tipos.findUnique.mockResolvedValue(TIPO_INVERSOR);
      prisma.iot_device_modelos.findUnique.mockResolvedValue(null);

      await expect(
        service.createModelo({
          tipo: 'inversor_solar',
          fabricante: 'Acme',
          modelo: 'XYZ',
          protocolo: 'rtu',
          mapeamento: {
            ai_blocks: 'not-array' as any,
            ai_map: { x: { dataType: 'FLOAT128' } },
          },
        }),
      ).rejects.toThrow(/Mapeamento invalido/);
      expect(prisma.iot_device_modelos.create).not.toHaveBeenCalled();
    });

    it('9. deriva catalog_id de fabricante+modelo quando ausente', async () => {
      prisma.iot_device_tipos.findUnique.mockResolvedValue(TIPO_INVERSOR);
      prisma.iot_device_modelos.findUnique.mockResolvedValue(null);
      prisma.iot_device_modelos.create.mockResolvedValue({ id: 'new' });

      await service.createModelo({
        tipo: 'inversor_solar',
        fabricante: 'Sungrow',
        modelo: 'SG250CX',
        protocolo: 'rtu',
      });

      const data = prisma.iot_device_modelos.create.mock.calls[0][0].data;
      expect(data.mapeamento.catalog_id).toBe('sungrow-sg250cx');
    });

    it('10. preserva catalog_id quando informado explicitamente', async () => {
      prisma.iot_device_tipos.findUnique.mockResolvedValue(TIPO_INVERSOR);
      prisma.iot_device_modelos.findUnique.mockResolvedValue(null);
      prisma.iot_device_modelos.create.mockResolvedValue({ id: 'new' });

      await service.createModelo({
        tipo: 'inversor_solar',
        fabricante: 'GoodWe',
        modelo: 'GW-MT Series',
        protocolo: 'rtu',
        catalog_id: 'goodwe-mt', // legado, nao bate com slug derivado
      });

      const data = prisma.iot_device_modelos.create.mock.calls[0][0].data;
      expect(data.mapeamento.catalog_id).toBe('goodwe-mt');
    });
  });

  describe('updateModelo', () => {
    const EXISTING_MODELO = {
      id: 'm1',
      tipo_id: 'tipo1',
      fabricante: 'Sungrow',
      modelo: 'SG250CX',
      protocolo: 'rtu',
      connection_note: null,
      mapeamento: { catalog_id: 'sungrow-sg250cx', num_mppts: 12 },
    };

    it('11. valida mapeamento quando informado', async () => {
      prisma.iot_device_modelos.findUnique.mockResolvedValue(EXISTING_MODELO);

      await expect(
        service.updateModelo('m1', {
          mapeamento: { ai_blocks: 'no' as any },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('12. preserva catalog_id antigo quando dto nao envia', async () => {
      prisma.iot_device_modelos.findUnique.mockResolvedValue(EXISTING_MODELO);
      prisma.iot_device_modelos.update.mockResolvedValue({});

      await service.updateModelo('m1', { protocolo: 'tcp' });

      const data = prisma.iot_device_modelos.update.mock.calls[0][0].data;
      expect(data.mapeamento.catalog_id).toBe('sungrow-sg250cx');
    });

    it('13. permite trocar catalog_id se informado explicitamente', async () => {
      prisma.iot_device_modelos.findUnique.mockResolvedValue(EXISTING_MODELO);
      prisma.iot_device_modelos.update.mockResolvedValue({});

      await service.updateModelo('m1', { catalog_id: 'sungrow-cx-250' });

      const data = prisma.iot_device_modelos.update.mock.calls[0][0].data;
      expect(data.mapeamento.catalog_id).toBe('sungrow-cx-250');
    });
  });

  describe('duplicateModelo', () => {
    const ORIGINAL = {
      id: 'm1',
      tipo_id: 'tipo1',
      fabricante: 'Sungrow',
      modelo: 'SG250CX',
      protocolo: 'rtu',
      connection_note: 'RS485',
      mapeamento: { catalog_id: 'sungrow-sg250cx', num_mppts: 12 },
    };

    it('14. usa sufixo "(copia)" na primeira chamada', async () => {
      prisma.iot_device_modelos.findUnique
        .mockResolvedValueOnce(ORIGINAL) // findModelo lookup
        .mockResolvedValueOnce(null); // checa "(copia)" disponivel
      prisma.iot_device_tipos.findUnique.mockResolvedValue(TIPO_INVERSOR);
      prisma.iot_device_modelos.create.mockResolvedValue({});

      await service.duplicateModelo('m1');

      const data = prisma.iot_device_modelos.create.mock.calls[0][0].data;
      expect(data.modelo).toBe('SG250CX (copia)');
    });

    it('15. incrementa "(copia 2)" quando "(copia)" ja existe', async () => {
      prisma.iot_device_modelos.findUnique
        .mockResolvedValueOnce(ORIGINAL)
        .mockResolvedValueOnce({ id: 'taken' }) // (copia) ocupado
        .mockResolvedValueOnce(null); // (copia 2) livre
      prisma.iot_device_tipos.findUnique.mockResolvedValue(TIPO_INVERSOR);
      prisma.iot_device_modelos.create.mockResolvedValue({});

      await service.duplicateModelo('m1');

      const data = prisma.iot_device_modelos.create.mock.calls[0][0].data;
      expect(data.modelo).toBe('SG250CX (copia 2)');
    });

    it('16. rejeita NotFoundException se origem nao existe', async () => {
      prisma.iot_device_modelos.findUnique.mockResolvedValue(null);
      await expect(service.duplicateModelo('inexistente')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ==========================================================================
  // CATALOGO
  // ==========================================================================

  describe('getCatalog', () => {
    it('17. retorna version no formato "timestamp-N"', async () => {
      const now = new Date('2026-05-22T10:00:00Z');
      prisma.iot_device_tipos.findMany.mockResolvedValue([
        { id: 't1', codigo: 'x', nome: 'X', pontos: { ai: [], bi: [], bo: [] }, updated_at: now },
      ]);
      prisma.iot_device_modelos.findMany.mockResolvedValue([
        {
          id: 'm1',
          tipo_id: 't1',
          fabricante: 'A',
          modelo: 'B',
          protocolo: 'rtu',
          connection_note: null,
          mapeamento: { catalog_id: 'a-b' },
          updated_at: now,
        },
      ]);

      const catalog = await service.getCatalog();
      expect(catalog.version).toMatch(/^"\d+-2"$/); // 2 entries totais (1+1)
      expect(catalog.tipos).toHaveLength(1);
      expect(catalog.modelos).toHaveLength(1);
      expect(catalog.modelos[0].catalog_id).toBe('a-b');
    });
  });

  describe('getLegacyJs', () => {
    it('18. produz JS que avalia limpo e define DEVICE_POINTS/MODELS/helpers', async () => {
      const now = new Date('2026-05-22T10:00:00Z');
      prisma.iot_device_tipos.findMany.mockResolvedValue([
        {
          id: 't1',
          codigo: 'inversor_solar',
          nome: 'Inversor Solar',
          pontos: { ai: [{ id: 'pa', label: 'P', unit: 'W' }], bi: [], bo: [] },
          updated_at: now,
        },
      ]);
      prisma.iot_device_modelos.findMany.mockResolvedValue([
        {
          id: 'm1',
          tipo_id: 't1',
          fabricante: 'Sungrow',
          modelo: 'SG250CX',
          protocolo: 'rtu',
          connection_note: 'RS485',
          mapeamento: {
            catalog_id: 'sungrow-sg250cx',
            ai_blocks: [{ start: 5000, count: 50, func: 0x04 }],
            ai_map: { pa: { block: 0, offset: 31, scale: 1, dataType: 'U32' } },
          },
          updated_at: now,
        },
      ]);

      const { content, version } = await service.getLegacyJs();
      expect(version).toMatch(/^"\d+-2"$/);

      // Eval no sandbox sem poluir global — copia o "modo seed".
      const vm = await import('vm');
      const sandbox: Record<string, unknown> = {};
      vm.createContext(sandbox);
      vm.runInContext(content, sandbox);

      expect(typeof sandbox.DEVICE_POINTS).toBe('object');
      expect((sandbox.DEVICE_POINTS as any).inversor_solar.label).toBe('Inversor Solar');
      expect(typeof sandbox.DEVICE_MODELS).toBe('object');
      expect((sandbox.DEVICE_MODELS as any)['sungrow-sg250cx'].fabricante).toBe('Sungrow');
      expect(typeof sandbox.getCatalogDevice).toBe('function');
      expect(typeof sandbox.getCatalogByType).toBe('function');
      expect(typeof sandbox.getResolvedPoints).toBe('function');

      // Helpers retornam o esperado
      const dev = (sandbox.getCatalogDevice as Function)('sungrow-sg250cx');
      expect(dev.modelo).toBe('SG250CX');
      const lista = (sandbox.getCatalogByType as Function)('inversor_solar');
      expect(lista).toHaveLength(1);
      expect(lista[0].id).toBe('sungrow-sg250cx');
    });
  });
});
