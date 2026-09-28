import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** PATCH /usuarios/me */
export class AtualizarMeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  nome?: string;

  @ApiPropertyOptional({ description: 'Telefone/WhatsApp (até 20 caracteres)' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  telefone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail({}, { message: 'Email inválido' })
  @MaxLength(255)
  email?: string;
}

/** PUT /usuarios/me/notificacoes (parcial: campo ausente mantém o valor) */
export class PreferenciasNotificacaoDto {
  @IsOptional() @IsBoolean() alarmes_criticos?: boolean;
  @IsOptional() @IsBoolean() alarmes_atencao?: boolean;
  @IsOptional() @IsBoolean() comandos?: boolean;
  @IsOptional() @IsBoolean() resumo_diario?: boolean;
}

/** POST /usuarios/me/dispositivos */
export class RegistrarDispositivoPushDto {
  @ApiProperty({ enum: ['ios', 'android', 'web'] })
  @IsString()
  @IsIn(['ios', 'android', 'web'])
  plataforma: string;

  @ApiProperty({ description: 'Token APNs (hex) ou FCM' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  token: string;
}

// ============================================================================
// Operadores / convites
// ============================================================================

export class JanelaComandoDto {
  @ApiProperty({ example: '06:00' })
  @IsString()
  @Matches(HHMM, { message: 'inicio deve ser HH:MM' })
  inicio: string;

  @ApiProperty({ example: '18:00' })
  @IsString()
  @Matches(HHMM, { message: 'fim deve ser HH:MM' })
  fim: string;

  @ApiProperty({ description: '1 = segunda … 7 = domingo', example: [1, 2, 3, 4, 5] })
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  dias: number[];
}

export class PermissoesUnidadeDto {
  @IsOptional() @IsBoolean() visualizar?: boolean;
  @IsBoolean() comandar: boolean;
  @IsBoolean() relatorios: boolean;
}

export class ExcecaoUnidadeDto {
  @IsString()
  @IsNotEmpty()
  unidade_id: string;

  @IsBoolean() comandar: boolean;
  @IsBoolean() relatorios: boolean;
}

/** PUT /usuarios/:id/acesso — também é o miolo do convite. */
export class AcessoOperadorDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1, { message: 'Selecione ao menos uma instalação' })
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsString({ each: true })
  unidade_ids: string[];

  @ApiProperty({ type: PermissoesUnidadeDto })
  @ValidateNested()
  @Type(() => PermissoesUnidadeDto)
  permissoes: PermissoesUnidadeDto;

  @ApiPropertyOptional({ type: [ExcecaoUnidadeDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ExcecaoUnidadeDto)
  excecoes?: ExcecaoUnidadeDto[];

  @ApiPropertyOptional({ type: JanelaComandoDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => JanelaComandoDto)
  janela?: JanelaComandoDto | null;
}

/** POST /usuarios/convites */
export class CriarConviteDto extends AcessoOperadorDto {
  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  nome: string;

  @ApiProperty()
  @IsEmail({}, { message: 'Email inválido' })
  @MaxLength(255)
  email: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  telefone?: string;

  @ApiPropertyOptional({ enum: ['email', 'whatsapp'], isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(['email', 'whatsapp'], { each: true })
  canais?: string[];

  @ApiPropertyOptional({ default: 7 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  validade_dias?: number;
}
