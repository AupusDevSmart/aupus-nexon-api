import { Module } from '@nestjs/common';
import { EquipamentosService } from './equipamentos.service';
import { EquipamentosDataService } from './services/equipamentos-data.service';
import { AnexosEquipamentosService } from './anexos-equipamentos.service';
import { EquipamentosController } from './equipamentos.controller';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [EquipamentosController],
  providers: [EquipamentosService, EquipamentosDataService, AnexosEquipamentosService],
  exports: [EquipamentosService, EquipamentosDataService, AnexosEquipamentosService],
})
export class EquipamentosModule {}
