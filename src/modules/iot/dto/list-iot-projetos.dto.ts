import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Query params para `GET /iot/projetos?unidade_id=...`.
 * Proprietario, escopo de planta etc. sao validados em runtime no service.
 */
export class ListIotProjetosQueryDto {
  @ApiProperty({
    description: 'ID da unidade da qual listar os projetos IoT',
    example: 'cmllg2hfw00cnjqctjstb6eyg',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(26)
  unidade_id!: string;
}
