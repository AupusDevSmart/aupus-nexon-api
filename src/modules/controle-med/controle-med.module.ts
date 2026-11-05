import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { EquipamentosCmdModule } from '../equipamentos-cmd/equipamentos-cmd.module';
import { ControleMedController } from './controle-med.controller';
import { ControleMedService } from './controle-med.service';

@Module({
  imports: [PrismaModule, EquipamentosCmdModule],
  controllers: [ControleMedController],
  providers: [ControleMedService],
})
export class ControleMedModule {}
