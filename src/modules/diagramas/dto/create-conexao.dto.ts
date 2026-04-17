import { IsString, IsEnum, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * V2 - SIMPLIFICADO: Apenas dados essenciais
 * Removido: visual (cor, tipo, espessura), pontosIntermediarios, rotulo, ordem
 * Todas as conexões terão visual padrão (linha branca/cinza, 2px, ortogonal)
 */

enum PortaEnum {
  TOP = 'top',
  BOTTOM = 'bottom',
  LEFT = 'left',
  RIGHT = 'right',
}

class PortaDto {
  @ApiProperty({ description: 'ID do equipamento', example: 'equip_001' })
  @IsString()
  equipamentoId: string;

  @ApiProperty({ description: 'Porta do equipamento', enum: PortaEnum, example: 'right' })
  @IsEnum(PortaEnum)
  porta: PortaEnum;
}

export class CreateConexaoDto {
  @ApiProperty({ description: 'Equipamento e porta de origem', type: PortaDto })
  @ValidateNested()
  @Type(() => PortaDto)
  origem: PortaDto;

  @ApiProperty({ description: 'Equipamento e porta de destino', type: PortaDto })
  @ValidateNested()
  @Type(() => PortaDto)
  destino: PortaDto;
}

export class CreateConexoesBulkDto {
  @ApiProperty({ description: 'Lista de conexões a criar', type: [CreateConexaoDto] })
  @ValidateNested({ each: true })
  @Type(() => CreateConexaoDto)
  conexoes: CreateConexaoDto[];
}
