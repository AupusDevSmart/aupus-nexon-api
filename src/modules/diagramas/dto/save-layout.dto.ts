import { IsString, IsNumber, IsEnum, IsArray, ValidateNested, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTOs para salvamento atômico do layout do diagrama
 * Estratégia: DELETE ALL + INSERT ALL em uma única transação
 * Performance: ~10x mais rápido que múltiplas requisições PATCH
 */

enum PortaEnum {
  TOP = 'top',
  BOTTOM = 'bottom',
  LEFT = 'left',
  RIGHT = 'right',
}

enum TipoConexaoEnum {
  EQUIPAMENTO = 'equipamento',
  JUNCTION = 'junction',
}

enum LabelPositionEnum {
  TOP = 'top',
  BOTTOM = 'bottom',
  LEFT = 'left',
  RIGHT = 'right',
}

/**
 * Posição de um equipamento no diagrama
 * Apenas campos essenciais de layout
 */
export class EquipamentoLayoutDto {
  @ApiProperty({ description: 'ID do equipamento', example: 'cm123abc' })
  @IsString()
  equipamentoId: string;

  @ApiProperty({ description: 'Posição X no grid (unidades de grid)', example: 5 })
  @IsNumber()
  posicaoX: number;

  @ApiProperty({ description: 'Posição Y no grid (unidades de grid)', example: 3 })
  @IsNumber()
  posicaoY: number;

  @ApiPropertyOptional({ description: 'Rotação em graus (0-360)', example: 0, default: 0 })
  @IsOptional()
  @IsNumber()
  rotacao?: number;

  @ApiPropertyOptional({
    description: 'Posição do label',
    enum: LabelPositionEnum,
    example: 'top',
    default: 'top'
  })
  @IsOptional()
  @IsEnum(LabelPositionEnum)
  labelPosition?: LabelPositionEnum;

  @ApiPropertyOptional({
    description: 'Offset X do label em pixels (para posicionamento customizado)',
    example: 0
  })
  @IsOptional()
  @IsNumber()
  labelOffsetX?: number;

  @ApiPropertyOptional({
    description: 'Offset Y do label em pixels (para posicionamento customizado)',
    example: 0
  })
  @IsOptional()
  @IsNumber()
  labelOffsetY?: number;
}

/**
 * Ponto de grid para junction points
 */
export class GridPointDto {
  @ApiProperty({ description: 'Coordenada X no grid', example: 5 })
  @IsNumber()
  x: number;

  @ApiProperty({ description: 'Coordenada Y no grid', example: 10 })
  @IsNumber()
  y: number;
}

/**
 * Origem ou destino de uma conexão
 * Pode ser um equipamento OU um junction point (ponto de junção no grid)
 */
export class OrigemDestinoDto {
  @ApiProperty({
    description: 'Tipo da conexão',
    enum: TipoConexaoEnum,
    example: 'equipamento'
  })
  @IsEnum(TipoConexaoEnum)
  tipo: TipoConexaoEnum;

  @ApiPropertyOptional({
    description: 'ID do equipamento (obrigatório se tipo = "equipamento")',
    example: 'cm123abc'
  })
  @IsOptional()
  @IsString()
  equipamentoId?: string;

  @ApiPropertyOptional({
    description: 'Coordenadas do ponto de junção (obrigatório se tipo = "junction")',
    type: GridPointDto
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => GridPointDto)
  gridPoint?: GridPointDto;

  @ApiProperty({
    description: 'Porta de conexão',
    enum: PortaEnum,
    example: 'right'
  })
  @IsEnum(PortaEnum)
  porta: PortaEnum;
}

/**
 * Conexão entre dois pontos (equipamentos ou junction points)
 * Visual padrão (sem customização)
 */
export class ConexaoLayoutDto {
  @ApiProperty({
    description: 'Origem da conexão (equipamento ou junction point)',
    type: OrigemDestinoDto
  })
  @ValidateNested()
  @Type(() => OrigemDestinoDto)
  origem: OrigemDestinoDto;

  @ApiProperty({
    description: 'Destino da conexão (equipamento ou junction point)',
    type: OrigemDestinoDto
  })
  @ValidateNested()
  @Type(() => OrigemDestinoDto)
  destino: OrigemDestinoDto;
}

/**
 * DTO completo para salvar todo o layout do diagrama
 * Uma única requisição substitui todo o estado anterior
 */
export class SaveLayoutDto {
  @ApiProperty({
    description: 'Posições de todos os equipamentos no diagrama',
    type: [EquipamentoLayoutDto]
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EquipamentoLayoutDto)
  equipamentos: EquipamentoLayoutDto[];

  @ApiProperty({
    description: 'Todas as conexões entre equipamentos',
    type: [ConexaoLayoutDto]
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConexaoLayoutDto)
  conexoes: ConexaoLayoutDto[];
}
