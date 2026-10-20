import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { InversorStringsController } from './inversor-strings.controller';
import { InversorStringsService } from './inversor-strings.service';

@Module({
  imports: [PrismaModule],
  controllers: [InversorStringsController],
  providers: [InversorStringsService],
})
export class InversorStringsModule {}
