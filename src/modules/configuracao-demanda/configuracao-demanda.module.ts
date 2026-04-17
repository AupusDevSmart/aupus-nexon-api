import { Module } from '@nestjs/common';
import { ConfiguracaoDemandaController } from './configuracao-demanda.controller';
import { ConfiguracaoDemandaTestController } from './configuracao-demanda-test.controller';
import { ConfiguracaoDemandaService } from './configuracao-demanda.service';
import { PrismaModule } from '@aupus/api-shared';

@Module({
  imports: [PrismaModule],
  controllers: [ConfiguracaoDemandaController, ConfiguracaoDemandaTestController],
  providers: [ConfiguracaoDemandaService],
  exports: [ConfiguracaoDemandaService],
})
export class ConfiguracaoDemandaModule {}