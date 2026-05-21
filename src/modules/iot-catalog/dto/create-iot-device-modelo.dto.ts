import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateIotDeviceModeloDto {
  /**
   * Codigo do tipo (FK por codigo, nao por id — UI eh por codigo).
   * Service resolve para tipo_id antes de gravar.
   */
  @IsNotEmpty({ message: 'tipo eh obrigatorio' })
  @IsString()
  @MaxLength(50)
  tipo!: string;

  @IsNotEmpty({ message: 'fabricante eh obrigatorio' })
  @IsString()
  @MaxLength(100)
  fabricante!: string;

  @IsNotEmpty({ message: 'modelo eh obrigatorio' })
  @IsString()
  @MaxLength(100)
  modelo!: string;

  @IsNotEmpty({ message: 'protocolo eh obrigatorio' })
  @IsString()
  @MaxLength(20)
  protocolo!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  connection_note?: string;

  /**
   * Slug historico do catalogo (ex: "sungrow-sg250cx"). Opcional —
   * se nao informado, eh derivado de fabricante+modelo (slug lowercase).
   * Salvo dentro de mapeamento.catalog_id pra preservar identidade.
   */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  catalog_id?: string;

  /**
   * Mapeamento Modbus completo (ai_blocks, ai_map, bi_map, bo_map, ...).
   * Validacao estrutural fica a cargo da UI.
   */
  @IsOptional()
  @IsObject({ message: 'mapeamento deve ser um objeto' })
  mapeamento?: Record<string, unknown>;
}
