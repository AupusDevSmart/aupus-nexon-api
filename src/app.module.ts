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
import { UploadsModule } from './modules/uploads/uploads.module';
import { IoTModule } from './modules/iot/iot.module';
import { OtaModule } from './modules/ota/ota.module';

// Modulos compartilhados (de @aupus/api-shared)
import {
  PrismaModule,
  MailModule,
  AuthModule,
  UsuariosModule,
  RolesModule,
  PermissionsModule,
  PlantasModule,
  UnidadesModule,
  EquipamentosModule,
  TiposEquipamentosModule,
  CategoriasEquipamentosModule,
  ConcessionariasModule,
} from '@aupus/api-shared';

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
    UnidadesModule,
    EquipamentosModule,
    TiposEquipamentosModule,
    CategoriasEquipamentosModule,
    ConcessionariasModule,

    // NexOn-only
    DiagramasModule,
    EquipamentosDadosModule,
    ConfiguracaoDemandaModule,
    CoaModule,
    LogsMqttModule,
    RegrasLogsMqttModule,
    UploadsModule,
    IoTModule,
    OtaModule,
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
