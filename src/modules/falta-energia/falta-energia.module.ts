import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { ChamadosModule } from '../chamados/chamados.module';
import { MqttModule } from '../../shared/mqtt/mqtt.module';
import { FaltaEnergiaController } from './falta-energia.controller';
import { FaltaEnergiaService } from './falta-energia.service';

@Module({
  imports: [PrismaModule, ChamadosModule, MqttModule],
  controllers: [FaltaEnergiaController],
  providers: [FaltaEnergiaService],
  exports: [FaltaEnergiaService],
})
export class FaltaEnergiaModule {}
