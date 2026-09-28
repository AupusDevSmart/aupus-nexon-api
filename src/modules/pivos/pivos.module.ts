import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { PivosController } from './pivos.controller';
import { PivosService } from './pivos.service';

@Module({
  imports: [PrismaModule],
  controllers: [PivosController],
  providers: [PivosService],
})
export class PivosModule {}
