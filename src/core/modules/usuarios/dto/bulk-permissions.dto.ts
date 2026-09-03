import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsString, IsNumber, IsPositive, IsOptional, ValidateNested } from 'class-validator';
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