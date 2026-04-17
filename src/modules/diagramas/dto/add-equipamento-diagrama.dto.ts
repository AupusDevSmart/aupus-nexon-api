import { IsString, IsOptional, IsNumber, IsObject, Min, Max, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

class PosicaoDto {
  @ApiProperty({ description: 'Coordenada X', example: 100 })
  @IsNumber()
  @Min(0)
  x: number;

  @ApiProperty({ description: 'Coordenada Y', example: 200 })
  @IsNumber()
  @Min(0)
  y: number;
}

class LabelOffsetDto {
  @ApiProperty({ description: 'Offset X em pixels (pode ser negativo)', example: -20 })
  @IsNumber()
  x: number;

  @ApiProperty({ description: 'Offset Y em pixels (pode ser negativo)', example: 15 })
  @IsNumber()
  y: number;
}

class DimensoesDto {
  @ApiProperty({ description: 'Largura do equipamento', example: 64 })
  @IsNumber()
  @Min(10)
  largura: number;

  @ApiProperty({ description: 'Altura do equipamento', example: 64 })
  @IsNumber()
  @Min(10)
  altura: number;
}

export class AddEquipamentoDiagramaDto {
  @ApiProperty({ description: 'ID do equipamento', example: 'equip_001' })
  @IsString()
  equipamentoId: string;

  @ApiProperty({ description: 'Posição do equipamento no canvas', type: PosicaoDto })
  @ValidateNested()
  @Type(() => PosicaoDto)
  posicao: PosicaoDto;

  @ApiPropertyOptional({ description: 'Rotação em graus (0-360)', example: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(360)
  rotacao?: number;

  @ApiPropertyOptional({ description: 'Posição do label (top, bottom, left, right)', example: 'bottom' })
  @IsOptional()
  @IsString()
  labelPosition?: string;

  @ApiPropertyOptional({ description: 'Offset customizado do label em pixels', type: LabelOffsetDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => LabelOffsetDto)
  labelOffset?: LabelOffsetDto;

  @ApiPropertyOptional({ description: 'Dimensões customizadas', type: DimensoesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DimensoesDto)
  dimensoes?: DimensoesDto;

  @ApiPropertyOptional({ description: 'Propriedades customizadas do equipamento', example: { customLabel: 'INV-01', showTag: true } })
  @IsOptional()
  @IsObject()
  propriedades?: Record<string, any>;
}

export class UpdateEquipamentoDiagramaDto {
  @ApiPropertyOptional({ description: 'Posição do equipamento no canvas', type: PosicaoDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PosicaoDto)
  posicao?: PosicaoDto;

  @ApiPropertyOptional({ description: 'Rotação em graus (0-360)', example: 45 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(360)
  rotacao?: number;

  @ApiPropertyOptional({ description: 'Posição do label (top, bottom, left, right)', example: 'bottom' })
  @IsOptional()
  @IsString()
  labelPosition?: string;

  @ApiPropertyOptional({ description: 'Offset customizado do label em pixels', type: LabelOffsetDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => LabelOffsetDto)
  labelOffset?: LabelOffsetDto;

  @ApiPropertyOptional({ description: 'Dimensões customizadas', type: DimensoesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DimensoesDto)
  dimensoes?: DimensoesDto;

  @ApiPropertyOptional({ description: 'Propriedades customizadas do equipamento' })
  @IsOptional()
  @IsObject()
  propriedades?: Record<string, any>;
}

export class AddEquipamentosBulkDto {
  @ApiProperty({ description: 'Lista de equipamentos a adicionar', type: [AddEquipamentoDiagramaDto] })
  @ValidateNested({ each: true })
  @Type(() => AddEquipamentoDiagramaDto)
  equipamentos: AddEquipamentoDiagramaDto[];
}
