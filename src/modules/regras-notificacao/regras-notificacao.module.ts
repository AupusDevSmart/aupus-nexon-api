import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { RegrasNotificacaoController } from './regras-notificacao.controller';
import { RegrasNotificacaoService } from './regras-notificacao.service';

@Module({
  imports: [PrismaModule],
  controllers: [RegrasNotificacaoController],
  providers: [RegrasNotificacaoService],
  exports: [RegrasNotificacaoService],
})
export class RegrasNotificacaoModule {}
