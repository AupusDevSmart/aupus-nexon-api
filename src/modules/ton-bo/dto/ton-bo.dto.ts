import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';

export const BO_MIN = 1;
// Teto SINTATICO (maior modelo = TON-V2 com 8). O teto real por modelo
// (v1=6, ton3v2/ton4v2=8, ton1v2/ton2v2=0) e validado no service via tonBoMax.
export const BO_MAX = 8;
export const PULSO_MS_MIN = 50;
export const PULSO_MS_MAX = 60_000;
export const PULSO_MS_DEFAULT = 500;

export class CreateTonBoDto {
  @ApiProperty({
    description:
      'Numero do BO no hardware da TON. bo_numero = rele fisico RN. ' +
      'TON3/TON4 tem 6 reles; TON3v2/TON4v2 tem 8; modelos sem rele rejeitam ' +
      'com 400 (o maximo real do modelo e validado no service).',
    minimum: BO_MIN,
    maximum: BO_MAX,
    example: 1,
  })
  @IsInt()
  @Min(BO_MIN)
  @Max(BO_MAX)
  bo_numero!: number;

  @ApiPropertyOptional({
    description:
      'FK do ponto do tipo "comando" que esse BO dispara. NULL ou ausente ' +
      'mantem o BO sem mapeamento (configuravel depois sem precisar deletar).',
    example: 'cmoj2wbqc00b7jqcduxgw1ueh',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @Length(20, 26)
  equipamento_ponto_id?: string | null;

  @ApiPropertyOptional({
    description: `Duracao do pulso em ms (r_N on -> wait -> r_N off). Range [${PULSO_MS_MIN}, ${PULSO_MS_MAX}].`,
    minimum: PULSO_MS_MIN,
    maximum: PULSO_MS_MAX,
    default: PULSO_MS_DEFAULT,
    example: PULSO_MS_DEFAULT,
  })
  @IsOptional()
  @IsInt()
  @Min(PULSO_MS_MIN)
  @Max(PULSO_MS_MAX)
  pulso_ms?: number;

  @ApiPropertyOptional({
    description: 'Se desativado, o BO nao executa pulso nem aparece no Unifilar.',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  ativo?: boolean;
}

export class UpdateTonBoDto extends PartialType(CreateTonBoDto) {}

export class TonBoResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() ton_id!: string;
  @ApiProperty({ minimum: BO_MIN, maximum: BO_MAX }) bo_numero!: number;
  @ApiProperty({ nullable: true }) equipamento_ponto_id!: string | null;
  @ApiProperty() pulso_ms!: number;
  @ApiProperty() ativo!: boolean;
  @ApiProperty() created_at!: Date;
  @ApiProperty() updated_at!: Date;

  /// Dados do ponto destino — populado nas listagens pra evitar n+1 no frontend.
  @ApiPropertyOptional({
    description: 'Resumo do ponto mapeado (NULL se BO nao mapeado).',
    nullable: true,
  })
  ponto?: {
    id: string;
    tipo: string;
    nome: string;
    equipamento_id: string;
    equipamento_nome: string;
  } | null;
}
