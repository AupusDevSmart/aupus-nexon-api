import { PartialType } from '@nestjs/mapped-types';
import { CreateCategoriaEquipamentoDto } from './create-categoria-equipamento.dto';

export class UpdateCategoriaEquipamentoDto extends PartialType(
  CreateCategoriaEquipamentoDto,
) {}
