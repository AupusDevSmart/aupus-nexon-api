import { Module } from '@nestjs/common';
import { CoaController } from './coa.controller';
import { CoaService } from './coa.service';
import { PrismaModule } from '@aupus/api-shared';
import { EquipamentosDadosModule } from '../equipamentos-dados/equipamentos-dados.module';

@Module({
  imports: [PrismaModule, EquipamentosDadosModule],
  controllers: [CoaController],
  providers: [CoaService],
  exports: [CoaService],
})
export class CoaModule {}