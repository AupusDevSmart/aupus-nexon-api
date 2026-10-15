import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { PivosController } from './pivos.controller';
import { PivosService } from './pivos.service';
import { PivoSequenciaService } from './pivo-sequencia.service';
import { PivoAutomacaoService } from './pivo-automacao.service';
import { EquipamentosCmdModule } from '../equipamentos-cmd/equipamentos-cmd.module';

@Module({
  imports: [PrismaModule, EquipamentosCmdModule],
  controllers: [PivosController],
  providers: [PivosService, PivoSequenciaService, PivoAutomacaoService],
})
export class PivosModule {}
