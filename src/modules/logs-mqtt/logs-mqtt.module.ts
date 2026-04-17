import { Module } from '@nestjs/common';
import { PrismaModule } from '@aupus/api-shared';
import { LogsMqttController } from './logs-mqtt.controller';
import { LogsMqttService } from './logs-mqtt.service';

@Module({
  imports: [PrismaModule],
  controllers: [LogsMqttController],
  providers: [LogsMqttService],
  exports: [LogsMqttService],
})
export class LogsMqttModule {}
