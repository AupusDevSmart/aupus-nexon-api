import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { SinopticoController } from './sinoptico.controller';
import { SinopticoService } from './sinoptico.service';

@Module({
  imports: [PrismaModule],
  controllers: [SinopticoController],
  providers: [SinopticoService],
  exports: [SinopticoService],
})
export class SinopticoModule {}
