import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { MqttModule } from '../../shared/mqtt/mqtt.module';
import { CarregadorEletricoController } from './carregador-eletrico.controller';
import { CarregadorEletricoService } from './carregador-eletrico.service';

@Module({
  imports: [PrismaModule, forwardRef(() => MqttModule)],
  controllers: [CarregadorEletricoController],
  providers: [CarregadorEletricoService],
  exports: [CarregadorEletricoService],
})
export class CarregadorEletricoModule {}
