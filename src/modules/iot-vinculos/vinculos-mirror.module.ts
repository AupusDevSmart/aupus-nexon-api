import { Global, Module } from '@nestjs/common';
import { VinculosMirrorService } from './vinculos-mirror.service';

/**
 * Espelhamento dos vínculos (Fase 3 — dual-write) para `iot_vinculos`. @Global
 * para ser injetável nos serviços de ton-bo/bi/ai e no iot.service sem reimportar.
 */
@Global()
@Module({
  providers: [VinculosMirrorService],
  exports: [VinculosMirrorService],
})
export class VinculosMirrorModule {}
