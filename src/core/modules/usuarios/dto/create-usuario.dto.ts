// src/modules/usuarios/dto/create-usuario.dto.ts - ATUALIZADO
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEmail,
  IsEnum,
  IsArray,
  IsNumber,
  IsPositive,
  Length,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export enum UsuarioStatus {
  ATIVO = 'Ativo',
  INATIVO = 'Inativo',
}

export enum UsuarioRole {
  SUPER_ADMIN = 'super-admin',
  ADMIN = 'admin',
  CATIVO = 'cativo',
  PROPIETARIO = 'propietario',
  LOCATARIO = 'associado',
  AUPUS = 'aupus',
  OPERADOR = 'operador',  // Novo tipo - criado por proprietários
}

export type Permissao =
  | 'MonitoramentoConsumo'
  | 'GeracaoEnergia'
  | 'GestaoOportunidades'
  | 'Financeiro'
  | 'Oportunidades'
  | 'Prospeccao'
  | 'ProspeccaoListagem'
  | 'MonitoramentoClientes'
  | 'ClubeAupus'
  | 'Usuarios'
  | 'Organizacoes'
  | 'AreaDoProprietario'
  | 'UnidadesConsumidoras'
  | 'Configuracoes'
  | 'AreaDoAssociado'
  | 'Documentos'
  | 'Associados'
  | 'MinhasUsinas'
  | 'Dashboard'
  | 'Proprietarios'
  | 'Equipamentos'
  | 'Plantas';

export class CreateUsuarioDto {
  @ApiProperty({
    description: 'Nome completo do usuário',
    example: 'João Silva Santos'
  })
  @IsString({ message: 'Nome deve ser uma string' })
  @IsNotEmpty({ message: 'Nome não pode estar vazio' })
  @Length(2, 255, { message: 'Nome deve ter entre 2 e 255 caracteres' })
  nome: string;

  @ApiProperty({ 
    description: 'Email do usuário',
    example: 'joao.silva@email.com'
  })
  @IsEmail()
  @IsNotEmpty()
  @Length(5, 255)
  email: string;

  @ApiPropertyOptional({ 
    description: 'Telefone do usuário',
    example: '(11) 99999-9999'
  })
  @IsOptional()
  @IsString()
  @Length(10, 20)
  telefone?: string;

  @ApiPropertyOptional({ 
    description: 'Instagram do usuário',
    example: '@joaosilva'
  })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  instagram?: string;

  @ApiProperty({ 
    description: 'Status do usuário',
    enum: UsuarioStatus,
    default: UsuarioStatus.ATIVO
  })
  @IsEnum(UsuarioStatus)
  status: UsuarioStatus = UsuarioStatus.ATIVO;

  @ApiPropertyOptional({ 
    description: 'CPF ou CNPJ do usuário',
    example: '123.456.789-10'
  })
  @IsOptional()
  @IsString()
  @Length(11, 18)
  cpfCnpj?: string;

  @ApiPropertyOptional({ 
    description: 'Cidade do usuário',
    example: 'São Paulo'
  })
  @IsOptional()
  @IsString()
  @Length(2, 255)
  cidade?: string;

  @ApiPropertyOptional({ 
    description: 'Estado do usuário',
    example: 'SP'
  })
  @IsOptional()
  @IsString()
  @Length(2, 255)
  estado?: string;

  @ApiPropertyOptional({ 
    description: 'Endereço do usuário',
    example: 'Rua das Flores, 123'
  })
  @IsOptional()
  @IsString()
  @Length(5, 255)
  endereco?: string;

  @ApiPropertyOptional({ 
    description: 'CEP do usuário',
    example: '01234-567'
  })
  @IsOptional()
  @IsString()
  cep?: string;

  @ApiPropertyOptional({ 
    description: 'ID da concessionária atual',
    example: 'concess-uuid-here'
  })
  @IsOptional()
  @IsString()
  @Length(26, 26)
  concessionariaAtualId?: string;

  @ApiPropertyOptional({ 
    description: 'ID da organização atual',
    example: 'org-uuid-here'
  })
  @IsOptional()
  @IsString()
  @Length(26, 26)
  organizacaoAtualId?: string;

  @ApiPropertyOptional({
    description: 'ID do gerente responsável',
    example: 'manager-uuid-here'
  })
  @IsOptional()
  @IsString()
  @Length(36, 36)
  managerId?: string;

  @ApiPropertyOptional({
    description: 'ID do usuário que criou este usuário (proprietário que criou o operador)',
    example: 'creator-uuid-here'
  })
  @IsOptional()
  @IsString()
  @Length(26, 26)
  createdBy?: string;

  // ============================================================================
  // CAMPOS DO SISTEMA HÍBRIDO DE ROLES E PERMISSIONS
  // ============================================================================

  @ApiPropertyOptional({ 
    description: 'ID da role principal a ser atribuída',
    example: 2
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  roleId?: number;

  @ApiPropertyOptional({ 
    description: 'Array de IDs das permissões diretas',
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
    description: 'Array de permissões do usuário (deprecated - use permissionIds)',
    type: 'array',
    items: { type: 'string' },
    example: ['Dashboard', 'Usuarios', 'MonitoramentoConsumo']
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissions?: Permissao[];

  @ApiPropertyOptional({
    description: 'Array de roles do usuário (deprecated - use roleId)',
    type: 'array',
    items: { type: 'string' },
    example: ['admin', 'propietario']
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  roleNames?: string[];
}