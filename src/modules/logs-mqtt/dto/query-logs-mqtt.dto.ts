import { IsOptional, IsString, IsInt, Min, Max, IsIn, Matches } from 'class-validator';
import { Type } from 'class-transformer';

export class QueryLogsMqttDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number = 10;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  equipamentoId?: string;

  @IsOptional()
  @IsString()
  unidadeId?: string;

  @IsOptional()
  @IsString()
  regraId?: string;

  /** Planta (via unidade do equipamento; acesso: plantas afetadas). */
  @IsOptional()
  @IsString()
  plantaId?: string;

  /** Autor: logs_mqtt.usuario_id (comando) / auditoria_acessos.autor_id (acesso). */
  @IsOptional()
  @IsString()
  usuarioId?: string;

  /** CSV: alerta,comando,acesso. Ausente = todos os de logs_mqtt (sem acesso). */
  @IsOptional()
  @IsString()
  @Matches(/^\s*(alerta|comando|acesso)\s*(,\s*(alerta|comando|acesso)\s*)*$/i, {
    message: 'tipo deve ser uma lista de: alerta, comando, acesso',
  })
  tipo?: string;

  /** Estado do alarme (implica tipo=alerta). ativo exclui silenciados. */
  @IsOptional()
  @IsString()
  @IsIn(['ativo', 'reconhecido', 'resolvido'])
  status?: 'ativo' | 'reconhecido' | 'resolvido';

  @IsOptional()
  @IsString()
  @IsIn(['BAIXA', 'MEDIA', 'ALTA', 'CRITICA'])
  severidade?: string;

  @IsOptional()
  @IsString()
  dataInicial?: string;

  @IsOptional()
  @IsString()
  dataFinal?: string;

  @IsOptional()
  @IsString()
  @IsIn(['created_at', 'severidade'])
  orderBy?: string = 'created_at';

  @IsOptional()
  @IsString()
  @IsIn(['asc', 'desc'])
  orderDirection?: string = 'desc';
}

export class SilenciarLogDto {
  /** Horas de silêncio (1..24). O alarme volta a "ativo" quando vencer. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24)
  horas!: number;
}
