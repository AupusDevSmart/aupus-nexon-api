import { Module } from '@nestjs/common';
import { PrismaModule } from '@aupus/api-shared';
import { RegrasLogsMqttController } from './regras-logs-mqtt.controller';
import { RegrasLogsMqttService } from './regras-logs-mqtt.service';
import { RegrasLogsMqttEngine } from './regras-logs-mqtt.engine';

@Module({
  imports: [PrismaModule],
  controllers: [RegrasLogsMqttController],
  providers: [RegrasLogsMqttService, RegrasLogsMqttEngine],
  exports: [RegrasLogsMqttService, RegrasLogsMqttEngine],
})
export class RegrasLogsMqttModule {}
