import { Module } from '@nestjs/common';
import { DiagramasController } from './diagramas.controller';
import { DiagramasService } from './services/diagramas.service';
import { EquipamentosDiagramaService } from './services/equipamentos-diagrama.service';
import { ConexoesDiagramaService } from './services/conexoes-diagrama.service';
import { PrismaModule } from '@aupus/api-shared';

@Module({
  imports: [PrismaModule],
  controllers: [DiagramasController],
  providers: [
    DiagramasService,
    EquipamentosDiagramaService,
    ConexoesDiagramaService,
  ],
  exports: [
    DiagramasService,
    EquipamentosDiagramaService,
    ConexoesDiagramaService,
  ],
})
export class DiagramasModule {}
