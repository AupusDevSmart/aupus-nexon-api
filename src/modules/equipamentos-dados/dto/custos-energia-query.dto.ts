import { IsEnum, IsDateString, IsOptional, IsISO8601, ValidateIf } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export enum PeriodoTipo {
  DIA = 'dia',
  MES = 'mes',
  CUSTOM = 'custom', // ✅ NOVO: período customizado com timestamps
}

export class CustosEnergiaQueryDto {
  @ApiProperty({
    description: 'Tipo de período (dia, mes ou custom)',
    enum: PeriodoTipo,
    example: 'mes',
    required: false,
  })
  @IsOptional()
  @IsEnum(PeriodoTipo)
  periodo?: PeriodoTipo;

  @ApiProperty({
    description: 'Data de referência (YYYY-MM-DD) - usado com periodo=dia ou periodo=mes',
    example: '2025-11-01',
    required: false,
  })
  @IsOptional()
  @IsDateString()
  data?: string;

  @ApiProperty({
    description: 'Timestamp de início (ISO 8601) - usado com periodo=custom',
    example: '2025-11-01T00:00:00Z',
    required: false,
  })
  @IsOptional()
  @IsISO8601()
  @ValidateIf((o) => o.periodo === PeriodoTipo.CUSTOM || o.timestamp_fim)
  timestamp_inicio?: string;

  @ApiProperty({
    description: 'Timestamp de fim (ISO 8601) - usado com periodo=custom',
    example: '2025-11-30T23:59:59Z',
    required: false,
  })
  @IsOptional()
  @IsISO8601()
  @ValidateIf((o) => o.periodo === PeriodoTipo.CUSTOM || o.timestamp_inicio)
  timestamp_fim?: string;
}
