import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import type { IotDiagrama } from '../interfaces/iot-diagrama.interface';

export class UpdateIotProjetoDto {
  @ApiPropertyOptional({
    description: 'Novo nome do projeto. Omitir mantem o atual.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  nome?: string;

  @ApiPropertyOptional({
    description:
      'Novo conteudo do diagrama (JSON). Tipado como objeto generico — ' +
      'a estrutura interna eh ditada pelo editor SVG do frontend.',
  })
  @IsOptional()
  @IsObject()
  diagrama?: IotDiagrama;
}
