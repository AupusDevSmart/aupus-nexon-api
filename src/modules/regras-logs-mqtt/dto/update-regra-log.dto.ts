import { PartialType } from '@nestjs/mapped-types';
import { CreateRegraLogDto } from './create-regra-log.dto';
import { IsOptional, IsBoolean } from 'class-validator';

export class UpdateRegraLogDto extends PartialType(CreateRegraLogDto) {
  @IsOptional()
  @IsBoolean()
  ativo?: boolean;
}
