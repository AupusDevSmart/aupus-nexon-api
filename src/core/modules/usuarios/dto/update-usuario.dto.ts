// src/modules/usuarios/dto/update-usuario.dto.ts - CORRIGIDO
import { PartialType } from '@nestjs/swagger';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsNumber, IsPositive, IsArray, IsBoolean } from 'class-validator';
import { Type } from 'class-transformer';
import { CreateUsuarioDto } from './create-usuario.dto';

export class UpdateUsuarioDto extends PartialType(CreateUsuarioDto) {
  // ============================================================================
  // CAMPOS ESPECÍFICOS PARA UPDATE COM SISTEMA HÍBRIDO
  // ============================================================================

  @ApiPropertyOptional({ 
    description: 'ID da role a ser atribuída (substitui role atual)',
    example: 2
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  roleId?: number;

  @ApiPropertyOptional({ 
    description: 'Array de IDs das permissões diretas (substitui todas as permissões diretas atuais)',
    example: [1, 3, 5, 7],
    type: [Number]
  })
  @IsOptional()
  @IsArray()
  @IsNumber({}, { each: true })
  @IsPositive({ each: true })
  @Type(() => Number)
  permissionIds?: number[];

  @ApiPropertyOptional({ 
    description: 'Se true, remove todas as permissões diretas do usuário',
    example: false
  })
  @IsOptional()
  @IsBoolean()
  clearDirectPermissions?: boolean;

  @ApiPropertyOptional({ 
    description: 'Se true, remove a role atual do usuário',
    example: false
  })
  @IsOptional()
  @IsBoolean()
  clearRole?: boolean;
}