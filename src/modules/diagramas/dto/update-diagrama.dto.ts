import { PartialType } from '@nestjs/swagger';
import { CreateDiagramaDto } from './create-diagrama.dto';
import { IsBoolean, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateDiagramaDto extends PartialType(CreateDiagramaDto) {
  @ApiPropertyOptional({ description: 'Se o diagrama está ativo', example: true })
  @IsOptional()
  @IsBoolean()
  ativo?: boolean;
}
