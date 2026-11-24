import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';

/** Aviso manual: pela TON (equipamento) ou direto pela unidade. Um dos dois. */
export class AvisarFaltaEnergiaDto {
  @ValidateIf((o) => !o.unidade_id)
  @IsString()
  @MaxLength(26)
  equipamento_id?: string;

  @ValidateIf((o) => !o.equipamento_id)
  @IsString()
  @MaxLength(26)
  unidade_id?: string;
}

export class ListarFaltaEnergiaDto {
  @IsOptional()
  @IsString()
  @MaxLength(26)
  chamado_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(26)
  planta_id?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
