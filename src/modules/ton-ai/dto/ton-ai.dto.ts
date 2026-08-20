import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

export const AI_MIN = 1;
// Teto SINTATICO. O teto real por modelo e validado no service via
// tonAiCount(tipo_equipamento) (hoje 2 pra todos: AN1/AN2).
export const AI_MAX = 4;

export class CreateTonAiDto {
  @ApiProperty({
    description:
      'Numero do AI (canal analogico) no hardware da TON. v1 tem AN1/AN2 ' +
      '(IO6/7, com ADC nativo). O maximo real do modelo e validado no service.',
    minimum: AI_MIN,
    maximum: AI_MAX,
    example: 1,
  })
  @IsInt()
  @Min(AI_MIN)
  @Max(AI_MAX)
  ai_numero!: number;

  @ApiPropertyOptional({
    description:
      'FK do ponto do tipo "medicao" que esse AI alimenta. NULL ou ausente ' +
      'mantem o AI sem mapeamento (configuravel depois sem precisar deletar).',
    example: 'cmoj2wbqc00b7jqcduxgw1ueh',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @Length(20, 26)
  equipamento_ponto_id?: string | null;

  @ApiPropertyOptional({
    description:
      'mV que equivale a 0% (offset). Ratiometrico simples = 0. Para 4-20mA com ' +
      'shunt, use os mV lidos em 4mA. Default 0.',
    default: 0,
    example: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(30000)
  mv_0?: number;

  @ApiPropertyOptional({
    description:
      'mV que equivale a 100% (fundo de escala). Default 3000. Escala linear: ' +
      'pct = (mv - mv_0) / (mv_100 - mv_0) * 100.',
    default: 3000,
    example: 3000,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30000)
  mv_100?: number;

  @ApiPropertyOptional({
    description: 'Se desativado, o AI nao e usado.',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  ativo?: boolean;
}

export class UpdateTonAiDto extends PartialType(CreateTonAiDto) {}

export class TonAiResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() ton_id!: string;
  @ApiProperty({ minimum: AI_MIN, maximum: AI_MAX }) ai_numero!: number;
  @ApiProperty({ nullable: true }) equipamento_ponto_id!: string | null;
  @ApiProperty() mv_0!: number;
  @ApiProperty() mv_100!: number;
  @ApiProperty() ativo!: boolean;
  @ApiProperty() created_at!: Date;
  @ApiProperty() updated_at!: Date;

  /// Dados do ponto destino — populado nas listagens pra evitar n+1 no frontend.
  @ApiPropertyOptional({
    description: 'Resumo do ponto mapeado (NULL se AI nao mapeado).',
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
