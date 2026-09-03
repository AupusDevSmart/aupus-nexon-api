import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, IsNotEmpty, IsEnum, IsNumber, IsOptional, IsJSON, Min, Max, Matches, IsBoolean } from 'class-validator';

// Normaliza '' e null para undefined antes das demais validacoes. Necessario
// porque @IsOptional() do class-validator so pula validacao se for null
// ou undefined estrito — string vazia '' (comum em forms HTML) cai no
// @IsEnum/@IsString e dispara erro 400. Aplicar em todos os opcionais
// que aceitam string/enum.
const NormalizeEmptyString = () =>
  Transform(({ value }) => (value === '' || value === null ? undefined : value));

// Normaliza Unicode NFC e trim. Forms HTML podem produzir strings em NFD
// (ex: 'ç' decomposto em 'c' + diacritico) que falham @IsEnum por strict
// equality. NFC garante codificacao canonica.
const NormalizeUnicode = () =>
  Transform(({ value }) =>
    typeof value === 'string' ? value.normalize('NFC').trim() : value,
  );

export enum StatusUnidade {
  ativo = 'ativo',
  inativo = 'inativo',
}

/**
 * O que a instalacao e do ponto de vista de energia: consome, gera, ou os dois.
 *
 * Substitui UFV/PCH/OUTRO, que descreviam a TECNOLOGIA da usina — informacao
 * que nao servia para nada no cadastro e deixava de fora as instalacoes que so
 * consomem.
 */
export enum TipoUnidade {
  CARGA = 'Carga',
  GERACAO = 'Geração',
  MISTO = 'Misto',
}

export enum GrupoUnidade {
  A = 'A',
  B = 'B',
}

export enum SubgrupoUnidade {
  A4_VERDE = 'A4_VERDE',
  A3a_VERDE = 'A3a_VERDE',
  B = 'B',
}

export enum TipoUnidadeEnergia {
  CARGA = 'Carga',
  GERACAO = 'Geração',
  CARGA_E_GERACAO = 'Carga e Geração',
}

export class CreateUnidadeDto {
  @ApiProperty({
    description: 'ID da planta à qual a unidade pertence',
    example: 'plt_01234567890123456789012345',
  })
  @IsString()
  @IsNotEmpty({ message: 'ID da planta é obrigatório' })
  planta_id: string;

  @ApiProperty({
    description: 'Nome da unidade',
    example: 'Unidade Fotovoltaica 1',
  })
  @IsString()
  @IsNotEmpty({ message: 'Nome da unidade é obrigatório' })
  nome: string;

  @ApiProperty({
    description: 'Número da Unidade Consumidora',
    example: '123456789',
    required: false,
  })
  @NormalizeEmptyString()
  @IsString()
  @IsOptional()
  numero_uc?: string;

  @ApiProperty({
    description: 'Tipo da unidade',
    enum: TipoUnidade,
    example: TipoUnidade.GERACAO,
  })
  @IsEnum(TipoUnidade, { message: 'Tipo de unidade inválido' })
  @IsNotEmpty({ message: 'Tipo da unidade é obrigatório' })
  tipo: TipoUnidade;

  @ApiProperty({
    description: 'Estado (UF)',
    example: 'SP',
    minLength: 2,
    maxLength: 2,
  })
  @IsString()
  @IsNotEmpty({ message: 'Estado é obrigatório' })
  @Matches(/^[A-Z]{2}$/, { message: 'Estado deve conter 2 letras maiúsculas' })
  estado: string;

  @ApiProperty({
    description: 'Cidade',
    example: 'São Paulo',
  })
  @IsString()
  @IsNotEmpty({ message: 'Cidade é obrigatória' })
  cidade: string;

  @ApiProperty({
    description: 'Latitude (coordenada geográfica)',
    example: -23.5505,
    minimum: -90,
    maximum: 90,
  })
  @IsNumber({}, { message: 'Latitude deve ser um número' })
  @Min(-90, { message: 'Latitude mínima é -90' })
  @Max(90, { message: 'Latitude máxima é 90' })
  latitude: number;

  @ApiProperty({
    description: 'Longitude (coordenada geográfica)',
    example: -46.6333,
    minimum: -180,
    maximum: 180,
  })
  @IsNumber({}, { message: 'Longitude deve ser um número' })
  @Min(-180, { message: 'Longitude mínima é -180' })
  @Max(180, { message: 'Longitude máxima é 180' })
  longitude: number;

  @ApiProperty({
    description: 'Potência em kW',
    example: 1000.5,
    minimum: 0,
    required: false,
    default: 0,
  })
  @IsNumber({}, { message: 'Potência deve ser um número' })
  @Min(0, { message: 'Potência não pode ser negativa' })
  @IsOptional()
  potencia?: number;

  @ApiProperty({
    description: 'Pontos de medição (array de strings em formato JSON)',
    example: ['Entrada', 'Saída', 'Transformador 1'],
    required: false,
  })
  @IsOptional()
  pontos_medicao?: string[];

  @ApiProperty({
    description: 'Status da unidade',
    enum: StatusUnidade,
    example: StatusUnidade.ativo,
    required: false,
    default: 'ativo',
  })
  @NormalizeEmptyString()
  @IsEnum(StatusUnidade, { message: 'Status inválido. Use: ativo ou inativo' })
  @IsOptional()
  status?: StatusUnidade;

  @ApiProperty({
    description: 'Indica se a unidade é irrigante',
    example: false,
    required: false,
    default: false,
  })
  @IsBoolean({ message: 'Irrigante deve ser um booleano' })
  @IsOptional()
  irrigante?: boolean;

  @ApiProperty({
    description: 'Grupo tarifário (A ou B)',
    enum: GrupoUnidade,
    example: GrupoUnidade.A,
    required: false,
  })
  @NormalizeEmptyString()
  @IsEnum(GrupoUnidade, { message: 'Grupo inválido. Use: A ou B' })
  @IsOptional()
  grupo?: GrupoUnidade;

  @ApiProperty({
    description: 'Subgrupo tarifário',
    enum: SubgrupoUnidade,
    example: SubgrupoUnidade.A4_VERDE,
    required: false,
  })
  @NormalizeEmptyString()
  @IsEnum(SubgrupoUnidade, { message: 'Subgrupo inválido' })
  @IsOptional()
  subgrupo?: SubgrupoUnidade;

  @ApiProperty({
    description: 'Tipo da unidade de energia (Carga ou Geração)',
    enum: TipoUnidadeEnergia,
    example: TipoUnidadeEnergia.CARGA,
    required: false,
  })
  @NormalizeEmptyString()
  @NormalizeUnicode()
  @IsEnum(TipoUnidadeEnergia, { message: 'Tipo de unidade inválido. Use: Carga ou Geração' })
  @IsOptional()
  tipo_unidade?: TipoUnidadeEnergia;

  @ApiProperty({
    description: 'Demanda de carga em kW (obrigatório se tipo_unidade for Carga)',
    example: 150.5,
    minimum: 0,
    required: false,
  })
  @IsNumber({}, { message: 'Demanda de carga deve ser um número' })
  @Min(0, { message: 'Demanda de carga não pode ser negativa' })
  @IsOptional()
  demanda_carga?: number;

  @ApiProperty({
    description: 'Demanda de geração em kW (obrigatório se tipo_unidade for Geração)',
    example: 200.0,
    minimum: 0,
    required: false,
  })
  @IsNumber({}, { message: 'Demanda de geração deve ser um número' })
  @Min(0, { message: 'Demanda de geração não pode ser negativa' })
  @IsOptional()
  demanda_geracao?: number;

  @ApiProperty({
    description: 'ID da concessionária de energia',
    example: 'con_01234567890123456789012345',
    required: false,
  })
  @NormalizeEmptyString()
  @IsString()
  @IsOptional()
  concessionaria_id?: string;

  @ApiProperty({
    description: 'Tensão nominal (ex: 0,38 kV)',
    example: '0,38 kV',
    required: false,
  })
  @NormalizeEmptyString()
  @IsString()
  @IsOptional()
  tensao_nominal?: string;

  @ApiProperty({
    description: 'Indica se a unidade é sazonal',
    example: false,
    required: false,
    default: false,
  })
  @IsBoolean({ message: 'Sazonal deve ser um booleano' })
  @IsOptional()
  sazonal?: boolean;

  @ApiProperty({
    description: 'Indica se a unidade é industrial',
    example: false,
    required: false,
    default: false,
  })
  @IsBoolean({ message: 'Industrial deve ser um booleano' })
  @IsOptional()
  industrial?: boolean;

  @ApiProperty({
    description: 'Indica se a unidade possui geração',
    example: false,
    required: false,
    default: false,
  })
  @IsBoolean({ message: 'Geração deve ser um booleano' })
  @IsOptional()
  geracao?: boolean;
}
