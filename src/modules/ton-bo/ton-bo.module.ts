import { Module } from '@nestjs/common';
import { PrismaModule } from '@aupus/api-shared';

import { TonBoController } from './ton-bo.controller';
import { TonBoService } from './ton-bo.service';

/**
 * Modulo de mapeamento BO (binary output) -> ponto de equipamento.
 *
 * Rotas sob /equipamentos/:tonId/bos. Aplica-se a equipamentos que sao TON
 * (validacao por categoria=TON eh deferida — o frontend filtra TONs e o
 * controller aceita qualquer equipamento; criar BO em equipamento sem reles
 * eh logicamente valido mas inutil).
 */
@Module({
  imports: [PrismaModule],
  controllers: [TonBoController],
  providers: [TonBoService],
  exports: [TonBoService],
})
export class TonBoModule {}
