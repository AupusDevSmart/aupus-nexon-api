import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { LogsMqttController } from './logs-mqtt.controller';
import { LogsMqttService } from './logs-mqtt.service';

@Module({
  imports: [PrismaModule],
  controllers: [LogsMqttController],
  providers: [LogsMqttService],
  exports: [LogsMqttService],
})
export class LogsMqttModule {}
