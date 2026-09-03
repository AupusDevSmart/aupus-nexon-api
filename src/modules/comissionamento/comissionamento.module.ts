import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';

import { ComissionamentoController } from './comissionamento.controller';
import { ComissionamentoService } from './comissionamento.service';

/**
 * Comissionamento IoT (Fase 0): motor de checks de coerência (comissionamento.checks.ts)
 * + registro de aceite (tabela iot_comissionamento). PermissionScopeService vem global
 * do AuthModule (mesmo padrão de TonAiModule). Ver docs/IOT-NEXON-CONFIABILIDADE.md §3.2.
 */
@Module({
  imports: [PrismaModule],
  controllers: [ComissionamentoController],
  providers: [ComissionamentoService],
  exports: [ComissionamentoService],
})
export class ComissionamentoModule {}
