import { IsOptional, IsString, IsInt, Min, Max, IsIn, IsBoolean } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class EquipamentoQueryDto {
  @ApiPropertyOptional({ example: 1, minimum: 1, description: 'Página atual' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 10, minimum: 1, maximum: 100, description: 'Itens por página' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;

  @ApiPropertyOptional({ example: 'motor', description: 'Buscar por nome, fabricante, modelo, etc.' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ example: 'uni_01234567890123456789012345', description: 'Filtrar por unidade' })
  @IsOptional()
  @IsString()
  unidade_id?: string;

  @ApiPropertyOptional({ example: 'plt_01234567890123456789012345', description: 'Filtrar por planta (busca em unidades da planta)' })
  @IsOptional()
  @IsString()
  planta_id?: string;

  @ApiPropertyOptional({ example: 'usr_01234567890123456789012345', description: 'Filtrar por proprietário (busca em plantas do proprietário)' })
  @IsOptional()
  @IsString()
  proprietario_id?: string;

  @ApiPropertyOptional({ example: 'UC', enum: ['UC', 'UAR'] })
  @IsOptional()
  @IsString()
  @IsIn(['UC', 'UAR'])
  classificacao?: string;

  @ApiPropertyOptional({
    example: false,
    description: 'Filtrar apenas equipamentos não posicionados em diagramas',
    type: Boolean
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  semDiagrama?: boolean;

  @ApiPropertyOptional({
    example: 'tipo_01234567890123456789012345',
    description: 'Filtrar por tipo de equipamento'
  })
  @IsOptional()
  @IsString()
  tipo?: string;

  @ApiPropertyOptional({ example: '5', enum: ['1', '2', '3', '4', '5'] })
  @IsOptional()
  @IsString()
  @IsIn(['1', '2', '3', '4', '5'])
  criticidade?: string;

  @ApiPropertyOptional({ example: 'eqp_01234567890123456789012345', description: 'Filtrar componentes por equipamento pai' })
  @IsOptional()
  @IsString()
  equipamento_pai_id?: string;

  @ApiPropertyOptional({
    example: true,
    description: 'Filtrar apenas equipamentos com MQTT habilitado',
    type: Boolean
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  mqtt_habilitado?: boolean;

  @ApiPropertyOptional({
    example: true,
    description: 'Filtrar apenas equipamentos SEM plano de manutenção',
    type: Boolean
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  semPlano?: boolean;

  @ApiPropertyOptional({
    description:
      'Oculta os componentes visuais do diagrama (PONTO e BARRAMENTO). A tela de cadastro usa; o diagrama, não.',
    type: Boolean
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  ocultarVirtuais?: boolean;

  @ApiPropertyOptional({
    example: 'nome',
    enum: ['nome', 'criticidade', 'created_at', 'fabricante', 'valor_contabil'],
    description: 'Campo para ordenação'
  })
  @IsOptional()
  @IsString()
  @IsIn(['nome', 'criticidade', 'created_at', 'fabricante', 'valor_contabil'])
  orderBy?: string = 'created_at';

  @ApiPropertyOptional({ example: 'desc', enum: ['asc', 'desc'] })
  @IsOptional()
  @IsString()
  @IsIn(['asc', 'desc'])
  orderDirection?: 'asc' | 'desc' = 'desc';
}