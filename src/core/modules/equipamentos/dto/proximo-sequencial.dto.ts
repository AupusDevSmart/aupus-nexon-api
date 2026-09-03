import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * De onde continuar a numeração de nomes e TAGs.
 *
 * Serve ao cadastro em lote e ao duplicar: quem já tem três inversores e copia
 * mais um espera o quarto, e não uma repetição do que foi copiado.
 */
export class ProximoSequencialDto {
  @ApiPropertyOptional({
    description:
      'Unidade em que procurar os nomes. Nomes se repetem legitimamente entre unidades, ' +
      'então a contagem é por unidade. Sem ela, a busca é global.',
  })
  @IsOptional()
  @IsString()
  unidade_id?: string;

  @ApiPropertyOptional({ example: 'Inversor', description: 'Início do nome a continuar.' })
  @IsOptional()
  @IsString()
  base_nome?: string;

  @ApiPropertyOptional({
    example: 'INV-UFV1-',
    description:
      'Início da TAG a continuar. A busca é global: a TAG identifica o equipamento no ' +
      'sistema inteiro, e repetir uma que já existe noutra unidade seria confusão garantida.',
  })
  @IsOptional()
  @IsString()
  base_tag?: string;
}
