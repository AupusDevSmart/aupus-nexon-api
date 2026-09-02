import {
  IsString,
  IsOptional,
  IsNotEmpty,
  IsArray,
  ValidateNested,
  ArrayMinSize,
  ArrayMaxSize,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { CreateEquipamentoDto } from './create-equipamento.dto';

/**
 * Teto do lote. Não é limitação técnica e sim de prudência: a criação inteira
 * corre numa transação só, e segurar uma transação com centenas de inserções
 * bloqueia a tabela por tempo demais num banco que é compartilhado.
 */
export const LIMITE_ITENS_DO_LOTE = 50;

/**
 * O que muda de um equipamento para o outro dentro do lote.
 *
 * Tudo o mais — categoria, modelo, unidade, criticidade, dados técnicos, foto —
 * vem do bloco comum e é replicado igual para todos.
 */
export class ItemDoLoteDto {
  @ApiProperty({ example: 'Inversor 01' })
  @IsString()
  @IsNotEmpty({ message: 'Cada equipamento do lote precisa de um nome' })
  @MaxLength(255)
  nome: string;

  @ApiPropertyOptional({ example: 'INV-UFV1-01' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  tag?: string;

  @ApiPropertyOptional({ example: 'SN-2026-0001' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  numero_serie?: string;

  @ApiPropertyOptional({ example: 'Sala de inversores, posição 3' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  localizacao_especifica?: string;
}

/**
 * Cadastro de vários equipamentos iguais de uma vez.
 *
 * Herda o bloco comum de CreateEquipamentoDto sem os campos que passam a ser
 * por item — assim as validações do cadastro normal continuam valendo aqui sem
 * duplicação, e um campo novo lá aparece aqui de graça.
 *
 * O plano de manutenção não entra: ele é vinculado por equipamento, depois.
 */
export class CreateEquipamentosLoteDto extends OmitType(CreateEquipamentoDto, [
  'nome',
  'tag',
  'numero_serie',
  'localizacao_especifica',
] as const) {
  @ApiProperty({
    type: [ItemDoLoteDto],
    description: `Um item por equipamento a criar (no máximo ${LIMITE_ITENS_DO_LOTE}).`,
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'Informe ao menos um equipamento' })
  @ArrayMaxSize(LIMITE_ITENS_DO_LOTE, {
    message: `No máximo ${LIMITE_ITENS_DO_LOTE} equipamentos por lote`,
  })
  @ValidateNested({ each: true })
  @Type(() => ItemDoLoteDto)
  itens: ItemDoLoteDto[];
}
