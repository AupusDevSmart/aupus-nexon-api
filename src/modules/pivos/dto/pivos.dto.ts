import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class JanelaPivoDto {
  @ApiProperty()
  @IsBoolean()
  ativo!: boolean;

  @ApiProperty({ example: '18:00' })
  @IsString()
  @Matches(HHMM, { message: 'inicio deve ser HH:MM' })
  inicio!: string;

  @ApiProperty({ example: '21:00' })
  @IsString()
  @Matches(HHMM, { message: 'fim deve ser HH:MM' })
  fim!: string;

  @ApiProperty({ description: '1 = segunda … 7 = domingo', example: [1, 2, 3, 4, 5] })
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  dias!: number[];
}

/** POST /pivos/:id/calibracao — calibração do ângulo (NEXON-103): leitura do encoder × azimute do braço. */
export class CalibracaoAnguloDto {
  @ApiProperty({ description: 'Leitura do encoder na calibração — o valor que o "Ler encoder" devolveu' })
  @IsInt() @Min(0) @Max(16_777_215)
  bruto_cal: number;

  @ApiProperty({ enum: [1, -1], description: '+1: a contagem aumenta com o pivô no sentido horário (visto de cima); −1: diminui' })
  @IsIn([1, -1])
  sentido: number;

  @ApiProperty({ description: 'Latitude do centro do pivô (graus decimais)' })
  @IsNumber() @Min(-90) @Max(90)
  centro_lat: number;

  @ApiProperty({ description: 'Longitude do centro do pivô (graus decimais)' })
  @IsNumber() @Min(-180) @Max(180)
  centro_lon: number;

  @ApiProperty({ description: 'Latitude da ponta — a última torre, não o meio do lance' })
  @IsNumber() @Min(-90) @Max(90)
  ponta_lat: number;

  @ApiProperty({ description: 'Longitude da ponta' })
  @IsNumber() @Min(-180) @Max(180)
  ponta_lon: number;
}

/** PUT /pivos/:id/config — parcial: o que não vier fica como está. */
/** Parâmetros de irrigação e direcionamento da água (aba Configuração do pivô). */
export class ParametrosPivoDto {
  @ApiPropertyOptional({ description: 'Pressão mínima (bar), abaixo dela: falha de pressão' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber() @Min(0.5) @Max(6)
  pressao_minima?: number | null;

  @ApiPropertyOptional({ description: 'Lâmina d’água a 100% (mm)' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber() @Min(2) @Max(20)
  lamina_100?: number | null;

  @ApiPropertyOptional({ description: 'Tempo de volta a 100% (h), base da previsão de término' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber() @Min(6) @Max(72)
  tempo_volta_100?: number | null;

  @ApiPropertyOptional({ description: 'Ciclo do percentímetro (s): a TON liga o motor de movimento % deste tempo e desliga o resto. Padrão 60.' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(5) @Max(600)
  percentimetro_ciclo_s?: number | null;

  @ApiPropertyOptional({ description: 'Correção do ângulo zero (°)' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber() @Min(-180) @Max(180)
  correcao_angulo_zero?: number | null;

  @ApiPropertyOptional({ description: 'Encoder de posição (equipamento criado pelo diagrama IoT, mesma instalação). null desliga.' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(26)
  encoder_equipamento_id?: string | null;

  @ApiPropertyOptional({ description: 'Posições por volta do encoder (360, 2048, 4096, 8192…), do código de compra' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(16) @Max(16_777_216)
  encoder_resolucao?: number | null;

  @ApiPropertyOptional({ description: 'Encoder conta ao contrário do sentido de Avanço' })
  @IsOptional() @IsBoolean()
  encoder_invertido?: boolean;

  @ApiPropertyOptional({ description: 'Alarme de pivô travado (min): girando com o ângulo parado por este tempo. Padrão 10.' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(240)
  travado_min?: number | null;

  @ApiPropertyOptional({ enum: ['valvula', 'fisico'], description: 'Sistema conjugado: válvula pelo NexON ou intertravamento físico' })
  @IsOptional() @IsIn(['valvula', 'fisico'])
  direcionamento?: 'valvula' | 'fisico';

  @ApiPropertyOptional({ description: 'TON da saída que comanda a válvula' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(26)
  valvula_ton_id?: string | null;

  @ApiPropertyOptional({ description: 'BO da TON que comanda a válvula (1 a 16)' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(16)
  valvula_bo?: number | null;
}

export class PivoConfigDto {
  @ApiPropertyOptional({ type: ParametrosPivoDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ParametrosPivoDto)
  parametros?: ParametrosPivoDto;

  @ApiPropertyOptional({ type: JanelaPivoDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => JanelaPivoDto)
  bloqueio_ponta?: JanelaPivoDto;

  @ApiPropertyOptional({ type: JanelaPivoDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => JanelaPivoDto)
  reservado?: JanelaPivoDto;

  @ApiPropertyOptional({ description: 'Motobomba que alimenta o pivô (sistema conjugado). null desfaz.' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(26)
  motobomba_equipamento_id?: string | null;
}

/** POST/PUT /pivos/:id/programacoes */
export class ProgramacaoPivoDto {
  @ApiProperty({ example: 'Irrigação noturna' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  nome!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  ativo?: boolean;

  @ApiProperty({ example: '22:00' })
  @IsString()
  @Matches(HHMM, { message: 'hora_inicio deve ser HH:MM' })
  hora_inicio!: string;

  @ApiProperty({ example: [1, 2, 3, 4, 5, 6, 7] })
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  dias!: number[];

  @ApiProperty({ enum: ['percurso', 'tempo'] })
  @IsIn(['percurso', 'tempo'])
  modo!: 'percurso' | 'tempo';

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(360)
  angulo_inicial?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(360)
  angulo_final?: number | null;

  @ApiPropertyOptional({ description: 'Obrigatório no modo tempo' })
  @ValidateIf((o) => o.modo === 'tempo' || (o.duracao_min !== undefined && o.duracao_min !== null))
  @IsInt()
  @Min(1)
  @Max(7 * 24 * 60)
  duracao_min?: number | null;

  @ApiProperty({ enum: ['horario', 'anti_horario'] })
  @IsIn(['horario', 'anti_horario'])
  sentido!: 'horario' | 'anti_horario';

  @ApiPropertyOptional({ description: '% (0–100)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  velocidade?: number | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  com_agua?: boolean;

  @ApiPropertyOptional({ default: false, description: 'Liga o canhão final junto com o pivô (só vale com água)' })
  @IsOptional()
  @IsBoolean()
  canhao?: boolean;
}
