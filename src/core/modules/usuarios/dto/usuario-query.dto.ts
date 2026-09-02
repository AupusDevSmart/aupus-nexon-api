// src/modules/usuarios/dto/usuario-query.dto.ts - NOVO ARQUIVO
import { IsOptional, IsString, IsNumber, IsEnum, IsArray, IsBoolean } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { UsuarioStatus, Permissao } from './create-usuario.dto';

export class UsuarioQueryDto {
  @ApiPropertyOptional({ 
    description: 'Número da página',
    example: 1,
    default: 1
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  page?: number = 1;

  @ApiPropertyOptional({ 
    description: 'Itens por página',
    example: 10,
    default: 10
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number = 10;

  @ApiPropertyOptional({ 
    description: 'Buscar por nome, email, telefone ou CPF/CNPJ',
    example: 'João Silva'
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ 
    description: 'Filtrar por status',
    enum: UsuarioStatus
  })
  @IsOptional()
  @IsEnum(UsuarioStatus)
  status?: UsuarioStatus;

  @ApiPropertyOptional({
    description: 'Filtrar por role (coluna legacy)',
    example: 'admin'
  })
  @IsOptional()
  @IsString()
  role?: string;

  @ApiPropertyOptional({
    description: 'Filtrar por múltiplas roles (coluna legacy) - comma-separated',
    example: 'admin,gerente,proprietario'
  })
  @IsOptional()
  @IsString()
  roles?: string;

  @ApiPropertyOptional({
    description: 'Filtrar por ID da role (sistema Spatie)',
    example: 2
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  roleId?: number;

  @ApiPropertyOptional({ 
    description: 'Filtrar por cidade',
    example: 'São Paulo'
  })
  @IsOptional()
  @IsString()
  cidade?: string;

  @ApiPropertyOptional({ 
    description: 'Filtrar por estado',
    example: 'SP'
  })
  @IsOptional()
  @IsString()
  estado?: string;

  @ApiPropertyOptional({ 
    description: 'Filtrar por ID da concessionária',
    example: 'concess-uuid-here'
  })
  @IsOptional()
  @IsString()
  concessionariaId?: string;

  @ApiPropertyOptional({ 
    description: 'Filtrar por ID da organização',
    example: 'org-uuid-here'
  })
  @IsOptional()
  @IsString()
  organizacaoId?: string;

  @ApiPropertyOptional({ 
    description: 'Incluir usuários inativos na busca',
    example: false,
    default: false
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeInactive?: boolean = false;

  @ApiPropertyOptional({ 
    description: 'Filtrar por permissões (deprecated)',
    type: [String]
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissions?: Permissao[];

  @ApiPropertyOptional({ 
    description: 'Filtrar por IDs de permissões',
    example: [1, 3, 5],
    type: [Number]
  })
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsNumber({}, { each: true })
  permissionIds?: number[];
}