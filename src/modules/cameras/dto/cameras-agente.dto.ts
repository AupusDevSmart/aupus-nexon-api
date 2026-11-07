import { Type } from 'class-transformer';
import {
  Allow,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { TIPOS_EVENTO, type TipoEvento } from '../cameras-regras';

export class HeartbeatCameraDto {
  @IsString()
  @IsNotEmpty()
  id!: string;

  @IsBoolean()
  online!: boolean;

  @IsOptional()
  @IsNumber()
  fps?: number;

  @IsOptional()
  @IsBoolean()
  publicando?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  erro?: string;
}

export class HeartbeatDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  versao?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  host?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HeartbeatCameraDto)
  cameras!: HeartbeatCameraDto[];
}

/** multipart: campo camera_id + arquivo `arquivo` (JPEG). */
export class MiniaturaDto {
  @IsString()
  @IsNotEmpty()
  camera_id!: string;
}

/** multipart: campos texto + arquivo `snapshot` (JPEG, opcional). */
export class EventoAgenteDto {
  @IsString()
  @IsNotEmpty()
  camera_id!: string;

  @IsIn(TIPOS_EVENTO)
  tipo!: TipoEvento;

  @IsISO8601()
  inicio_em!: string;

  @IsOptional()
  @IsISO8601()
  fim_em?: string;

  /** No multipart chega como texto decimal ("0.8700"). */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  confianca?: number;

  /** No multipart chega como string JSON; objeto no JSON. Interpretado no service. */
  @IsOptional()
  @Allow()
  dados?: unknown;
}

export class FimEventoDto {
  @IsISO8601()
  fim_em!: string;

  /** Merge raso no jsonb `dados` do evento (duracao_s, quadros...). */
  @IsOptional()
  @IsObject()
  dados?: Record<string, unknown>;
}

export class ResultadoComandoDto {
  @IsBoolean()
  ok!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  erro?: string;

  @IsOptional()
  @IsString()
  evento_id?: string;
}
