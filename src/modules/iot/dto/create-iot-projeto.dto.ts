import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateIotProjetoDto {
  @ApiProperty({
    description: 'ID da unidade dona do projeto IoT (CUID 26 chars)',
    example: 'cmllg2hfw00cnjqctjstb6eyg',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(26)
  unidade_id!: string;

  @ApiProperty({
    description: 'Nome do projeto IoT (livre, exibido no header da tab IoT)',
    example: 'Diagrama IoT — Planta GO',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  nome!: string;
}
