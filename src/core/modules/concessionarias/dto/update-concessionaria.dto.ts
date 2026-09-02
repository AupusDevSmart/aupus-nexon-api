import { PartialType } from '@nestjs/swagger';
import { CreateConcessionariaDto } from './create-concessionaria.dto';

export class UpdateConcessionariaDto extends PartialType(CreateConcessionariaDto) {}
