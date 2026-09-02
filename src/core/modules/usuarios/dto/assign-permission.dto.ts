import { IsNumber, IsPositive } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AssignPermissionDto {
  @ApiProperty({ 
    description: 'ID da permissão a ser atribuída', 
    example: 1 
  })
  @IsNumber()
  @IsPositive()
  permissionId: number;
}