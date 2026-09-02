import { IsArray, IsNotEmpty, IsString, ArrayMinSize } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Copiar a lista de anexos de um equipamento para outros.
 *
 * Serve ao cadastro em lote e ao duplicar: os documentos são os mesmos entre
 * equipamentos iguais da mesma unidade, mas pertencem a cada um deles — depois
 * de copiados, cada equipamento acrescenta ou remove o que quiser.
 */
export class ReplicarAnexosDto {
  @ApiProperty({ example: 'cmhcg1w27000ejqo84gbjeyty' })
  @IsString()
  @IsNotEmpty()
  origem_equipamento_id: string;

  @ApiProperty({
    type: [String],
    example: ['cmhcg1w27000fjqo84gbjeytz', 'cmhcg1w27000gjqo84gbjeyu0'],
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  destino_equipamento_ids: string[];
}
