import { ApiProperty } from '@nestjs/swagger';
import { Equipamento } from '../entities/equipamento.entity';

export class PaginationDto {
  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 10 })
  limit: number;

  @ApiProperty({ example: 25 })
  total: number;

  @ApiProperty({ example: 3 })
  pages: number;
}

export class EquipamentosListResponse {
  @ApiProperty({ type: [Equipamento] })
  data: Equipamento[];

  @ApiProperty({ type: PaginationDto })
  pagination: PaginationDto;
}

export class PlantaInfo {
  @ApiProperty({ example: 'plt_01234567890123456789012345' })
  id: string;

  @ApiProperty({ example: 'Planta Industrial São Paulo' })
  nome: string;
}

export class EquipamentoUCBasico {
  @ApiProperty({ example: 'eqp_01234567890123456789012345' })
  id: string;

  @ApiProperty({ example: 'Motor Elétrico Principal' })
  nome: string;

  @ApiProperty({ example: 'WEG' })
  fabricante: string;

  @ApiProperty({ example: 'W22-15HP' })
  modelo: string;

  @ApiProperty({ type: PlantaInfo })
  planta: PlantaInfo;
}