import { IsString, IsOptional, IsNotEmpty, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum ClassificacaoEquipamento {
  UC = 'UC',
  UAR = 'UAR'
}

/**
 * DTO para criação rápida de equipamentos no diagrama
 * Contém apenas campos essenciais - demais dados podem ser preenchidos depois
 */
export class CreateEquipamentoRapidoDto {
  @ApiProperty({
    example: 'cmhcg1w27000ejqo84gbjeyty',
    description: 'ID da unidade onde o equipamento será criado'
  })
  @IsString()
  @IsNotEmpty()
  unidade_id: string;

  @ApiProperty({
    example: '01JAQTE1MOTOR000000000017',
    description: 'ID do tipo de equipamento (ex: MEDIDOR, TRANSFORMADOR, MOTOR)'
  })
  @IsString()
  @IsNotEmpty()
  tipo_equipamento_id: string;

  @ApiPropertyOptional({
    example: 'Medidor Principal',
    description: 'Nome do equipamento. Se não fornecido, será gerado automaticamente (ex: "Medidor 1")'
  })
  @IsOptional()
  @IsString()
  nome?: string;

  @ApiPropertyOptional({
    example: 'MED-001',
    description: 'TAG de identificação do equipamento'
  })
  @IsOptional()
  @IsString()
  tag?: string;

  @ApiPropertyOptional({
    enum: ClassificacaoEquipamento,
    example: 'UC',
    description: 'Classificação do equipamento (UC = Unidade Consumidora, UAR = Unidade de Abastecimento)',
    default: 'UC'
  })
  @IsOptional()
  @IsEnum(ClassificacaoEquipamento)
  classificacao?: ClassificacaoEquipamento;
}
