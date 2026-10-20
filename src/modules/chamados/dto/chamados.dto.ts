import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { CANAIS, DESTINOS, MOTIVOS, PRIORIDADES, STATUS } from '../chamados-regras';

export class AbrirChamadoDto {
  @IsString()
  @IsNotEmpty()
  equipamento_id!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  titulo!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  descricao!: string;

  @IsOptional()
  @IsIn(MOTIVOS)
  motivo?: (typeof MOTIVOS)[number];

  @IsOptional()
  @IsIn(PRIORIDADES)
  prioridade?: (typeof PRIORIDADES)[number];

  /** WEB ou APP. Sem valor: deduzido do dispositivo do request. */
  @IsOptional()
  @IsIn(CANAIS)
  canal?: (typeof CANAIS)[number];
}

export class EncaminharChamadoDto {
  @IsIn(DESTINOS)
  destino!: (typeof DESTINOS)[number];

  /** Telefone (WhatsApp) ou e-mail. Sem valor: o do proprietário da planta. */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  contato?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  observacao?: string;
}

export class FecharChamadoDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  motivo!: string;
}

export class ListarChamadosDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;

  /** Um status, ou ABERTOS (ABERTO + ENCAMINHADO). */
  @IsOptional()
  @IsIn([...STATUS, 'ABERTOS'])
  status?: (typeof STATUS)[number] | 'ABERTOS';

  @IsOptional()
  @IsString()
  planta_id?: string;

  @IsOptional()
  @IsString()
  unidade_id?: string;

  @IsOptional()
  @IsString()
  equipamento_id?: string;

  @IsOptional()
  @IsIn(PRIORIDADES)
  prioridade?: (typeof PRIORIDADES)[number];

  /** Número (#12) ou texto em título, descrição, equipamento ou autor. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  busca?: string;
}
