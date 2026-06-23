import { Module } from '@nestjs/common';
import { PrismaModule } from '@aupus/api-shared';

import { TonBiController } from './ton-bi.controller';
import { TonBiService } from './ton-bi.service';

/**
 * Modulo de mapeamento BI (Boolean Input) -> ponto de equipamento + leitura
 * de estado das entradas digitais (d1..d6).
 *
 * Rotas sob /equipamentos/:tonId/bis. Espelha o TonBoModule; difere em:
 *  - ponto destino eh tipo "status" (nao "comando")
 *  - tem flag `invertido` (contato NF) em vez de `pulso_ms`
 *  - expoe GET /bis/estado (estado atual liga/desliga ja resolvido)
 */
@Module({
  imports: [PrismaModule],
  controllers: [TonBiController],
  providers: [TonBiService],
  exports: [TonBiService],
})
export class TonBiModule {}
