// src/modules/usuarios/dto/bulk-operations.dto.ts - NOVO ARQUIVO
import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsString, IsNumber, IsPositive, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class BulkUserRoleDto {
  @ApiProperty({ example: 'user123' })
  @IsString()
  userId: string;

  @ApiProperty({ example: 2 })
  @IsNumber()
  @IsPositive()
  roleId: number;
}

export class BulkUserPermissionDto {
  @ApiProperty({ example: 'user123' })
  @IsString()
  userId: string;

  @ApiProperty({ example: [1, 2, 3] })
  @IsArray()
  @IsNumber({}, { each: true })
  @IsPositive({ each: true })
  permissionIds: number[];
}

export class BulkAssignRolesDto {
  @ApiProperty({ type: [BulkUserRoleDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BulkUserRoleDto)
  assignments: BulkUserRoleDto[];
}

export class BulkAssignPermissionsDto {
  @ApiProperty({ type: [BulkUserPermissionDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BulkUserPermissionDto)
  assignments: BulkUserPermissionDto[];
}