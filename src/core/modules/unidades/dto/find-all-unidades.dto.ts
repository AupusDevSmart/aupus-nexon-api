import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsOptional, IsInt, Min, IsString, IsEnum } from 'class-validator';
import { TipoUnidade, StatusUnidade } from './create-unidade.dto';

export class FindAllUnidadesDto {
  @ApiPropertyOptional({
    description: 'Número da página',
    example: 1,
    minimum: 1,
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Página deve ser um número inteiro' })
  @Min(1, { message: 'Página mínima é 1' })
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Quantidade de itens por página',
    example: 10,
    minimum: 1,
    maximum: 100,
    default: 10,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Limit deve ser um número inteiro' })
  @Min(1, { message: 'Limit mínimo é 1' })
  limit?: number = 10;

  @ApiPropertyOptional({
    description: 'Busca textual (nome, cidade, estado)',
    example: 'Solar',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Filtrar por ID da planta',
    example: 'plt_01234567890123456789012345',
  })
  @IsOptional()
  @IsString()
  plantaId?: string;

  @ApiPropertyOptional({
    description: 'Filtrar por ID do proprietário (busca em plantas do proprietário)',
    example: 'usr_01234567890123456789012345',
  })
  @IsOptional()
  @IsString()
  proprietarioId?: string;

  @ApiPropertyOptional({
    description: 'Filtrar por tipo de unidade',
    enum: TipoUnidade,
    example: TipoUnidade.GERACAO,
  })
  @IsOptional()
  @IsEnum(TipoUnidade)
  tipo?: TipoUnidade;

  @ApiPropertyOptional({
    description: 'Filtrar por status',
    enum: StatusUnidade,
    example: StatusUnidade.ativo,
  })
  @IsOptional()
  @IsEnum(StatusUnidade)
  status?: StatusUnidade;

  @ApiPropertyOptional({
    description: 'Filtrar por estado',
    example: 'SP',
  })
  @IsOptional()
  @IsString()
  estado?: string;

  @ApiPropertyOptional({
    description: 'Campo para ordenação',
    enum: ['nome', 'tipo', 'cidade', 'potencia', 'criadoEm'],
    example: 'nome',
    default: 'nome',
  })
  @IsOptional()
  @IsString()
  orderBy?: 'nome' | 'tipo' | 'cidade' | 'potencia' | 'criadoEm' = 'nome';

  @ApiPropertyOptional({
    description: 'Direção da ordenação',
    enum: ['asc', 'desc'],
    example: 'asc',
    default: 'asc',
  })
  @IsOptional()
  @IsString()
  orderDirection?: 'asc' | 'desc' = 'asc';
}
