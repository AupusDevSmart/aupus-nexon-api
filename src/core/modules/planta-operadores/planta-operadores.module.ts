import { Module } from '@nestjs/common';
import { PlantaOperadoresController } from './planta-operadores.controller';
import { PlantaOperadoresService } from './planta-operadores.service';

@Module({
  controllers: [PlantaOperadoresController],
  providers: [PlantaOperadoresService],
  exports: [PlantaOperadoresService],
})
export class PlantaOperadoresModule {}
