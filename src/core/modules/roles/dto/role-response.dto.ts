import { ApiProperty } from '@nestjs/swagger';

export class RoleResponseDto {
  @ApiProperty({ description: 'ID único da role' })
  id: number;

  @ApiProperty({ description: 'Nome da role' })
  name: string;

  @ApiProperty({ description: 'Nome do guard' })
  guard_name: string;

  @ApiProperty({ description: 'Data de criação' })
  created_at: Date;

  @ApiProperty({ description: 'Data de atualização' })
  updated_at: Date;

  @ApiProperty({ 
    description: 'Permissões associadas à role',
    type: 'array',
    items: { type: 'object' },
    required: false
  })
  permissions?: {
    id: number;
    name: string;
    guard_name: string;
  }[];
}