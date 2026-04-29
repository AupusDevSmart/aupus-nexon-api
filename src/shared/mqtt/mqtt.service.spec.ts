import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@aupus/api-shared';
import { MqttService } from './mqtt.service';
import { MqttIngestionService } from '../../modules/equipamentos-dados/services/mqtt-ingestion.service';

describe('MqttService — dynamic subscribe', () => {
  let service: MqttService;
  let prismaMock: any;
  let mqttClientMock: { subscribe: jest.Mock; unsubscribe: jest.Mock; connected: boolean; end: jest.Mock };

  beforeEach(async () => {
    prismaMock = {
      equipamentos: {
        findMany: jest.fn(),
      },
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        MqttService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: MqttIngestionService, useValue: {} },
      ],
    }).compile();

    service = moduleRef.get<MqttService>(MqttService);

    // Stub do client mqtt — subscribeTopic usa client?.subscribe; injetamos um mock leve.
    mqttClientMock = {
      subscribe: jest.fn((_topic, cb) => cb && cb(null)),
      unsubscribe: jest.fn(),
      connected: true,
      end: jest.fn(),
    };
    (service as any).client = mqttClientMock;
  });

  function getSubs(): Map<string, string[]> {
    return (service as any).subscriptions as Map<string, string[]>;
  }

  describe('handleEquipamentoMqttChanged', () => {
    it('inscreve em topico novo quando habilitado=true', async () => {
      await service.handleEquipamentoMqttChanged({
        equipamentoId: 'eq-1',
        topicoAntigo: null,
        topicoNovo: 'TEST/X/Y',
        habilitado: true,
      });

      expect(getSubs().has('TEST/X/Y')).toBe(true);
      expect(getSubs().get('TEST/X/Y')).toContain('eq-1');
      expect(getSubs().has('TEST/X/Y/status')).toBe(true);
      expect(mqttClientMock.subscribe).toHaveBeenCalledWith('TEST/X/Y', expect.any(Function));
    });

    it('migra de topico antigo para topico novo', async () => {
      // Estado inicial: inscrito em A/B/C
      (service as any).subscribeTopic('A/B/C', 'eq-1', 'boot');
      expect(getSubs().has('A/B/C')).toBe(true);

      await service.handleEquipamentoMqttChanged({
        equipamentoId: 'eq-1',
        topicoAntigo: 'A/B/C',
        topicoNovo: 'D/E/F',
        habilitado: true,
      });

      expect(getSubs().has('A/B/C')).toBe(false);
      expect(getSubs().has('A/B/C/status')).toBe(false);
      expect(getSubs().has('D/E/F')).toBe(true);
      expect(getSubs().get('D/E/F')).toContain('eq-1');
    });

    it('desinscreve quando habilitado=false', async () => {
      (service as any).subscribeTopic('SOFT/DEL', 'eq-2', 'boot');
      expect(getSubs().has('SOFT/DEL')).toBe(true);

      await service.handleEquipamentoMqttChanged({
        equipamentoId: 'eq-2',
        topicoAntigo: 'SOFT/DEL',
        topicoNovo: 'SOFT/DEL',
        habilitado: false,
      });

      expect(getSubs().has('SOFT/DEL')).toBe(false);
      expect(getSubs().has('SOFT/DEL/status')).toBe(false);
    });

    it('e idempotente — chamar duas vezes nao duplica', async () => {
      const payload = {
        equipamentoId: 'eq-3',
        topicoAntigo: null,
        topicoNovo: 'IDEM/1',
        habilitado: true,
      };
      await service.handleEquipamentoMqttChanged(payload);
      await service.handleEquipamentoMqttChanged(payload);

      expect(getSubs().get('IDEM/1')).toEqual(['eq-3']);
    });

    it('ignora payload sem equipamentoId', async () => {
      await service.handleEquipamentoMqttChanged({} as any);
      expect(getSubs().size).toBe(0);
    });

    it('rejeita topico com wildcard', async () => {
      await service.handleEquipamentoMqttChanged({
        equipamentoId: 'eq-4',
        topicoNovo: 'X/+/Y',
        habilitado: true,
      });
      expect(getSubs().has('X/+/Y')).toBe(false);
    });

    it('aplica trim em equipamentoId e topicos', async () => {
      await service.handleEquipamentoMqttChanged({
        equipamentoId: '  eq-5  ',
        topicoNovo: '  TRIM/ME  ',
        habilitado: true,
      });
      expect(getSubs().get('TRIM/ME')).toEqual(['eq-5']);
    });
  });

  describe('reconcileSubscriptions', () => {
    it('subscribe nos faltantes e unsubscribe nos extras', async () => {
      // Estado atual: inscrito em OLD/TOPIC para eq-extra (que ja saiu do banco)
      (service as any).subscribeTopic('OLD/TOPIC', 'eq-extra', 'boot');

      // Estado desejado: eq-novo em NOVO/TOPIC
      prismaMock.equipamentos.findMany.mockResolvedValue([
        { id: 'eq-novo', topico_mqtt: 'NOVO/TOPIC' },
      ]);

      const result = await service.reconcileSubscriptions();

      expect(result.total).toBe(1);
      expect(result.added).toEqual([{ equipamentoId: 'eq-novo', topic: 'NOVO/TOPIC' }]);
      expect(result.removed).toEqual([{ equipamentoId: 'eq-extra', topic: 'OLD/TOPIC' }]);
      expect(getSubs().has('NOVO/TOPIC')).toBe(true);
      expect(getSubs().has('OLD/TOPIC')).toBe(false);
    });

    it('no-op quando estado ja bate', async () => {
      (service as any).subscribeTopic('STABLE/T', 'eq-stable', 'boot');
      prismaMock.equipamentos.findMany.mockResolvedValue([
        { id: 'eq-stable', topico_mqtt: 'STABLE/T' },
      ]);

      const result = await service.reconcileSubscriptions();

      expect(result.added).toEqual([]);
      expect(result.removed).toEqual([]);
      expect(result.total).toBe(1);
    });

    it('ignora topicos invalidos no banco', async () => {
      prismaMock.equipamentos.findMany.mockResolvedValue([
        { id: 'eq-bad-1', topico_mqtt: '' },
        { id: 'eq-bad-2', topico_mqtt: '   ' },
        { id: 'eq-bad-3', topico_mqtt: 'has/+/wildcard' },
        { id: 'eq-ok', topico_mqtt: 'OK/T' },
      ]);

      const result = await service.reconcileSubscriptions();

      expect(result.total).toBe(1);
      expect(result.added).toEqual([{ equipamentoId: 'eq-ok', topic: 'OK/T' }]);
    });

    it('aplica trim em ids vindos do banco', async () => {
      prismaMock.equipamentos.findMany.mockResolvedValue([
        { id: 'eq-padded   ', topico_mqtt: 'P/T' },
      ]);

      const result = await service.reconcileSubscriptions();

      expect(result.added).toEqual([{ equipamentoId: 'eq-padded', topic: 'P/T' }]);
      expect(getSubs().get('P/T')).toContain('eq-padded');
    });

    it('migra topico do mesmo equipamento', async () => {
      (service as any).subscribeTopic('VELHO', 'eq-mig', 'boot');
      prismaMock.equipamentos.findMany.mockResolvedValue([
        { id: 'eq-mig', topico_mqtt: 'NOVO' },
      ]);

      const result = await service.reconcileSubscriptions();

      expect(result.added).toEqual([{ equipamentoId: 'eq-mig', topic: 'NOVO' }]);
      expect(result.removed).toEqual([{ equipamentoId: 'eq-mig', topic: 'VELHO' }]);
    });
  });
});
