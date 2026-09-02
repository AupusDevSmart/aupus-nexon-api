import { IsArray, IsNumber, IsPositive } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class SyncPermissionsDto {
  @ApiProperty({ 
    description: 'Array de IDs das permissões a serem sincronizadas', 
    example: [1, 2, 3],
    type: [Number]
  })
  @IsArray()
  @Type(() => Number)
  @IsNumber({}, { each: true })
  @IsPositive({ each: true })
  permissionIds: number[];
}