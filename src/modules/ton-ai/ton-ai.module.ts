import { Module } from '@nestjs/common';
import { PrismaModule } from '@aupus/api-shared';

import { TonAiController } from './ton-ai.controller';
import { TonAiService } from './ton-ai.service';

/**
 * Modulo de mapeamento AI (Analog Input) -> ponto (tipo medicao) + escala mV->%.
 *
 * Rotas sob /equipamentos/:tonId/ais. Espelha o TonBiModule; difere em:
 *  - ponto destino eh tipo "medicao" (nao "status")
 *  - tem mv_0/mv_100 (escala linear) em vez de invertido
 *  - nao ha estado ao vivo (nao existe leitura analogica em equipamento_io_estado)
 */
@Module({
  imports: [PrismaModule],
  controllers: [TonAiController],
  providers: [TonAiService],
  exports: [TonAiService],
})
export class TonAiModule {}
