import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsDateString,
  IsOptional,
  IsNumber,
  IsPositive,
  Length,
  MaxLength,
  Matches,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

export class TarifasA4VerdeDto {
  @ApiProperty({ description: 'TUSD Demanda', required: false, example: 0.123456 })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  tusd_d?: number;

  @ApiProperty({ description: 'TUSD Ponta', required: false, example: 0.654321 })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  tusd_p?: number;

  @ApiProperty({ description: 'TUSD Fora Ponta', required: false, example: 0.234567 })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  tusd_fp?: number;

  @ApiProperty({ description: 'TE Demanda', required: false, example: 0.345678 })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  te_d?: number;

  @ApiProperty({ description: 'TE Ponta', required: false, example: 0.456789 })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  te_p?: number;

  @ApiProperty({ description: 'TE Fora Ponta', required: false, example: 0.567890 })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  te_fp?: number;
}

export class TarifasA3aVerdeDto {
  @ApiProperty({ description: 'TUSD Demanda', required: false, example: 0.123456 })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  tusd_d?: number;

  @ApiProperty({ description: 'TUSD Ponta', required: false, example: 0.654321 })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  tusd_p?: number;

  @ApiProperty({ description: 'TUSD Fora Ponta', required: false, example: 0.234567 })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  tusd_fp?: number;

  @ApiProperty({ description: 'TE Demanda', required: false, example: 0.345678 })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  te_d?: number;

  @ApiProperty({ description: 'TE Ponta', required: false, example: 0.456789 })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  te_p?: number;

  @ApiProperty({ description: 'TE Fora Ponta', required: false, example: 0.567890 })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  te_fp?: number;
}

export class TarifasBDto {
  @ApiProperty({ description: 'TUSD Valor', required: false, example: 0.543210 })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  tusd_valor?: number;

  @ApiProperty({ description: 'TE Valor', required: false, example: 0.432109 })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  te_valor?: number;
}

export class CreateConcessionariaDto {
  @ApiProperty({
    description: 'Nome da concessionária',
    example: 'CPFL Paulista',
  })
  @IsString()
  @IsNotEmpty()
  nome: string;

  @ApiProperty({
    description: 'Sigla do estado (2 caracteres)',
    example: 'SP',
    minLength: 2,
    maxLength: 2,
  })
  @IsString()
  @Length(2, 2)
  @Matches(/^[A-Z]{2}$/, { message: 'Estado deve ser uma sigla válida de 2 letras maiúsculas' })
  estado: string;

  @ApiProperty({
    description: 'Numero da Resolucao Homologatoria (REH) da ANEEL',
    example: '3.166/2024',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  numero_reh?: string;

  @ApiProperty({
    description: 'Data de início da vigência das tarifas',
    example: '2025-01-01',
  })
  @IsDateString()
  data_inicio: string;

  @ApiProperty({
    description: 'Data de validade das tarifas',
    example: '2025-12-31',
  })
  @IsDateString()
  data_validade: string;

  @ApiProperty({
    description: 'Tarifas para o subgrupo A4 Verde',
    type: TarifasA4VerdeDto,
    required: false,
  })
  @IsOptional()
  a4_verde?: TarifasA4VerdeDto;

  @ApiProperty({
    description: 'Tarifas para o subgrupo A3a Verde',
    type: TarifasA3aVerdeDto,
    required: false,
  })
  @IsOptional()
  a3a_verde?: TarifasA3aVerdeDto;

  @ApiProperty({
    description: 'Tarifas para o grupo B',
    type: TarifasBDto,
    required: false,
  })
  @IsOptional()
  b?: TarifasBDto;

  // ============== Horarios dos postos tarifarios ==============
  // Definidos pela concessionaria (regulatorio). Defaults conservadores:
  // Ponta 18-21, Reservado 21:30-06:00 (manter comportamento historico).

  // Todos os horarios sao decimais (18 = 18:00, 21.5 = 21:30).
  // Frontend converte HH:MM <-> decimal antes/depois de mandar.

  @ApiProperty({
    description: 'Hora de inicio do posto Ponta (decimal, ex: 18 = 18:00). Default: 18',
    required: false,
    minimum: 0,
    maximum: 24,
    example: 18,
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(0)
  @Max(24)
  hora_inicio_ponta?: number;

  @ApiProperty({
    description: 'Hora de fim do posto Ponta (decimal). Default: 21',
    required: false,
    minimum: 0,
    maximum: 24,
    example: 21,
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(0)
  @Max(24)
  hora_fim_ponta?: number;

  @ApiProperty({
    description: 'Hora de inicio do posto Reservado (decimal, ex: 21.5 = 21:30). Default: 21.5',
    required: false,
    minimum: 0,
    maximum: 24,
    example: 21.5,
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(0)
  @Max(24)
  hora_inicio_reservado?: number;

  @ApiProperty({
    description: 'Hora de fim do posto Reservado (decimal). Default: 6',
    required: false,
    minimum: 0,
    maximum: 24,
    example: 6,
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(0)
  @Max(24)
  hora_fim_reservado?: number;
}
