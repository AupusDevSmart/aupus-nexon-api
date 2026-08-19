// aupus-nexon-api - modulo raiz
// Importa modulos compartilhados de @aupus/api-shared + modulos especificos do NexOn
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { SentryModule } from '@sentry/nestjs/setup';
import { SentryGlobalFilter } from '@sentry/nestjs/setup';
import { APP_FILTER } from '@nestjs/core';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { MqttModule } from './shared/mqtt/mqtt.module';
import { WebSocketModule } from './websocket/websocket.module';

// Modulos NexOn-only
import { HealthModule } from './modules/health/health.module';
import { DiagramasModule } from './modules/diagramas/diagramas.module';
import { EquipamentosDadosModule } from './modules/equipamentos-dados/equipamentos-dados.module';
import { ConfiguracaoDemandaModule } from './modules/configuracao-demanda/configuracao-demanda.module';
import { CoaModule } from './modules/coa/coa.module';
import { LogsMqttModule } from './modules/logs-mqtt/logs-mqtt.module';
import { RegrasLogsMqttModule } from './modules/regras-logs-mqtt/regras-logs-mqtt.module';
import { RelatoriosModule } from './modules/relatorios/relatorios.module';
import { BombaCombustivelModule } from './modules/bomba-combustivel/bomba-combustivel.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { IoTModule } from './modules/iot/iot.module';
import { OtaModule } from './modules/ota/ota.module';
import { EquipamentosCmdModule } from './modules/equipamentos-cmd/equipamentos-cmd.module';
import { EquipamentoPontosModule } from './modules/equipamento-pontos/equipamento-pontos.module';
import { TonBoModule } from './modules/ton-bo/ton-bo.module';
import { SinopticoModule } from './modules/sinoptico/sinoptico.module';
import { TonBiModule } from './modules/ton-bi/ton-bi.module';
import { MonitoramentoFvModule } from './modules/monitoramento-fv/monitoramento-fv.module';
import { ReleEventosModule } from './modules/rele-eventos/rele-eventos.module';

// Modulos compartilhados (de @aupus/api-shared)
import {
  PrismaModule,
  MailModule,
  AuthModule,
  UsuariosModule,
  RolesModule,
  PermissionsModule,
  PlantasModule,
  PlantaOperadoresModule,
  UnidadesModule,
  EquipamentosModule,
  TiposEquipamentosModule,
  CategoriasEquipamentosModule,
  ConcessionariasModule,
} from '@aupus/api-shared';
import { IotCatalogModule } from './modules/iot-catalog/iot-catalog.module';

@Module({
  imports: [
    SentryModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),

    PrismaModule,
    MailModule,
    MqttModule,
    WebSocketModule,

    HealthModule,
    AuthModule,

    // Compartilhados
    UsuariosModule,
    RolesModule,
    PermissionsModule,
    PlantasModule,
    PlantaOperadoresModule,
    UnidadesModule,
    EquipamentosModule,
    TiposEquipamentosModule,
    CategoriasEquipamentosModule,
    ConcessionariasModule,

    // NexOn-only
    IotCatalogModule,
    DiagramasModule,
    EquipamentosDadosModule,
    ConfiguracaoDemandaModule,
    CoaModule,
    LogsMqttModule,
    RegrasLogsMqttModule,
    UploadsModule,
    IoTModule,
    OtaModule,
    EquipamentosCmdModule,
    EquipamentoPontosModule,
    TonBoModule,
    SinopticoModule,
    TonBiModule,
    MonitoramentoFvModule,
    ReleEventosModule,
    RelatoriosModule,
    BombaCombustivelModule,
  ],
  controllers: [AppController],
  providers: [
    {
      provide: APP_FILTER,
      useClass: SentryGlobalFilter,
    },
    AppService,
  ],
})
export class AppModule {}
