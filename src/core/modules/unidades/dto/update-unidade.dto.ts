import { PartialType } from '@nestjs/swagger';
import { CreateUnidadeDto, StatusUnidade } from './create-unidade.dto';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

export class UpdateUnidadeDto extends PartialType(CreateUnidadeDto) {
  @ApiPropertyOptional({
    description: 'Status da unidade',
    enum: StatusUnidade,
    example: StatusUnidade.ativo,
  })
  @IsOptional()
  @IsEnum(StatusUnidade, { message: 'Status inválido' })
  status?: StatusUnidade;
}
