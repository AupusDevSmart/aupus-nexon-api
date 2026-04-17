import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { AlertService } from './alert.service';
import { MetricsService } from './metrics.service';
import { PrismaModule } from '@aupus/api-shared';
import { MqttModule } from '../../shared/mqtt/mqtt.module';

@Module({
  imports: [PrismaModule, MqttModule],
  controllers: [HealthController],
  providers: [HealthService, AlertService, MetricsService],
  exports: [HealthService, AlertService, MetricsService],
})
export class HealthModule {}
