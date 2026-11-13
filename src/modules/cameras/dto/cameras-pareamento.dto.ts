import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/** POST /cameras/pareamento — o aparelho sem token pede um código. */
export class PedirPareamentoDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  host!: string;

  @IsOptional()
  @IsString()
  @MaxLength(17)
  mac?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  versao?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  ip_local?: string;
}

/** POST /cameras/pareamento/:id/estado — o aparelho prova que é dono do pedido. */
export class EstadoPareamentoDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  segredo!: string;
}

/**
 * POST /cameras/pareamento/vincular — `codigo` (digitado do aparelho, de qualquer rede) OU
 * `pedido_id` (aparelho escolhido em /proximos, só da mesma rede). Exatamente um dos dois.
 */
export class VincularPareamentoDto {
  @IsOptional()
  @IsString()
  @Matches(/^\s*\d{3}\s?\d{3}\s*$/, { message: 'codigo deve ter 6 dígitos' })
  codigo?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(26)
  pedido_id?: string;

  @IsString()
  @IsNotEmpty()
  unidade_id!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  nome?: string;
}
