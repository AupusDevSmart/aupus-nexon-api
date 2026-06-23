import { Module } from '@nestjs/common';
import { PrismaModule } from '@aupus/api-shared';
import { SinopticoController } from './sinoptico.controller';
import { SinopticoService } from './sinoptico.service';

@Module({
  imports: [PrismaModule],
  controllers: [SinopticoController],
  providers: [SinopticoService],
  exports: [SinopticoService],
})
export class SinopticoModule {}
