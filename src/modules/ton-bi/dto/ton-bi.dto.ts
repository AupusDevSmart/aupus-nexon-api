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

export const BI_MIN = 1;
// Teto SINTATICO (maior modelo = TON-V2 com 8). O teto real por modelo
// (v1=6, v2=8) e validado no service via tonBiCount(tipo_equipamento).
export const BI_MAX = 8;

export class CreateTonBiDto {
  @ApiProperty({
    description:
      'Numero do BI no hardware da TON. bi_numero = entrada digital dN ' +
      '(optoacoplada). Modelos v1 tem 6 entradas (d1..d6); TON-V2 tem 8 ' +
      '(d1..d8) — o maximo real do modelo e validado no service.',
    minimum: BI_MIN,
    maximum: BI_MAX,
    example: 1,
  })
  @IsInt()
  @Min(BI_MIN)
  @Max(BI_MAX)
  bi_numero!: number;

  @ApiPropertyOptional({
    description:
      'FK do ponto do tipo "status" que esse BI representa. NULL ou ausente ' +
      'mantem o BI sem mapeamento (configuravel depois sem precisar deletar).',
    example: 'cmoj2wbqc00b7jqcduxgw1ueh',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @Length(20, 26)
  equipamento_ponto_id?: string | null;

  @ApiPropertyOptional({
    description:
      'Contato Normalmente Fechado (NF): inverte o estado lido (0<->1) antes ' +
      'de exibir. Default false (NA — contato Normalmente Aberto).',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  invertido?: boolean;

  @ApiPropertyOptional({
    description: 'Se desativado, o BI nao aparece no supervisorio.',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  ativo?: boolean;
}

export class UpdateTonBiDto extends PartialType(CreateTonBiDto) {}

export class TonBiResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() ton_id!: string;
  @ApiProperty({ minimum: BI_MIN, maximum: BI_MAX }) bi_numero!: number;
  @ApiProperty({ nullable: true }) equipamento_ponto_id!: string | null;
  @ApiProperty() invertido!: boolean;
  @ApiProperty() ativo!: boolean;
  @ApiProperty() created_at!: Date;
  @ApiProperty() updated_at!: Date;

  /// Dados do ponto destino — populado nas listagens pra evitar n+1 no frontend.
  @ApiPropertyOptional({
    description: 'Resumo do ponto mapeado (NULL se BI nao mapeado).',
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

/**
 * Estado atual de um BI: mapeamento + valor lido do hardware.
 * Usado pelo supervisorio pra exibir liga/desliga.
 */
export class TonBiEstadoDto {
  @ApiProperty({ minimum: BI_MIN, maximum: BI_MAX }) bi_numero!: number;

  @ApiProperty({
    nullable: true,
    description: 'Estado exibido (0/1) ja com inversao aplicada. NULL se sem leitura.',
  })
  valor!: number | null;

  @ApiProperty({
    nullable: true,
    description: 'Estado cru lido do hardware (0/1), antes da inversao.',
  })
  valor_raw!: number | null;

  @ApiProperty() invertido!: boolean;
  @ApiProperty() ativo!: boolean;

  @ApiProperty({ nullable: true, description: 'Nome do ponto mapeado (NULL se nao mapeado).' })
  nome!: string | null;

  @ApiProperty({ nullable: true }) equipamento_ponto_id!: string | null;

  @ApiProperty({ nullable: true, description: 'Quando o estado foi lido pela ultima vez.' })
  updated_at!: Date | null;
}
