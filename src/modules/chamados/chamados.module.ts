import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { WhatsappService } from '../monitoramento-fv/notificacao/whatsapp.service';
import { ChamadosController } from './chamados.controller';
import { ChamadosService } from './chamados.service';
import { ChamadosEncaminhamentoWorker } from './chamados-encaminhamento.worker';

@Module({
  imports: [PrismaModule],
  controllers: [ChamadosController],
  providers: [ChamadosService, ChamadosEncaminhamentoWorker, WhatsappService],
  exports: [ChamadosService],
})
export class ChamadosModule {}
