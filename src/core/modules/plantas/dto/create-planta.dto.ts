// src/modules/plantas/dto/create-planta.dto.ts - GARANTIR CONSISTÊNCIA
import {
  IsString,
  IsNotEmpty,
  Length,
  ValidateNested,
  Matches,
  IsOptional
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class EnderecoDto {
  @ApiProperty({ 
    description: 'Logradouro completo', 
    example: 'Av. Industrial, 1000'
  })
  @IsString({ message: 'Logradouro deve ser uma string' })
  @IsNotEmpty({ message: 'Logradouro é obrigatório' })
  @Length(5, 200, { message: 'Logradouro deve ter entre 5 e 200 caracteres' })
  logradouro: string;

  @ApiProperty({ 
    description: 'Bairro', 
    example: 'Centro'
  })
  @IsString({ message: 'Bairro deve ser uma string' })
  @IsNotEmpty({ message: 'Bairro é obrigatório' })
  @Length(2, 100, { message: 'Bairro deve ter entre 2 e 100 caracteres' })
  bairro: string;

  @ApiProperty({ 
    description: 'Cidade', 
    example: 'São Paulo'
  })
  @IsString({ message: 'Cidade deve ser uma string' })
  @IsNotEmpty({ message: 'Cidade é obrigatória' })
  @Length(2, 100, { message: 'Cidade deve ter entre 2 e 100 caracteres' })
  cidade: string;

  @ApiProperty({ 
    description: 'UF', 
    example: 'SP'
  })
  @IsString({ message: 'UF deve ser uma string' })
  @IsNotEmpty({ message: 'UF é obrigatória' })
  @Length(2, 2, { message: 'UF deve ter exatamente 2 caracteres' })
  uf: string;

  @ApiProperty({ 
    description: 'CEP', 
    example: '01234-567'
  })
  @IsString({ message: 'CEP deve ser uma string' })
  @Matches(/^\d{5}-\d{3}$/, {
    message: 'CEP deve estar no formato XXXXX-XXX'
  })
  cep: string;
}

export class CreatePlantaDto {
  @ApiProperty({
    description: 'Nome da planta',
    example: 'Planta Industrial São Paulo'
  })
  @IsString({ message: 'Nome deve ser uma string' })
  @IsNotEmpty({ message: 'Nome é obrigatório' })
  @Length(2, 100, { message: 'Nome deve ter entre 2 e 100 caracteres' })
  nome: string;

  @ApiProperty({
    description: 'Número da Unidade Consumidora',
    example: '123456789',
    required: false
  })
  @IsOptional()
  @IsString({ message: 'Número UC deve ser uma string' })
  @Length(1, 255, { message: 'Número UC deve ter entre 1 e 255 caracteres' })
  numero_uc?: string;

  @ApiProperty({
    description: 'CNPJ da planta',
    example: '12.345.678/0001-90'
  })
  @IsString({ message: 'CNPJ deve ser uma string' })
  @Matches(/^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/, {
    message: 'CNPJ deve estar no formato XX.XXX.XXX/XXXX-XX'
  })
  cnpj: string;

  @ApiProperty({ 
    description: 'ID do proprietário da planta', 
    example: 'usr_proprietario_123456789012345678'
  })
  @IsString({ message: 'ProprietarioId deve ser uma string' })
  @IsNotEmpty({ message: 'ProprietarioId é obrigatório' })
  proprietarioId: string;

  @ApiProperty({ 
    description: 'Horário de funcionamento da planta', 
    example: '08:00 às 18:00'
  })
  @IsString({ message: 'Horário de funcionamento deve ser uma string' })
  @Length(5, 50, { message: 'Horário de funcionamento deve ter entre 5 e 50 caracteres' })
  horarioFuncionamento: string;

  @ApiProperty({ 
    description: 'Localização específica da planta', 
    example: 'Zona Sul - Galpão 1'
  })
  @IsString({ message: 'Localização deve ser uma string' })
  @Length(5, 200, { message: 'Localização deve ter entre 5 e 200 caracteres' })
  localizacao: string;

  @ApiProperty({ 
    description: 'Endereço completo da planta',
    type: EnderecoDto
  })
  @ValidateNested()
  @Type(() => EnderecoDto)
  endereco: EnderecoDto;
}