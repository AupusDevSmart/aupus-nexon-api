import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { NotificacaoController } from './notificacao/notificacao.controller';
import { NotificacaoService } from './notificacao/notificacao.service';
import { WhatsappService } from './notificacao/whatsapp.service';
import { NotificacaoDispatcherService } from './notificacao/dispatcher.service';
import { EnvioAdminService } from './notificacao/envio-admin.service';
import { NotificacaoCron } from './notificacao/notificacao.cron';
import { FusionSolarService } from './integracoes/fusion-solar/fusion-solar.service';
import { IsolarCloudService } from './integracoes/isolarcloud/isolarcloud.service';
import { DeyeCloudService } from './integracoes/deye-cloud/deye-cloud.service';
import { MonitoramentoSyncService } from './integracoes/sync.service';
import { MonitoramentoSyncHorarioService } from './integracoes/sync-horario.service';
import { FusionInverterFallbackService } from './integracoes/fusion-inverter-fallback.service';
import { MonitoramentoController } from './integracoes/monitoramento.controller';
import { GeracaoManualController } from './geracao/geracao-manual.controller';
import { GeracaoManualService } from './geracao/geracao-manual.service';
import { ConfigFvController } from './config/config-fv.controller';
import { ConfigFvService } from './config/config-fv.service';

/**
 * Monitoramento FV — integração das funcionalidades do BDO no NexON.
 * - Notificações: registro de tipos + preview (SEM envio; dispatcher/wpp é Fase 2).
 * - Integrações de nuvem: connectors Fusion/iSolar/Deye + sync MANUAL (sem cron; o cron
 *   das 21h continua no bdo-aupus-api durante a transição) → grava geracao_diaria_plantas.
 * Ver docs/INTEGRACAO_NEXON_DASHBOARD.md.
 */
@Module({
  imports: [PrismaModule],
  controllers: [NotificacaoController, MonitoramentoController, GeracaoManualController, ConfigFvController],
  providers: [
    NotificacaoService,
    WhatsappService,
    NotificacaoDispatcherService,
    EnvioAdminService,
    NotificacaoCron,
    FusionSolarService,
    IsolarCloudService,
    DeyeCloudService,
    MonitoramentoSyncService,
    MonitoramentoSyncHorarioService,
    FusionInverterFallbackService,
    GeracaoManualService,
    ConfigFvService,
  ],
  exports: [NotificacaoService, MonitoramentoSyncService],
})
export class MonitoramentoFvModule {}
