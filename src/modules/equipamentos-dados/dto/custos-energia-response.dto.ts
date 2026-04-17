import { ApiProperty } from '@nestjs/swagger';

// Enums
export enum TipoHorario {
  PONTA = 'PONTA',
  FORA_PONTA = 'FORA_PONTA',
  RESERVADO = 'RESERVADO',
  IRRIGANTE = 'IRRIGANTE',
}

export enum TipoTarifa {
  A3A_VERDE = 'A3A_VERDE',
  A4_VERDE = 'A4_VERDE',
  GRUPO_B = 'GRUPO_B',
}

// Sub-DTOs
export class PeriodoDto {
  @ApiProperty()
  inicio: Date;

  @ApiProperty()
  fim: Date;

  @ApiProperty()
  tipo: string;
}

export class UnidadeInfoDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  nome: string;

  @ApiProperty()
  grupo: string;

  @ApiProperty()
  subgrupo: string;

  @ApiProperty()
  irrigante: boolean;
}

export class TarifaDetalheDto {
  @ApiProperty()
  tusd: number;

  @ApiProperty()
  te: number;

  @ApiProperty()
  total: number;

  @ApiProperty({ required: false })
  desconto_aplicado?: string;
}

export class TarifasAplicadasDto {
  @ApiProperty()
  tipo: TipoTarifa;

  @ApiProperty({ required: false })
  ponta?: TarifaDetalheDto;

  @ApiProperty({ required: false })
  fora_ponta?: TarifaDetalheDto;

  @ApiProperty({ required: false })
  reservado?: TarifaDetalheDto;

  @ApiProperty({ required: false })
  irrigante?: TarifaDetalheDto;

  @ApiProperty({ required: false })
  demanda?: {
    tarifa_kw: number;
  };
}

export class ConsumoDto {
  @ApiProperty({ required: false })
  energia_ponta_kwh?: number;

  @ApiProperty({ required: false })
  energia_fora_ponta_kwh?: number;

  @ApiProperty({ required: false })
  energia_reservado_kwh?: number;

  @ApiProperty({ required: false })
  energia_irrigante_kwh?: number;

  @ApiProperty()
  energia_total_kwh: number;

  @ApiProperty({ required: false })
  demanda_maxima_kw?: number;

  @ApiProperty({ required: false })
  demanda_contratada_kw?: number;
}

export class CustosDto {
  @ApiProperty({ required: false })
  custo_ponta?: number;

  @ApiProperty({ required: false })
  custo_fora_ponta?: number;

  @ApiProperty({ required: false })
  custo_reservado?: number;

  @ApiProperty({ required: false })
  custo_irrigante?: number;

  @ApiProperty({ required: false })
  custo_demanda?: number;

  @ApiProperty()
  custo_total: number;

  @ApiProperty()
  custo_medio_kwh: number;
}

export class IrriganteInfoDto {
  @ApiProperty()
  ativo: boolean;

  @ApiProperty()
  horario_desconto: string;

  @ApiProperty()
  percentual_desconto_te: number;

  @ApiProperty()
  energia_periodo_desconto_kwh: number;

  @ApiProperty()
  economia_real: number;

  @ApiProperty()
  economia_percentual: number;
}

export class ConcessionariaInfoDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  nome: string;

  @ApiProperty()
  estado: string;
}

// DTO Principal
export class CustosEnergiaResponseDto {
  @ApiProperty()
  periodo: PeriodoDto;

  @ApiProperty()
  unidade: UnidadeInfoDto;

  @ApiProperty()
  concessionaria: ConcessionariaInfoDto;

  @ApiProperty()
  tarifas_aplicadas: TarifasAplicadasDto;

  @ApiProperty()
  consumo: ConsumoDto;

  @ApiProperty()
  custos: CustosDto;

  @ApiProperty({ required: false })
  irrigante?: IrriganteInfoDto;
}
