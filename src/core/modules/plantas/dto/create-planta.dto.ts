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
import { VazioEhNulo } from '@/core/common/vazio-eh-nulo';

// Nov/2026: so o nome e obrigatorio. Muitas plantas sao cadastradas sem CNPJ,
// CEP ou endereco (o dado nao existe ainda); a obrigatoriedade volta campo a
// campo. Vazio vira null (`VazioEhNulo`), e o formato so e conferido quando o
// campo vem preenchido.

export class EnderecoDto {
  @ApiProperty({ 
    description: 'Logradouro completo', 
    example: 'Av. Industrial, 1000',
    required: false
  })
  @VazioEhNulo()
  @IsOptional()
  @IsString({ message: 'Logradouro deve ser uma string' })
  @Length(5, 200, { message: 'Logradouro deve ter entre 5 e 200 caracteres' })
  logradouro?: string | null;

  @ApiProperty({ 
    description: 'Bairro', 
    example: 'Centro',
    required: false
  })
  @VazioEhNulo()
  @IsOptional()
  @IsString({ message: 'Bairro deve ser uma string' })
  @Length(2, 100, { message: 'Bairro deve ter entre 2 e 100 caracteres' })
  bairro?: string | null;

  @ApiProperty({ 
    description: 'Cidade', 
    example: 'São Paulo',
    required: false
  })
  @VazioEhNulo()
  @IsOptional()
  @IsString({ message: 'Cidade deve ser uma string' })
  @Length(2, 100, { message: 'Cidade deve ter entre 2 e 100 caracteres' })
  cidade?: string | null;

  @ApiProperty({ 
    description: 'UF', 
    example: 'SP',
    required: false
  })
  @VazioEhNulo()
  @IsOptional()
  @IsString({ message: 'UF deve ser uma string' })
  @Length(2, 2, { message: 'UF deve ter exatamente 2 caracteres' })
  uf?: string | null;

  @ApiProperty({ 
    description: 'CEP', 
    example: '01234-567',
    required: false
  })
  @VazioEhNulo()
  @IsOptional()
  @IsString({ message: 'CEP deve ser uma string' })
  @Matches(/^\d{5}-\d{3}$/, {
    message: 'CEP deve estar no formato XXXXX-XXX'
  })
  cep?: string | null;
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
    example: '12.345.678/0001-90',
    required: false
  })
  @VazioEhNulo()
  @IsOptional()
  @IsString({ message: 'CNPJ/CPF deve ser uma string' })
  // Aceita CNPJ (14) ou CPF (11) — muitas fazendas estão no CPF do produtor.
  // Mascarado (XX.XXX.XXX/XXXX-XX ou XXX.XXX.XXX-XX) ou só dígitos (11/14).
  @Matches(/^(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11}|\d{14})$/, {
    message: 'Informe um CNPJ (14 dígitos) ou CPF (11 dígitos) válido'
  })
  cnpj?: string | null;

  @ApiProperty({ 
    description: 'ID do proprietário da planta', 
    example: 'usr_proprietario_123456789012345678',
    required: false
  })
  @VazioEhNulo()
  @IsOptional()
  @IsString({ message: 'ProprietarioId deve ser uma string' })
  proprietarioId?: string | null;

  @ApiProperty({ 
    description: 'Horário de funcionamento da planta', 
    example: '08:00 às 18:00',
    required: false
  })
  @VazioEhNulo()
  @IsOptional()
  @IsString({ message: 'Horário de funcionamento deve ser uma string' })
  @Length(5, 50, { message: 'Horário de funcionamento deve ter entre 5 e 50 caracteres' })
  horarioFuncionamento?: string | null;

  @ApiProperty({ 
    description: 'Localização específica da planta', 
    example: 'Zona Sul - Galpão 1',
    required: false
  })
  @VazioEhNulo()
  @IsOptional()
  @IsString({ message: 'Localização deve ser uma string' })
  @Length(5, 200, { message: 'Localização deve ter entre 5 e 200 caracteres' })
  localizacao?: string | null;

  @ApiProperty({ 
    description: 'Endereço completo da planta',
    type: EnderecoDto,
    required: false
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => EnderecoDto)
  endereco?: EnderecoDto;
}