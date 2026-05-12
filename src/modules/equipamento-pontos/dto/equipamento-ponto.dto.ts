import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export const PONTO_TIPOS = ['comando', 'status', 'medicao'] as const;
export type PontoTipo = (typeof PONTO_TIPOS)[number];

export class CreateEquipamentoPontoDto {
  @ApiProperty({
    description: 'Tipo do ponto: comando, status ou medicao',
    enum: PONTO_TIPOS,
    example: 'comando',
  })
  @IsIn(PONTO_TIPOS as unknown as string[])
  tipo!: PontoTipo;

  @ApiProperty({
    description:
      'Nome do ponto, unico por equipamento. Texto livre — sugestoes ' +
      'comuns: abrir, fechar (comando); posicao, alarme (status); ' +
      'corrente_a, tensao_v, potencia_kw (medicao).',
    example: 'abrir',
    maxLength: 100,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  nome!: string;

  @ApiPropertyOptional({
    description:
      'Unidade de medida — preenchido para tipo=medicao (A, V, kW, kWh, etc.). ' +
      'Ignorado para comando/status.',
    example: 'A',
    maxLength: 20,
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  unidade?: string;

  @ApiPropertyOptional({
    description: 'Ordem de exibicao no modal do equipamento (asc).',
    default: 0,
    example: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  ordem?: number;

  @ApiPropertyOptional({
    description: 'Se desativado, o ponto deixa de aparecer no Unifilar.',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  ativo?: boolean;
}

export class UpdateEquipamentoPontoDto extends PartialType(
  CreateEquipamentoPontoDto,
) {}

export class EquipamentoPontoResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() equipamento_id!: string;
  @ApiProperty({ enum: PONTO_TIPOS }) tipo!: PontoTipo;
  @ApiProperty() nome!: string;
  @ApiProperty({ nullable: true }) unidade!: string | null;
  @ApiProperty() ordem!: number;
  @ApiProperty() ativo!: boolean;
  @ApiProperty() created_at!: Date;
  @ApiProperty() updated_at!: Date;
}
