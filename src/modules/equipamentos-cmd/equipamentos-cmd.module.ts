import { Module } from '@nestjs/common';
import { PrismaModule } from '@aupus/api-shared';

import { MqttModule } from '../../shared/mqtt/mqtt.module';
import { EquipamentosCmdController } from './equipamentos-cmd.controller';
import { EquipamentosAcionarPontoController } from './acionar-ponto.controller';
import { EquipamentosCmdService } from './equipamentos-cmd.service';

/**
 * Modulo de comandos MQTT para equipamentos.
 *
 * Importa explicitamente MqttModule (publishCommand) e PrismaModule
 * (lookup de equipamento). Mesmo padrao do OtaModule.
 */
@Module({
  imports: [PrismaModule, MqttModule],
  controllers: [EquipamentosCmdController, EquipamentosAcionarPontoController],
  providers: [EquipamentosCmdService],
  exports: [EquipamentosCmdService],
})
export class EquipamentosCmdModule {}
