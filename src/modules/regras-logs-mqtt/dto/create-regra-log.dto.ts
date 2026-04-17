import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsIn,
  IsInt,
  Min,
  MaxLength,
} from 'class-validator';

export class CreateRegraLogDto {
  @IsString()
  @IsNotEmpty()
  equipamento_id: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  nome: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  campo_json: string;

  @IsString()
  @IsIn(['<', '>', '<=', '>=', '==', '!='])
  operador: string;

  @IsNumber()
  valor: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  mensagem: string;

  @IsOptional()
  @IsString()
  @IsIn(['BAIXA', 'MEDIA', 'ALTA', 'CRITICA'])
  severidade?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  cooldown_minutos?: number;
}
