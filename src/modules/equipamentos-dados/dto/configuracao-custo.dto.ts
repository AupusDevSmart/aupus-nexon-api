import { IsBoolean, IsNumber, IsOptional, Min, Max, ValidateIf } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type, Transform } from 'class-transformer';

export class UpsertConfiguracaoCustoDto {
  @ApiProperty({ description: 'Aliquota ICMS (decimal: 0.18 = 18%)', required: false })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(0)
  @Max(1)
  icms?: number;

  @ApiProperty({ description: 'Aliquota PIS (decimal: 0.0165 = 1.65%)', required: false })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(0)
  @Max(1)
  pis?: number;

  @ApiProperty({ description: 'Aliquota COFINS (decimal: 0.076 = 7.6%)', required: false })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(0)
  @Max(1)
  cofins?: number;

  @ApiProperty({ description: 'Percentual de perdas na rede (0 a 100)', required: false })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(0)
  @Max(100)
  perdas?: number;

  @ApiProperty({ description: 'Usar tarifa personalizada ao inves da concessionaria', required: false })
  @IsOptional()
  @IsBoolean()
  usa_tarifa_personalizada?: boolean;

  // Grupo A
  @ApiProperty({ required: false })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Transform(({ value }) => (value === null ? null : Number(value)))
  tusd_p?: number | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Transform(({ value }) => (value === null ? null : Number(value)))
  te_p?: number | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Transform(({ value }) => (value === null ? null : Number(value)))
  tusd_fp?: number | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Transform(({ value }) => (value === null ? null : Number(value)))
  te_fp?: number | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Transform(({ value }) => (value === null ? null : Number(value)))
  tusd_d?: number | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Transform(({ value }) => (value === null ? null : Number(value)))
  te_d?: number | null;

  // Grupo B
  @ApiProperty({ required: false })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Transform(({ value }) => (value === null ? null : Number(value)))
  tusd_b?: number | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Transform(({ value }) => (value === null ? null : Number(value)))
  te_b?: number | null;
}
