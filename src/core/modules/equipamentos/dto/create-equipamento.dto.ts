import { IsString, IsOptional, IsNotEmpty, IsEnum, IsInt, IsBoolean, IsDateString, IsArray, ValidateNested } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type, Transform } from 'class-transformer';

export enum ClassificacaoEquipamento {
  UC = 'UC',
  UAR = 'UAR'
}

export enum CriticidadeEquipamento {
  MUITO_BAIXA = '1',
  BAIXA = '2',
  MEDIA = '3',
  ALTA = '4',
  MUITO_ALTA = '5'
}

export class DadoTecnicoDto {
  @ApiProperty({ example: 'potencia' })
  @IsString()
  @IsNotEmpty()
  campo: string;

  @ApiProperty({ example: '15' })
  @IsString()
  valor: string;

  @ApiProperty({ example: 'number' })
  @IsString()
  tipo: string;

  @ApiPropertyOptional({ example: 'kW' })
  @IsOptional()
  @IsString()
  unidade?: string;
}

/**
 * Ponto de automacao por equipamento (PR3).
 * - tipo: 'comando' | 'status' | 'medicao'
 * - id opcional: enviado em UPDATE pra sync seletivo (preserva FK em ton_bo).
 *   No CREATE, ignorado — todos os pontos sao gerados novos.
 */
export class EquipamentoPontoDto {
  @ApiPropertyOptional({
    description: 'ID existente (apenas em UPDATE). Omitir cria novo ponto.',
    example: 'cmoj2wbqc00b7jqcduxgw1ueh',
  })
  @IsOptional()
  @IsString()
  id?: string;

  @ApiProperty({ enum: ['comando', 'status', 'medicao'], example: 'comando' })
  @IsString()
  @IsEnum(['comando', 'status', 'medicao'])
  tipo: 'comando' | 'status' | 'medicao';

  @ApiProperty({ example: 'abrir' })
  @IsString()
  @IsNotEmpty()
  nome: string;

  @ApiPropertyOptional({ example: 'A' })
  @IsOptional()
  @IsString()
  unidade?: string;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsInt()
  ordem?: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  ativo?: boolean;
}

export class CreateEquipamentoDto {
  @ApiProperty({ example: 'Motor Elétrico Principal' })
  @IsString()
  @IsNotEmpty()
  nome: string;

  @ApiProperty({ enum: ClassificacaoEquipamento, example: 'UC' })
  @IsEnum(ClassificacaoEquipamento)
  classificacao: ClassificacaoEquipamento;

  @ApiPropertyOptional({ example: 'uni_01234567890123456789012345' })
  @IsOptional()
  @IsString()
  unidade_id?: string;

  @ApiPropertyOptional({ example: 'eqp_01234567890123456789012345' })
  @IsOptional()
  @IsString()
  equipamento_pai_id?: string;

  @ApiPropertyOptional({ example: 'WEG' })
  @IsOptional()
  @IsString()
  fabricante?: string;

  @ApiPropertyOptional({ example: 'W22-15HP' })
  @IsOptional()
  @IsString()
  modelo?: string;

  @ApiPropertyOptional({ example: 'WEG2024001' })
  @IsOptional()
  @IsString()
  numero_serie?: string;

  @ApiProperty({ enum: CriticidadeEquipamento, example: '3' })
  @IsEnum(CriticidadeEquipamento)
  criticidade: CriticidadeEquipamento;

  @ApiPropertyOptional({ example: 'motor_inducao' })
  @IsOptional()
  @IsString()
  tipo_equipamento?: string;

  @ApiPropertyOptional({ example: '01JAQTE1MOTOR000000000017' })
  @IsOptional()
  @IsString()
  tipo_equipamento_id?: string;

  @ApiPropertyOptional({ example: 'sim' })
  @IsOptional()
  @IsString()
  em_operacao?: string;

  @ApiPropertyOptional({ example: 'linear' })
  @IsOptional()
  @IsString()
  tipo_depreciacao?: string;

  @ApiPropertyOptional({ example: '2024-01-15' })
  @IsOptional()
  @IsDateString()
  data_imobilizacao?: string;

  @ApiPropertyOptional({ example: '2024-01-15' })
  @IsOptional()
  @IsDateString()
  data_instalacao?: string;

  @ApiPropertyOptional({ example: 15000.00 })
  @IsOptional()
  @Transform(({ value }) => parseFloat(value))
  valor_imobilizado?: number;

  @ApiPropertyOptional({ example: 1500.00 })
  @IsOptional()
  @Transform(({ value }) => parseFloat(value))
  valor_depreciacao?: number;

  @ApiPropertyOptional({ example: 13500.00 })
  @IsOptional()
  @Transform(({ value }) => parseFloat(value))
  valor_contabil?: number;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  vida_util?: number;

  @ApiPropertyOptional({ example: 'Fornecedor ABC' })
  @IsOptional()
  @IsString()
  fornecedor?: string;

  @ApiPropertyOptional({ example: 'CC-001' })
  @IsOptional()
  @IsString()
  centro_custo?: string;

  @ApiPropertyOptional({ example: 'PM-001' })
  @IsOptional()
  @IsString()
  plano_manutencao?: string;

  @ApiPropertyOptional({ example: 'Área de Produção' })
  @IsOptional()
  @IsString()
  localizacao?: string;

  @ApiPropertyOptional({ example: 'Lado direito do motor' })
  @IsOptional()
  @IsString()
  localizacao_especifica?: string;

  @ApiPropertyOptional({ example: 'Observações gerais' })
  @IsOptional()
  @IsString()
  observacoes?: string;

  @ApiPropertyOptional({ example: 'Ativo', description: 'Status do equipamento: Ativo ou Inativo' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ example: 'TAG-001' })
  @IsOptional()
  @IsString()
  tag?: string;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  mqtt_habilitado?: boolean;

  @ApiPropertyOptional({ example: 'solar/medidor/01' })
  @IsOptional()
  @IsString()
  topico_mqtt?: string;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  mcpse?: boolean;

  @ApiPropertyOptional({ example: 'TUC-001' })
  @IsOptional()
  @IsString()
  tuc?: string;

  @ApiPropertyOptional({ example: 'A1-VALUE' })
  @IsOptional()
  @IsString()
  a1?: string;

  @ApiPropertyOptional({ example: 'A2-VALUE' })
  @IsOptional()
  @IsString()
  a2?: string;

  @ApiPropertyOptional({ example: 'A3-VALUE' })
  @IsOptional()
  @IsString()
  a3?: string;

  @ApiPropertyOptional({ example: 'A4-VALUE' })
  @IsOptional()
  @IsString()
  a4?: string;

  @ApiPropertyOptional({ example: 'A5-VALUE' })
  @IsOptional()
  @IsString()
  a5?: string;

  @ApiPropertyOptional({ example: 'A6-VALUE' })
  @IsOptional()
  @IsString()
  a6?: string;

  @ApiPropertyOptional({ example: '/uploads/equipamentos/foto-1234567890-123.jpg' })
  @IsOptional()
  @IsString()
  foto_url?: string;

  @ApiPropertyOptional({
    type: [DadoTecnicoDto],
    example: [
      { campo: 'potencia', valor: '15', tipo: 'number', unidade: 'kW' },
      { campo: 'tensao_nominal', valor: '380', tipo: 'number', unidade: 'V' }
    ]
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DadoTecnicoDto)
  dados_tecnicos?: DadoTecnicoDto[];

  @ApiPropertyOptional({
    description: 'Indica que o equipamento expoe pontos para integracao com TONs.',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  automacao?: boolean;

  @ApiPropertyOptional({
    description:
      'Pontos de automacao (comando/status/medicao). Sincronizados na mesma ' +
      'transacao do equipamento: em UPDATE, pontos com id existente sao atualizados, ' +
      'sem id sao criados, e os existentes no banco que NAO vierem no payload sao ' +
      'soft-deletados (preservando FK em ton_bo via ON DELETE SET NULL).',
    type: [EquipamentoPontoDto],
    example: [
      { tipo: 'comando', nome: 'abrir', ordem: 0, ativo: true },
      { tipo: 'comando', nome: 'fechar', ordem: 1, ativo: true },
    ],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EquipamentoPontoDto)
  pontos?: EquipamentoPontoDto[];
}