import { ApiProperty } from '@nestjs/swagger';

export class PermissionResponseDto {
  @ApiProperty({ description: 'ID único da permissão' })
  id: number;

  @ApiProperty({ description: 'Nome da permissão (ex: usuarios.view)' })
  name: string;

  @ApiProperty({ description: 'Nome legível da permissão', required: false })
  display_name?: string;

  @ApiProperty({ description: 'Descrição da permissão', required: false })
  description?: string;

  @ApiProperty({ description: 'Nome do guard' })
  guard_name: string;

  @ApiProperty({ description: 'Data de criação', required: false })
  created_at?: Date;

  @ApiProperty({ description: 'Data de atualização', required: false })
  updated_at?: Date;
}