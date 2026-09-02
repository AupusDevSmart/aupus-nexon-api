// src/modules/usuarios/dto/check-permissions.dto.ts - NOVO ARQUIVO
import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsString, IsOptional } from 'class-validator';

export class CheckPermissionDto {
  @ApiProperty({ example: 'Dashboard' })
  @IsString()
  permissionName: string;
}

export class CheckMultiplePermissionsDto {
  @ApiProperty({ example: ['Dashboard', 'Usuarios'] })
  @IsArray()
  @IsString({ each: true })
  permissionNames: string[];

  @ApiProperty({ 
    example: 'any', 
    enum: ['any', 'all'],
    description: 'any = tem pelo menos uma, all = tem todas'
  })
  @IsOptional()
  @IsString()
  mode?: 'any' | 'all' = 'any';
}