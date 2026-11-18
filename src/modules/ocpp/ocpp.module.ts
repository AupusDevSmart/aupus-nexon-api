import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';

import { OcppController } from './ocpp.controller';
import { OcppRepositorio } from './ocpp.repositorio';
import { OcppService } from './ocpp.service';

/**
 * Central OCPP 1.6-J. O OcppService prende um servidor WebSocket (`ws`) ao servidor HTTP do
 * Nest via HttpAdapterHost (global do core) em `onApplicationBootstrap`. Só conecta
 * carregador cadastrado e com chave; o que as mensagens significam para a recarga está em
 * `carregador-eletrico/carregador-ocpp.service.ts`. PermissionScope vem global do AuthModule.
 * Contrato e operação: NexON/docs/carregador/API-CARREGADOR-OCPP.md (ADR 0006).
 */
@Module({
  imports: [PrismaModule],
  controllers: [OcppController],
  providers: [OcppService, OcppRepositorio],
  exports: [OcppService],
})
export class OcppModule {}
