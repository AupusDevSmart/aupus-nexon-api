import { Module } from '@nestjs/common';
import { PrismaModule } from '@aupus/api-shared';
import { RelatoriosController } from './relatorios.controller';
import { RelatoriosPublicController } from './relatorios-publico.controller';
import { RelatoriosConsumoController } from './relatorios-consumo.controller';
import { RelatoriosConsumoPublicController } from './relatorios-consumo-publico.controller';
import { RelatoriosService } from './relatorios.service';
import { BoletimSemanalService } from './boletim-semanal.service';
import { BoletimSemanalEnvioService } from './boletim-semanal-envio.service';
import { BoletimSemanalCron } from './boletim-semanal.cron';
import { BoletimConsumoService } from './boletim-consumo.service';
import { BoletimConsumoEnvioService } from './boletim-consumo-envio.service';
import { BoletimConsumoCron } from './boletim-consumo.cron';
import { WhatsappService } from '../monitoramento-fv/notificacao/whatsapp.service';
import { EquipamentosDadosModule } from '../equipamentos-dados/equipamentos-dados.module';

@Module({
  imports: [PrismaModule, EquipamentosDadosModule],
  controllers: [
    RelatoriosController,
    RelatoriosPublicController,
    RelatoriosConsumoController,
    RelatoriosConsumoPublicController,
  ],
  providers: [
    RelatoriosService,
    BoletimSemanalService,
    BoletimSemanalEnvioService,
    BoletimSemanalCron,
    BoletimConsumoService,
    BoletimConsumoEnvioService,
    BoletimConsumoCron,
    WhatsappService,
  ],
  exports: [RelatoriosService, BoletimSemanalService],
})
export class RelatoriosModule {}
