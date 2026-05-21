import { Module } from '@nestjs/common';
import { PrismaModule } from '@aupus/api-shared';
import { IotCatalogController } from './iot-catalog.controller';
import { IotCatalogService } from './iot-catalog.service';

@Module({
  imports: [PrismaModule],
  controllers: [IotCatalogController],
  providers: [IotCatalogService],
  exports: [IotCatalogService],
})
export class IotCatalogModule {}
