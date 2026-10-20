import { Module } from '@nestjs/common';
import { PlantaOperadoresController } from './planta-operadores.controller';
import { PlantaOperadoresService } from './planta-operadores.service';
import { UsuariosModule } from '../usuarios/usuarios.module';

@Module({
  imports: [UsuariosModule],
  controllers: [PlantaOperadoresController],
  providers: [PlantaOperadoresService],
  exports: [PlantaOperadoresService],
})
export class PlantaOperadoresModule {}
