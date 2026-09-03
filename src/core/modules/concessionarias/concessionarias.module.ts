import { Module } from '@nestjs/common';
import { ConcessionariasService } from './concessionarias.service';
import { AnexosConcessionariasService } from './anexos-concessionarias.service';
import { ConcessionariasController } from './concessionarias.controller';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [ConcessionariasController],
  providers: [ConcessionariasService, AnexosConcessionariasService],
  exports: [ConcessionariasService, AnexosConcessionariasService],
})
export class ConcessionariasModule {}
