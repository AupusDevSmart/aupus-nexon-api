import { IsString, IsBoolean, IsNumber, IsOptional, IsArray, Min, Max } from 'class-validator';

export class UpdateConfiguracaoDemandaDto {
  @IsString()
  @IsOptional()
  unidade_id?: string;

  @IsString()
  @IsOptional()
  fonte?: 'AGRUPAMENTO' | 'A966' | 'AUTO';

  @IsArray()
  @IsOptional()
  equipamentos_ids?: any[];

  @IsBoolean()
  @IsOptional()
  mostrar_detalhes?: boolean;

  @IsNumber()
  @IsOptional()
  @Min(10)
  @Max(300)
  intervalo_atualizacao?: number;

  @IsBoolean()
  @IsOptional()
  aplicar_perdas?: boolean;

  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(20)
  fator_perdas?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  valor_contratado?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(100)
  percentual_adicional?: number;

  /** Demanda contratada de geração (kW) — grava em unidades.demanda_geracao. */
  @IsNumber()
  @IsOptional()
  @Min(0)
  demanda_geracao?: number | null;

  /** Demanda contratada de carga/consumo (kW) — grava em unidades.demanda_carga. */
  @IsNumber()
  @IsOptional()
  @Min(0)
  demanda_carga?: number | null;
}
