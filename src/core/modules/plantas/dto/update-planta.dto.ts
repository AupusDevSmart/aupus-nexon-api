// src/modules/plantas/dto/update-planta.dto.ts - CORRIGIDO
import { 
  IsOptional, 
  IsString, 
  Length, 
  IsNotEmpty, 
  ValidateNested,
  Matches
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

// ✅ NOVO: DTO específico para endereço parcial no update
export class UpdateEnderecoDto {
  @ApiPropertyOptional({ 
    description: 'Logradouro', 
    example: 'Av. Industrial, 1000'
  })
  @IsOptional()
  @IsString({ message: 'Logradouro deve ser uma string' })
  @Length(5, 200, { message: 'Logradouro deve ter entre 5 e 200 caracteres' })
  logradouro?: string;

  @ApiPropertyOptional({ 
    description: 'Bairro', 
    example: 'Centro'
  })
  @IsOptional()
  @IsString({ message: 'Bairro deve ser uma string' })
  @Length(2, 100, { message: 'Bairro deve ter entre 2 e 100 caracteres' })
  bairro?: string;

  @ApiPropertyOptional({ 
    description: 'Cidade', 
    example: 'São Paulo'
  })
  @IsOptional()
  @IsString({ message: 'Cidade deve ser uma string' })
  @Length(2, 100, { message: 'Cidade deve ter entre 2 e 100 caracteres' })
  cidade?: string;

  @ApiPropertyOptional({ 
    description: 'UF', 
    example: 'SP'
  })
  @IsOptional()
  @IsString({ message: 'UF deve ser uma string' })
  @Length(2, 2, { message: 'UF deve ter exatamente 2 caracteres' })
  uf?: string;

  @ApiPropertyOptional({ 
    description: 'CEP', 
    example: '01234-567'
  })
  @IsOptional()
  @IsString({ message: 'CEP deve ser uma string' })
  @Matches(/^\d{5}-\d{3}$/, {
    message: 'CEP deve estar no formato XXXXX-XXX'
  })
  cep?: string;
}

export class UpdatePlantaDto {
  @ApiPropertyOptional({
    description: 'Nome da planta',
    example: 'Planta Industrial São Paulo - Atualizada'
  })
  @IsOptional()
  @IsString({ message: 'Nome deve ser uma string' })
  @IsNotEmpty({ message: 'Nome não pode estar vazio' })
  @Length(2, 100, { message: 'Nome deve ter entre 2 e 100 caracteres' })
  nome?: string;

  @ApiPropertyOptional({
    description: 'Número da Unidade Consumidora',
    example: '123456789'
  })
  @IsOptional()
  @IsString({ message: 'Número UC deve ser uma string' })
  @Length(1, 255, { message: 'Número UC deve ter entre 1 e 255 caracteres' })
  numero_uc?: string;

  @ApiPropertyOptional({
    description: 'CNPJ da planta',
    example: '12.345.678/0001-90'
  })
  @IsOptional()
  @IsString({ message: 'CNPJ deve ser uma string' })
  @Matches(/^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/, {
    message: 'CNPJ deve estar no formato XX.XXX.XXX/XXXX-XX'
  })
  cnpj?: string;

  @ApiPropertyOptional({ 
    description: 'ID do proprietário da planta', 
    example: 'usr_proprietario_123456789012345678'
  })
  @IsOptional()
  @IsString({ message: 'ProprietarioId deve ser uma string' })
  @IsNotEmpty({ message: 'ProprietarioId não pode estar vazio' })
  proprietarioId?: string;

  @ApiPropertyOptional({ 
    description: 'Horário de funcionamento da planta', 
    example: '08:00 às 18:00'
  })
  @IsOptional()
  @IsString({ message: 'Horário de funcionamento deve ser uma string' })
  @Length(5, 50, { message: 'Horário de funcionamento deve ter entre 5 e 50 caracteres' })
  horarioFuncionamento?: string;

  @ApiPropertyOptional({ 
    description: 'Localização específica da planta', 
    example: 'Zona Sul - Galpão 2'
  })
  @IsOptional()
  @IsString({ message: 'Localização deve ser uma string' })
  @Length(5, 200, { message: 'Localização deve ter entre 5 e 200 caracteres' })
  localizacao?: string;

  @ApiPropertyOptional({ 
    description: 'Endereço completo da planta',
    type: UpdateEnderecoDto
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateEnderecoDto)
  endereco?: UpdateEnderecoDto;
}