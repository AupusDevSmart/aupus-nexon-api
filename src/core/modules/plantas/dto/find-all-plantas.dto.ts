// src/modules/plantas/dto/find-all-plantas.dto.ts
import { IsOptional, IsString, IsInt, Min, Max, IsIn } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class FindAllPlantasDto {
  @ApiPropertyOptional({ 
    description: 'Número da página para paginação', 
    example: 1, 
    default: 1, 
    minimum: 1 
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Página deve ser um número inteiro' })
  @Min(1, { message: 'Página deve ser maior que 0' })
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Número de itens por página',
    example: 10,
    default: 10,
    minimum: 1,
    maximum: 1000
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Limit deve ser um número inteiro' })
  @Min(1, { message: 'Limit deve ser maior que 0' })
  @Max(1000, { message: 'Limit não pode ser maior que 1000' })
  limit?: number = 10;

  @ApiPropertyOptional({ 
    description: 'Termo de busca para filtrar por nome, CNPJ, localização, cidade ou logradouro', 
    example: 'Planta Industrial'
  })
  @IsOptional()
  @IsString({ message: 'Search deve ser uma string' })
  @Transform(({ value }) => value?.trim())
  search?: string;

  @ApiPropertyOptional({ 
    description: 'ID do proprietário para filtrar plantas', 
    example: 'usr_proprietario_123456789012345678'
  })
  @IsOptional()
  @IsString({ message: 'ProprietarioId deve ser uma string' })
  proprietarioId?: string;

  @ApiPropertyOptional({ 
    description: 'Campo para ordenação', 
    example: 'nome',
    default: 'nome',
    enum: ['nome', 'cnpj', 'localizacao', 'cidade', 'criadoEm', 'proprietario']
  })
  @IsOptional()
  @IsString({ message: 'OrderBy deve ser uma string' })
  @IsIn(['nome', 'cnpj', 'localizacao', 'cidade', 'criadoEm', 'proprietario'], {
    message: 'OrderBy deve ser um dos valores: nome, cnpj, localizacao, cidade, criadoEm, proprietario'
  })
  orderBy?: string = 'nome';

  @ApiPropertyOptional({ 
    description: 'Direção da ordenação', 
    example: 'asc',
    default: 'asc',
    enum: ['asc', 'desc']
  })
  @IsOptional()
  @IsString({ message: 'OrderDirection deve ser uma string' })
  @IsIn(['asc', 'desc'], {
    message: 'OrderDirection deve ser "asc" ou "desc"'
  })
  orderDirection?: 'asc' | 'desc' = 'asc';
}