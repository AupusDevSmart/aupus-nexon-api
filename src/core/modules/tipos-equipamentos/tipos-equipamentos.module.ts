import { Module } from '@nestjs/common';
import { TiposEquipamentosController } from './tipos-equipamentos.controller';
import { TiposEquipamentosService } from './tipos-equipamentos.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [TiposEquipamentosController],
  providers: [TiposEquipamentosService],
  exports: [TiposEquipamentosService],
})
export class TiposEquipamentosModule {}
