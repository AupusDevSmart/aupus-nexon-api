import { Module, Global } from '@nestjs/common';
import { MqttService } from './mqtt.service';
import { MqttDiagnosticsService } from './mqtt-diagnostics.service';
import { MqttDiagnosticsController } from './mqtt-diagnostics.controller';
import { MqttRedisBufferService } from './mqtt-redis-buffer.service';
import { PrismaModule } from '@aupus/api-shared';
import { EquipamentosDadosModule } from '../../modules/equipamentos-dados/equipamentos-dados.module';
import { RegrasLogsMqttModule } from '../../modules/regras-logs-mqtt/regras-logs-mqtt.module';

@Global()
@Module({
  imports: [
    PrismaModule,
    EquipamentosDadosModule, // ✅ Import para usar MqttIngestionService
    RegrasLogsMqttModule, // ✅ Import para verificação de regras de logs
  ],
  controllers: [MqttDiagnosticsController],
  providers: [
    MqttService,
    MqttDiagnosticsService,
    MqttRedisBufferService, // ✅ Serviço de buffer Redis
  ],
  exports: [
    MqttService,
    MqttDiagnosticsService,
    MqttRedisBufferService, // ✅ Exportar para uso em outros módulos
  ],
})
export class MqttModule {}
