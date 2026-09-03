import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class ConcessionariaQueryDto {
  @ApiProperty({ description: 'Número da página', required: false, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ description: 'Itens por página', required: false, default: 10, maximum: 1000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number = 10;

  @ApiProperty({ description: 'Buscar por nome', required: false })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({ description: 'Filtrar por estado (sigla)', required: false })
  @IsOptional()
  @IsString()
  estado?: string;

  @ApiProperty({
    description: 'Campo para ordenação',
    required: false,
    default: 'created_at',
    enum: ['nome', 'estado', 'data_inicio', 'data_validade', 'created_at']
  })
  @IsOptional()
  @IsString()
  orderBy?: string = 'created_at';

  @ApiProperty({
    description: 'Direção da ordenação',
    required: false,
    default: 'desc',
    enum: ['asc', 'desc']
  })
  @IsOptional()
  @IsString()
  orderDirection?: 'asc' | 'desc' = 'desc';
}
