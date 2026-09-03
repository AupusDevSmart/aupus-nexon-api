import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { CreateEquipamentoDto, ClassificacaoEquipamento } from './create-equipamento.dto';

export class CreateComponenteUARDto extends CreateEquipamentoDto {
  @ApiProperty({ enum: ClassificacaoEquipamento, default: 'UAR' })
  classificacao: ClassificacaoEquipamento = ClassificacaoEquipamento.UAR;

  @ApiProperty({ example: 'eqp_01234567890123456789012345' })
  @IsString()
  @IsNotEmpty()
  equipamento_pai_id: string;

  @ApiPropertyOptional({ example: 'comp_01234567890123456789012345' })
  @IsOptional()
  @IsString()
  id?: string; // Para updates
}