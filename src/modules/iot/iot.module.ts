import { Module } from '@nestjs/common';
import { PrismaModule } from '@aupus/api-shared';
import { IoTController } from './iot.controller';
import { IoTService } from './iot.service';

/**
 * Módulo IoT — projetos/diagramas consumidos pelo componente IoTDiagram do React.
 *
 * NOTE: Restaurado a partir de dist/src/modules/iot/iot.module.js (2026-04-28).
 * O .ts havia sido removido do repositório, mas o .js continuava sendo
 * carregado em runtime — porém o último build (2026-04-23) já não importava
 * mais o IoTModule no app.module.js, criando uma bomba-relógio: na próxima
 * reinicialização do staging-nexon-api, as rotas /api/v1/iot/projetos
 * deixariam de existir e quebrariam o frontend IoT.
 *
 * Importa PrismaModule para que IoTService possa injetar PrismaService.
 */
@Module({
  imports: [PrismaModule],
  controllers: [IoTController],
  providers: [IoTService],
  exports: [IoTService],
})
export class IoTModule {}
