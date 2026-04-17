import { IsString, IsOptional, IsBoolean, IsObject, MinLength, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

class GridConfigDto {
  @ApiProperty({ description: 'Grid habilitado', example: true })
  @IsBoolean()
  enabled: boolean;

  @ApiProperty({ description: 'Tamanho do grid', example: 20 })
  size: number;

  @ApiProperty({ description: 'Snap to grid', example: true })
  @IsBoolean()
  snapToGrid: boolean;
}

class CanvasConfigDto {
  @ApiProperty({ description: 'Largura do canvas', example: 2000 })
  width: number;

  @ApiProperty({ description: 'Altura do canvas', example: 1500 })
  height: number;

  @ApiPropertyOptional({ description: 'Cor de fundo', example: '#f5f5f5' })
  @IsOptional()
  @IsString()
  backgroundColor?: string;
}

class ViewportConfigDto {
  @ApiPropertyOptional({ description: 'Posição X do viewport', example: 0 })
  @IsOptional()
  x?: number;

  @ApiPropertyOptional({ description: 'Posição Y do viewport', example: 0 })
  @IsOptional()
  y?: number;

  @ApiPropertyOptional({ description: 'Escala do viewport', example: 1.0 })
  @IsOptional()
  scale?: number;
}

class ConfiguracoesDto {
  @ApiPropertyOptional({ description: 'Zoom inicial', example: 1.0 })
  @IsOptional()
  zoom?: number;

  @ApiPropertyOptional({ description: 'Configurações do grid' })
  @IsOptional()
  @ValidateNested()
  @Type(() => GridConfigDto)
  grid?: GridConfigDto;

  @ApiPropertyOptional({ description: 'Configurações do canvas' })
  @IsOptional()
  @ValidateNested()
  @Type(() => CanvasConfigDto)
  canvas?: CanvasConfigDto;

  @ApiPropertyOptional({ description: 'Configurações do viewport' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ViewportConfigDto)
  viewport?: ViewportConfigDto;

  // ❌ REMOVIDO V2: componentesVisuais e conexoesVisuais
  // Barramentos e pontos de junção não existem mais no backend
  // São calculados algoritmicamente no frontend

  @ApiPropertyOptional({
    description: 'Posições customizadas dos labels dos componentes (mapeado por equipamento_id)',
    example: { 'eqp_123abc': { x: 10, y: -15 } }
  })
  @IsOptional()
  @IsObject()
  labelPositions?: Record<string, { x: number; y: number }>;
}

export class CreateDiagramaDto {
  @ApiProperty({ description: 'ID da unidade', example: 'clxyz123' })
  @IsString()
  unidadeId: string;

  @ApiProperty({ description: 'Nome do diagrama', example: 'Diagrama Principal' })
  @IsString()
  @MinLength(3)
  @MaxLength(255)
  nome: string;

  @ApiPropertyOptional({ description: 'Descrição do diagrama', example: 'Diagrama sinóptico da UFV principal' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  descricao?: string;

  @ApiPropertyOptional({ description: 'Diagrama ativo', example: true, default: true })
  @IsOptional()
  @IsBoolean()
  ativo?: boolean;

  @ApiPropertyOptional({ description: 'Configurações do diagrama' })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ConfiguracoesDto)
  configuracoes?: ConfiguracoesDto;
}
