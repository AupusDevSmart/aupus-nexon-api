import { Test, TestingModule } from '@nestjs/testing';
import { MqttDiagnosticsController } from './mqtt-diagnostics.controller';
import { MqttDiagnosticsService } from './mqtt-diagnostics.service';
import { MqttService } from './mqtt.service';

describe('MqttDiagnosticsController — resync', () => {
  let controller: MqttDiagnosticsController;
  let mqttServiceMock: { reconcileSubscriptions: jest.Mock };

  beforeEach(async () => {
    mqttServiceMock = { reconcileSubscriptions: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [MqttDiagnosticsController],
      providers: [
        { provide: MqttDiagnosticsService, useValue: {} },
        { provide: MqttService, useValue: mqttServiceMock },
      ],
    }).compile();

    controller = moduleRef.get<MqttDiagnosticsController>(MqttDiagnosticsController);
  });

  it('retorna o diff de added/removed do reconcile', async () => {
    mqttServiceMock.reconcileSubscriptions.mockResolvedValue({
      added: [{ equipamentoId: 'eq-1', topic: 'X/Y' }],
      removed: [{ equipamentoId: 'eq-2', topic: 'OLD' }],
      total: 5,
    });

    const result = await controller.resync();

    expect(mqttServiceMock.reconcileSubscriptions).toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      data: {
        added: [{ equipamentoId: 'eq-1', topic: 'X/Y' }],
        removed: [{ equipamentoId: 'eq-2', topic: 'OLD' }],
        total: 5,
      },
    });
  });

  it('retorna success=false quando reconcile lanca', async () => {
    mqttServiceMock.reconcileSubscriptions.mockRejectedValue(new Error('boom'));

    const result = await controller.resync();

    expect(result.success).toBe(false);
    expect(result.error).toBe('boom');
  });
});
