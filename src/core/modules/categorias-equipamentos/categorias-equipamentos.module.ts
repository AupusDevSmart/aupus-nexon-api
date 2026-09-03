import { Module } from '@nestjs/common';
import { CategoriasEquipamentosService } from './categorias-equipamentos.service';
import { CategoriasEquipamentosController } from './categorias-equipamentos.controller';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [CategoriasEquipamentosController],
  providers: [CategoriasEquipamentosService],
  exports: [CategoriasEquipamentosService],
})
export class CategoriasEquipamentosModule {}
