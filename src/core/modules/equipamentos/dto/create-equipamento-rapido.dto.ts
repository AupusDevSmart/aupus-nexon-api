import { IsString, IsOptional, IsNotEmpty, IsEnum, IsBoolean, IsArray } from 'class-validator';
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

  // --- Cadastro simplificado do unifilar (Fase 7) ---
  @ApiPropertyOptional({ description: 'Localização específica (ex.: Painel A)' })
  @IsOptional()
  @IsString()
  localizacao_especifica?: string;

  @ApiPropertyOptional({ description: 'Possui medição (monitoramento). Tipo pm/ied vem da associação no IoT.' })
  @IsOptional()
  @IsBoolean()
  possui_medicao?: boolean;

  @ApiPropertyOptional({ description: 'Possui SCS (automação): habilita comando/status' })
  @IsOptional()
  @IsBoolean()
  possui_scs?: boolean;

  @ApiPropertyOptional({ description: 'SCS com comando (abrir/fechar/ligar/desligar)' })
  @IsOptional()
  @IsBoolean()
  scs_comando?: boolean;

  @ApiPropertyOptional({ description: 'SCS com status (aberto/fechado etc.)' })
  @IsOptional()
  @IsBoolean()
  scs_status?: boolean;

  @ApiPropertyOptional({ description: 'Pontos de comando escolhidos (rótulos), ex.: ["Abrir","Fechar"]' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pontos_comando?: string[];

  @ApiPropertyOptional({ description: 'Pontos de status escolhidos (rótulos), ex.: ["Aberto","Fechado"]' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pontos_status?: string[];
}
