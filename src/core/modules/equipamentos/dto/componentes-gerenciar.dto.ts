import { ApiProperty } from '@nestjs/swagger';
import { CreateEquipamentoDto } from './create-equipamento.dto';

export class ComponentesUARLoteDto {
  @ApiProperty({ type: [CreateEquipamentoDto] })
  componentes: CreateEquipamentoDto[];
}

export class EstatisticasPlantaDto {
  @ApiProperty()
  planta: {
    id: string;
    nome: string;
    localizacao: string;
  };

  @ApiProperty()
  totais: {
    equipamentos: number;
    equipamentosUC: number;
    componentesUAR: number;
  };

  @ApiProperty()
  porCriticidade: Record<string, number>;

  @ApiProperty()
  financeiro: {
    valorTotalContabil: number;
  };
}