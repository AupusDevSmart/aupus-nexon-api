// src/modules/usuarios/dto/user-permissions-response.dto.ts - NOVO ARQUIVO  
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UserPermissionDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: 'Dashboard' })
  name: string;

  @ApiProperty({ example: 'web' })
  guard_name: string;

  @ApiProperty({ example: 'role', enum: ['role', 'direct'] })
  source: 'role' | 'direct';
}

export class UserRoleDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: 'admin' })
  name: string;

  @ApiProperty({ example: 'web' })
  guard_name: string;
}

export class UserPermissionsResponseDto {
  @ApiProperty({ type: UserRoleDto, nullable: true })
  role: UserRoleDto | null;

  @ApiProperty({ type: [UserPermissionDto] })
  permissions: UserPermissionDto[];

  @ApiProperty({ 
    example: ['Dashboard', 'Usuarios', 'Plantas'], 
    description: 'Lista simplificada dos nomes das permissões' 
  })
  permissionNames: string[];
}

export class UserPermissionsSummaryDto {
  @ApiProperty({ example: 'admin', nullable: true })
  role: string | null;

  @ApiProperty({ example: 15 })
  totalPermissions: number;

  @ApiProperty({ example: 12 })
  rolePermissions: number;

  @ApiProperty({ example: 3 })
  directPermissions: number;

  @ApiProperty({ example: ['Dashboard', 'Gestão', 'Comercial'] })
  categories: string[];
}

export class CategorizedPermissionsDto {
  [category: string]: UserPermissionDto[];
}