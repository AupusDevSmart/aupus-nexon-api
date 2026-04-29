import { Module } from '@nestjs/common';
import { PrismaModule } from '@aupus/api-shared';

import { MqttModule } from '../../shared/mqtt/mqtt.module';
import { OtaController } from './ota.controller';
import { OtaService } from './ota.service';

/**
 * Modulo OTA — disparo de atualizacao de firmware via MQTT.
 * Importa explicitamente MqttModule porque OtaService injeta MqttService;
 * isso evita depender de MqttModule estar marcado como global no app.
 */
@Module({
  imports: [PrismaModule, MqttModule],
  controllers: [OtaController],
  providers: [OtaService],
  exports: [OtaService],
})
export class OtaModule {}
