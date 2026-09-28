import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class JanelaPivoDto {
  @ApiProperty()
  @IsBoolean()
  ativo!: boolean;

  @ApiProperty({ example: '18:00' })
  @IsString()
  @Matches(HHMM, { message: 'inicio deve ser HH:MM' })
  inicio!: string;

  @ApiProperty({ example: '21:00' })
  @IsString()
  @Matches(HHMM, { message: 'fim deve ser HH:MM' })
  fim!: string;

  @ApiProperty({ description: '1 = segunda … 7 = domingo', example: [1, 2, 3, 4, 5] })
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  dias!: number[];
}

/** PUT /pivos/:id/config — parcial: o que não vier fica como está. */
export class PivoConfigDto {
  @ApiPropertyOptional({ type: JanelaPivoDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => JanelaPivoDto)
  bloqueio_ponta?: JanelaPivoDto;

  @ApiPropertyOptional({ type: JanelaPivoDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => JanelaPivoDto)
  reservado?: JanelaPivoDto;

  @ApiPropertyOptional({ description: 'Motobomba que alimenta o pivô (sistema conjugado). null desfaz.' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(26)
  motobomba_equipamento_id?: string | null;
}

/** POST/PUT /pivos/:id/programacoes */
export class ProgramacaoPivoDto {
  @ApiProperty({ example: 'Irrigação noturna' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  nome!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  ativo?: boolean;

  @ApiProperty({ example: '22:00' })
  @IsString()
  @Matches(HHMM, { message: 'hora_inicio deve ser HH:MM' })
  hora_inicio!: string;

  @ApiProperty({ example: [1, 2, 3, 4, 5, 6, 7] })
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  dias!: number[];

  @ApiProperty({ enum: ['percurso', 'tempo'] })
  @IsIn(['percurso', 'tempo'])
  modo!: 'percurso' | 'tempo';

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(360)
  angulo_inicial?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(360)
  angulo_final?: number | null;

  @ApiPropertyOptional({ description: 'Obrigatório no modo tempo' })
  @ValidateIf((o) => o.modo === 'tempo' || (o.duracao_min !== undefined && o.duracao_min !== null))
  @IsInt()
  @Min(1)
  @Max(7 * 24 * 60)
  duracao_min?: number | null;

  @ApiProperty({ enum: ['horario', 'anti_horario'] })
  @IsIn(['horario', 'anti_horario'])
  sentido!: 'horario' | 'anti_horario';

  @ApiPropertyOptional({ description: '% (0–100)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  velocidade?: number | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  com_agua?: boolean;
}
