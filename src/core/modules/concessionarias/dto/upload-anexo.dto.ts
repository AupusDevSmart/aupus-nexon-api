import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class UploadAnexoDto {
  @ApiProperty({
    description: 'Descrição do anexo',
    required: false,
    example: 'Resolução homologatória ANEEL'
  })
  @IsOptional()
  @IsString()
  descricao?: string;
}

export class AnexoConcessionariaResponseDto {
  @ApiProperty({ description: 'ID do anexo' })
  id: string;

  @ApiProperty({ description: 'ID da concessionária' })
  concessionaria_id: string;

  @ApiProperty({ description: 'Nome original do arquivo' })
  nome_original: string;

  @ApiProperty({ description: 'Nome do arquivo no servidor' })
  nome_arquivo: string;

  @ApiProperty({ description: 'Caminho do arquivo' })
  caminho: string;

  @ApiProperty({ description: 'Tipo MIME do arquivo' })
  mime_type: string;

  @ApiProperty({ description: 'Tamanho do arquivo em bytes' })
  tamanho: number;

  @ApiProperty({ description: 'Descrição do anexo', required: false })
  descricao?: string;

  @ApiProperty({ description: 'Data de criação' })
  created_at: Date;
}
