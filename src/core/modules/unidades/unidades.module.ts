import { Module } from '@nestjs/common';
import { UnidadesController } from './unidades.controller';
import { UnidadesService } from './unidades.service';
import { AnexosUnidadesService } from './anexos-unidades.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { EquipamentosModule } from '../equipamentos/equipamentos.module';

@Module({
  imports: [PrismaModule, EquipamentosModule],
  controllers: [UnidadesController],
  providers: [UnidadesService, AnexosUnidadesService],
  exports: [UnidadesService, AnexosUnidadesService],
})
export class UnidadesModule {}
