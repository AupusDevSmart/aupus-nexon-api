import { PartialType } from '@nestjs/mapped-types';
import { Transform, Type } from 'class-transformer';
import { papelCanonico } from '@/core/modules/auth/papeis';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CANAIS_NOTIFICACAO, EVENTOS_NOTIFICACAO, PAPEIS_NOTIFICACAO } from '../regras-notificacao.constants';

export class CreateRegraNotificacaoDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  nome: string;

  @IsString()
  @IsIn([...EVENTOS_NOTIFICACAO])
  evento: string;

  /** sem_comunicacao: minutos sem dado para avisar (padrão 30). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10080)
  limite_minutos?: number | null;

  /** vencimento_acesso_morador: dias antes do vencimento (padrão 7). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(90)
  antecedencia_dias?: number | null;

  @IsArray()
  @ArrayMinSize(1, { message: 'Escolha ao menos um canal' })
  @IsIn([...CANAIS_NOTIFICACAO], { each: true })
  canais: string[];

  /** Papel canônico; nome legado (super_admin, analista, gerente) vira o canônico. */
  @IsOptional()
  @IsArray()
  @Transform(({ value }) => (Array.isArray(value) ? value.map((p) => papelCanonico(p)) : value))
  @IsIn([...PAPEIS_NOTIFICACAO], { each: true })
  papeis?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  planta_ids?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  usuario_ids?: string[];

  @IsOptional()
  @IsBoolean()
  ativo?: boolean;
}

export class UpdateRegraNotificacaoDto extends PartialType(CreateRegraNotificacaoDto) {}

export class QueryRegrasNotificacaoDto {
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
  limit?: number = 20;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  @IsIn([...EVENTOS_NOTIFICACAO, 'all'])
  evento?: string;

  @IsOptional()
  @IsString()
  @IsIn([...CANAIS_NOTIFICACAO, 'all'])
  canal?: string;

  @IsOptional()
  @IsString()
  plantaId?: string;

  @IsOptional()
  @IsString()
  @IsIn(['true', 'false', 'all'])
  ativo?: string = 'all';
}
