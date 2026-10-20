import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { GeracaoAnaliseController } from './geracao-analise.controller';
import { GeracaoAnaliseService } from './geracao-analise.service';
import { GeracaoAnaliseJobs } from './geracao-analise.jobs';
import { GeracaoConfigService } from './geracao-config.service';
import { IrradianciaService } from './irradiancia/irradiancia.service';
import { IRRADIANCE_PROVIDER } from './irradiancia/irradiance-provider';
import { OpenMeteoProvider } from './irradiancia/open-meteo.provider';

/**
 * Análise de geração (NEXON-16). Trocar o provedor de satélite (ex.: Solcast) = outra classe
 * que implementa IrradianceProvider no `useClass` abaixo. Ver docs/GERACAO-ANALISE.md.
 */
@Module({
  imports: [PrismaModule],
  controllers: [GeracaoAnaliseController],
  providers: [
    GeracaoAnaliseService,
    GeracaoConfigService,
    IrradianciaService,
    GeracaoAnaliseJobs,
    { provide: IRRADIANCE_PROVIDER, useClass: OpenMeteoProvider },
  ],
  exports: [GeracaoAnaliseService],
})
export class GeracaoAnaliseModule {}
