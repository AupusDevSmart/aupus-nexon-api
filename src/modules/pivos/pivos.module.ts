import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { PivosController } from './pivos.controller';
import { PivosService } from './pivos.service';
import { PivoSequenciaService } from './pivo-sequencia.service';
import { PivoAutomacaoService } from './pivo-automacao.service';
import { PivoTonService } from './pivo-ton.service';
import { MqttModule } from '../../shared/mqtt/mqtt.module';
import { EquipamentosCmdModule } from '../equipamentos-cmd/equipamentos-cmd.module';

@Module({
  imports: [PrismaModule, EquipamentosCmdModule, MqttModule],
  controllers: [PivosController],
  providers: [PivosService, PivoSequenciaService, PivoAutomacaoService, PivoTonService],
})
export class PivosModule {}
