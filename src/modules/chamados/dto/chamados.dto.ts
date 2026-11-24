import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min, ValidateIf } from 'class-validator';
import { CANAIS, DESTINOS, MOTIVOS, PRIORIDADES, STATUS, STATUS_EXTERNO, TIPOS } from '../chamados-regras';

/** Campos do chamado EXTERNO (aberto com terceiro: Equatorial, prefeitura...). Datas em ISO 8601. */
class CamposExternoDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  orgao?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  protocolo?: string;

  /** Quando o problema começou (ex.: hora em que a energia caiu). */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  ocorrencia_em?: string | null;

  /** Quando o chamado foi aberto no órgão. Sem valor: agora. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  aberto_em?: string | null;

  /** Previsão de solução dada pelo órgão. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  previsao_em?: string | null;
}

export class AbrirChamadoDto extends CamposExternoDto {
  /** INTERNO (reparo, padrão) ou EXTERNO (aberto com terceiro). */
  @IsOptional()
  @IsIn(TIPOS)
  tipo?: (typeof TIPOS)[number];

  /** Obrigatório no INTERNO; opcional no EXTERNO. */
  @IsOptional()
  @IsString()
  equipamento_id?: string;

  /** EXTERNO sem equipamento: instalação (unidade) do problema. */
  @IsOptional()
  @IsString()
  unidade_id?: string;

  /** EXTERNO sem equipamento nem unidade: a planta. */
  @IsOptional()
  @IsString()
  planta_id?: string;

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

/** Edição dos dados do chamado (não muda status nem tipo). Só o que vier é alterado. */
export class EditarChamadoDto extends CamposExternoDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  titulo?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  descricao?: string;

  @IsOptional()
  @IsIn(MOTIVOS)
  motivo?: (typeof MOTIVOS)[number];

  @IsOptional()
  @IsIn(PRIORIDADES)
  prioridade?: (typeof PRIORIDADES)[number];

  /** Trocar o vínculo (EXTERNO): equipamento, unidade ou planta; null tira. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  equipamento_id?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  unidade_id?: string | null;

  @IsOptional()
  @IsString()
  planta_id?: string;
}

/** Troca de status do EXTERNO (ABERTO, EM_ANDAMENTO, RESOLVIDO, CANCELADO). */
export class MudarStatusDto {
  @IsIn(STATUS_EXTERNO)
  status!: (typeof STATUS_EXTERNO)[number];

  /** Observação que entra na linha do tempo (ex.: "Equatorial religou às 17h40"). */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  texto?: string;

  /** RESOLVIDO/CANCELADO: quando aconteceu. Sem valor: agora. */
  @IsOptional()
  @IsDateString()
  quando?: string;
}

export class AdicionarNotaDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  texto!: string;
}

export class ExcluirChamadoDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  motivo!: string;
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

  @IsOptional()
  @IsIn(TIPOS)
  tipo?: (typeof TIPOS)[number];

  @IsOptional()
  @IsIn(MOTIVOS)
  motivo?: (typeof MOTIVOS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  orgao?: string;

  /** Período (data de início do chamado), AAAA-MM-DD. */
  @IsOptional()
  @IsDateString()
  de?: string;

  @IsOptional()
  @IsDateString()
  ate?: string;

  /** Um status, ABERTOS (não encerrados) ou ENCERRADOS. */
  @IsOptional()
  @IsIn([...STATUS, 'ABERTOS', 'ENCERRADOS'])
  status?: (typeof STATUS)[number] | 'ABERTOS' | 'ENCERRADOS';

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

  /** Número (#12), protocolo ou texto em título, descrição, órgão, equipamento ou autor. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  busca?: string;
}
