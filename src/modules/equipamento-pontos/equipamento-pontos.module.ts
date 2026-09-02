import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';

import { EquipamentoPontosController } from './equipamento-pontos.controller';
import { EquipamentoPontosService } from './equipamento-pontos.service';

/**
 * Modulo de CRUD de pontos logicos por equipamento.
 *
 * Roteado sob /equipamentos/:id/pontos.
 */
@Module({
  imports: [PrismaModule],
  controllers: [EquipamentoPontosController],
  providers: [EquipamentoPontosService],
  exports: [EquipamentoPontosService],
})
export class EquipamentoPontosModule {}
