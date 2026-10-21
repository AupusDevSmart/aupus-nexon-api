import { Module } from '@nestjs/common';
import { CoaController } from './coa.controller';
import { CoaService } from './coa.service';
import { PrismaModule } from '@/core';
import { EquipamentosDadosModule } from '../equipamentos-dados/equipamentos-dados.module';
import { GeracaoAnaliseModule } from '../geracao-analise/geracao-analise.module';

@Module({
  imports: [PrismaModule, EquipamentosDadosModule, GeracaoAnaliseModule],
  controllers: [CoaController],
  providers: [CoaService],
  exports: [CoaService],
})
export class CoaModule {}