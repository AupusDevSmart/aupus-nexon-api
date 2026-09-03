import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { RegrasLogsMqttController } from './regras-logs-mqtt.controller';
import { RegrasLogsMqttService } from './regras-logs-mqtt.service';
import { RegrasLogsMqttEngine } from './regras-logs-mqtt.engine';
import { RegrasOfflineService } from './regras-offline.service';
import { SoeTripAlarmeService } from './soe-trip-alarme.service';

@Module({
  imports: [PrismaModule],
  controllers: [RegrasLogsMqttController],
  providers: [RegrasLogsMqttService, RegrasLogsMqttEngine, RegrasOfflineService, SoeTripAlarmeService],
  exports: [RegrasLogsMqttService, RegrasLogsMqttEngine],
})
export class RegrasLogsMqttModule {}
