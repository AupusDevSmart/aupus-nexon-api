import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TipoUnidade, StatusUnidade, GrupoUnidade, SubgrupoUnidade, TipoUnidadeEnergia } from './create-unidade.dto';

export class ProprietarioBasico {
  @ApiProperty({ example: 'usr_01234567890123456789012345' })
  id: string;

  @ApiProperty({ example: 'João Silva' })
  nome: string;

  @ApiProperty({ example: 'joao@exemplo.com' })
  email: string;
}

export class PlantaBasica {
  @ApiProperty({ example: 'plt_01234567890123456789012345' })
  id: string;

  @ApiProperty({ example: 'Planta Industrial São Paulo' })
  nome: string;

  @ApiPropertyOptional({ example: 'São Paulo - SP' })
  localizacao?: string;

  @ApiPropertyOptional({ example: 'São Paulo' })
  cidade?: string;

  @ApiPropertyOptional({ example: 'SP' })
  uf?: string;

  @ApiPropertyOptional({ type: ProprietarioBasico })
  proprietario?: ProprietarioBasico;
}

export class UnidadeResponse {
  @ApiProperty({ example: 'uni_01234567890123456789012345' })
  id: string;

  @ApiProperty({ example: 'plt_01234567890123456789012345' })
  plantaId: string;

  @ApiProperty({ example: 'Unidade Fotovoltaica 1' })
  nome: string;

  @ApiProperty({ enum: TipoUnidade, example: TipoUnidade.GERACAO })
  tipo: TipoUnidade;

  @ApiProperty({ example: 'SP' })
  estado: string;

  @ApiProperty({ example: 'São Paulo' })
  cidade: string;

  @ApiProperty({ example: -23.5505 })
  latitude: number;

  @ApiProperty({ example: -46.6333 })
  longitude: number;

  @ApiProperty({ example: 1000.5, description: 'Potência em kW' })
  potencia: number;

  @ApiProperty({ enum: StatusUnidade, example: StatusUnidade.ativo })
  status: StatusUnidade;

  @ApiPropertyOptional({
    type: [String],
    example: ['Entrada', 'Saída', 'Transformador 1'],
  })
  pontosMedicao?: string[];

  @ApiPropertyOptional({ example: false })
  irrigante?: boolean;

  @ApiPropertyOptional({ enum: GrupoUnidade, example: GrupoUnidade.A })
  grupo?: GrupoUnidade;

  @ApiPropertyOptional({ enum: SubgrupoUnidade, example: SubgrupoUnidade.A4_VERDE })
  subgrupo?: SubgrupoUnidade;

  @ApiPropertyOptional({ enum: TipoUnidadeEnergia, example: TipoUnidadeEnergia.CARGA })
  tipoUnidade?: TipoUnidadeEnergia;

  @ApiPropertyOptional({ example: 150.5, description: 'Demanda de carga em kW' })
  demandaCarga?: number;

  @ApiPropertyOptional({ example: 200.0, description: 'Demanda de geração em kW' })
  demandaGeracao?: number;

  @ApiPropertyOptional({ example: 'con_01234567890123456789012345' })
  concessionariaId?: string;

  @ApiPropertyOptional({ example: '12345678', description: 'Número da unidade consumidora' })
  numeroUc?: string;

  @ApiPropertyOptional({ example: '0,38 kV', description: 'Tensão nominal' })
  tensaoNominal?: string;

  @ApiPropertyOptional({ example: false })
  sazonal?: boolean;

  @ApiPropertyOptional({ example: false })
  industrial?: boolean;

  @ApiPropertyOptional({ example: false })
  geracao?: boolean;

  @ApiPropertyOptional({ type: PlantaBasica })
  planta?: PlantaBasica;

  @ApiPropertyOptional({ example: 0, description: 'Total de equipamentos' })
  totalEquipamentos?: number;

  @ApiProperty({ example: '2024-01-15T10:30:00Z' })
  criadoEm: Date;

  @ApiProperty({ example: '2024-01-20T15:45:00Z' })
  atualizadoEm: Date;
}

export class PaginatedUnidadesResponse {
  @ApiProperty({ type: [UnidadeResponse] })
  data: UnidadeResponse[];

  @ApiProperty({
    example: {
      page: 1,
      limit: 10,
      total: 25,
      totalPages: 3,
    },
  })
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
