import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '@aupus/api-shared';
import { MqttModule } from '../../shared/mqtt/mqtt.module';
import { BombaCombustivelController } from './bomba-combustivel.controller';
import { BombaCombustivelService } from './bomba-combustivel.service';

@Module({
  imports: [PrismaModule, forwardRef(() => MqttModule)],
  controllers: [BombaCombustivelController],
  providers: [BombaCombustivelService],
  exports: [BombaCombustivelService],
})
export class BombaCombustivelModule {}
