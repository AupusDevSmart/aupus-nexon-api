// src/modules/usuarios/dto/assign-role.dto.ts
import { IsNumber, IsPositive } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AssignRoleDto {
  @ApiProperty({ 
    description: 'ID do role a ser atribuído', 
    example: 1 
  })
  @IsNumber()
  @IsPositive()
  roleId: number;
}