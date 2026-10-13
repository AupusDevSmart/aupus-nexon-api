import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { WhatsappService } from '../monitoramento-fv/notificacao/whatsapp.service';
import { AlarmesComunicacaoService } from './alarmes-comunicacao.service';
import { AlarmesComunicacaoController } from './alarmes-comunicacao.controller';

@Module({
  imports: [PrismaModule],
  controllers: [AlarmesComunicacaoController],
  providers: [AlarmesComunicacaoService, WhatsappService],
  exports: [AlarmesComunicacaoService],
})
export class AlarmesComunicacaoModule {}
