import { Module } from '@nestjs/common';
import { PrismaModule } from '@aupus/api-shared';

import { OcppController } from './ocpp.controller';
import { OcppService } from './ocpp.service';

/**
 * CSMS OCPP 1.6-J. O OcppService anexa um servidor WebSocket (`ws`) ao HTTP server do
 * Nest via HttpAdapterHost (global do core) em `onApplicationBootstrap`. PermissionScope
 * vem global do AuthModule. Ver docs/IOT-OCPP-CSMS.md.
 */
@Module({
  imports: [PrismaModule],
  controllers: [OcppController],
  providers: [OcppService],
  exports: [OcppService],
})
export class OcppModule {}
