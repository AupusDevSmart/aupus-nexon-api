import { Module } from '@nestjs/common';
import { PrismaModule } from '@aupus/api-shared';
import { ReleEventosController } from './rele-eventos.controller';
import { ReleEventosService } from './rele-eventos.service';

/**
 * SOE de relé de proteção — leitura + curadoria do mapa FUN/INF.
 * Ingestão é do `mqtt.service` (subtópico `<base>/evt`).
 * Ver docs/IOT-SOE-EVENTOS-RELE.md.
 */
@Module({
  imports: [PrismaModule],
  controllers: [ReleEventosController],
  providers: [ReleEventosService],
  exports: [ReleEventosService],
})
export class ReleEventosModule {}
