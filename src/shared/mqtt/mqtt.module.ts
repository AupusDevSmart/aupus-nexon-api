import { Module, Global } from '@nestjs/common';
import { MqttService } from './mqtt.service';
import { MqttDiagnosticsService } from './mqtt-diagnostics.service';
import { MqttDiagnosticsController } from './mqtt-diagnostics.controller';
import { MqttRedisBufferService } from './mqtt-redis-buffer.service';
import { PrismaModule, MQTT_BROKER } from '@aupus/api-shared';
import { EquipamentosDadosModule } from '../../modules/equipamentos-dados/equipamentos-dados.module';
import { RegrasLogsMqttModule } from '../../modules/regras-logs-mqtt/regras-logs-mqtt.module';

@Global()
@Module({
  imports: [
    PrismaModule,
    EquipamentosDadosModule,
    RegrasLogsMqttModule,
  ],
  controllers: [MqttDiagnosticsController],
  providers: [
    MqttService,
    MqttDiagnosticsService,
    MqttRedisBufferService,
    // Fornece a impl concreta para o token IMqttBroker exposto pelo
    // EquipamentosService (api-shared). Sem isso, configurarMqtt() lanca
    // "Servico MQTT nao esta disponivel".
    { provide: MQTT_BROKER, useExisting: MqttService },
  ],
  exports: [
    MqttService,
    MqttDiagnosticsService,
    MqttRedisBufferService,
    MQTT_BROKER,
  ],
})
export class MqttModule {}
