import { PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { DISPOSITIVOS, MODOS_ARMAMENTO, TIPOS_DETECCAO, type Dispositivo, type ModoArmamento } from '../cameras-regras';

/**
 * Flag de query (`?somente_nao_lidos=1`). Lê o valor cru: com enableImplicitConversion o
 * class-transformer faria Boolean('0') === true.
 */
const Flag = () =>
  Transform(({ obj, key }) => {
    const v = obj?.[key];
    return v === true || v === 1 || v === '1' || v === 'true';
  });

export class ListarCamerasDto {
  @IsString()
  @IsNotEmpty()
  unidade_id!: string;
}

export class AnaliseDto {
  @IsOptional()
  @IsBoolean()
  ativa?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  sensibilidade?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  area_minima_pct?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(30)
  fps_analise?: number;

  @IsOptional()
  @IsBoolean()
  classificar?: boolean;

  @IsOptional()
  @IsArray()
  @IsIn(TIPOS_DETECCAO, { each: true })
  classes_alerta?: string[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(120)
  clipe_s?: number;

  /** Polígonos normalizados (0–1); o agente interpreta. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  zonas?: unknown[];
}

export class StreamDto {
  @IsOptional()
  @IsBoolean()
  continuo?: boolean;

  @IsOptional()
  @IsBoolean()
  transcodificar?: boolean;

  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(8000)
  bitrate_kbps?: number;
}

export class CriarCameraDto {
  @IsString()
  @IsNotEmpty()
  unidade_id!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  nome!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  ip!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  usuario!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  senha!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  porta_rtsp?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  porta_http?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(64)
  canal?: number;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  fabricante?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  modelo?: string;

  /** null desvincula. */
  @IsOptional()
  @IsString()
  @MaxLength(26)
  agente_id?: string | null;

  /** Equipamento CFTV (abre chamado e cai na tela de alarmes). null desvincula. */
  @IsOptional()
  @IsString()
  @MaxLength(26)
  equipamento_id?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => StreamDto)
  stream?: StreamDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => AnaliseDto)
  analise?: AnaliseDto;

  @IsOptional()
  @IsInt()
  @Min(0)
  ordem?: number;

  @IsOptional()
  @IsBoolean()
  ativa?: boolean;
}

export class EditarCameraDto extends PartialType(CriarCameraDto) {}

export class ArmarDto {
  @IsBoolean()
  armado!: boolean;

  /** Até quando vale o armamento manual (ISO). Sem valor: ver cameras-regras.decidirArmar. */
  @IsOptional()
  @IsISO8601()
  ate?: string;
}

export class AcionarDto {
  @IsIn(DISPOSITIVOS)
  dispositivo!: Dispositivo;
}

export class AgendaDto {
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'inicio deve ser HH:MM' })
  inicio!: string;

  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'fim deve ser HH:MM' })
  fim!: string;
}

export class ArmamentoDto {
  @IsIn(MODOS_ARMAMENTO)
  modo!: ModoArmamento;

  @IsOptional()
  @IsBoolean()
  armado_manual?: boolean;

  @IsOptional()
  @IsISO8601()
  armado_manual_ate?: string | null;

  /** null = sem agenda (volta ao padrão 18:00–06:30 quando o modo é agenda). */
  @IsOptional()
  @ValidateNested()
  @Type(() => AgendaDto)
  agenda?: AgendaDto | null;
}

export class PontoComandoDto {
  @IsString()
  @IsNotEmpty()
  equipamento_id!: string;

  @IsString()
  @IsNotEmpty()
  ponto_id!: string;
}

export class ConfigUnidadeDto {
  @ValidateNested()
  @Type(() => ArmamentoDto)
  armamento!: ArmamentoDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => PontoComandoDto)
  refletor?: PontoComandoDto | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => PontoComandoDto)
  sirene?: PontoComandoDto | null;

  @IsOptional()
  @IsBoolean()
  abrir_chamado?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsEmail({}, { each: true })
  notificar_emails?: string[];
}

export class ListarEventosDto {
  @IsOptional()
  @IsString()
  unidade_id?: string;

  @IsOptional()
  @IsString()
  camera_id?: string;

  /** AAAA-MM-DD em America/Sao_Paulo. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dia deve ser AAAA-MM-DD' })
  dia?: string;

  /** Lista separada por vírgula; `sistema` = sem_sinal,sinal_restabelecido. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  tipo?: string;

  @IsOptional()
  @Flag()
  @IsBoolean()
  somente_nao_lidos?: boolean;

  @IsOptional()
  @Flag()
  @IsBoolean()
  incluir_descartados?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class MarcarLidosDto {
  @IsString()
  @IsNotEmpty()
  unidade_id!: string;

  @IsOptional()
  @IsString()
  camera_id?: string;
}

export class ListarAgentesDto {
  @IsString()
  @IsNotEmpty()
  unidade_id!: string;
}

export class CriarAgenteDto {
  @IsString()
  @IsNotEmpty()
  unidade_id!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  nome!: string;
}
