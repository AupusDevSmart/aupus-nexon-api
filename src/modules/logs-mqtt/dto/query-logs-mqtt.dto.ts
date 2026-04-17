import { IsOptional, IsString, IsInt, Min, Max, IsIn } from 'class-validator';
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
  regraId?: string;

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
