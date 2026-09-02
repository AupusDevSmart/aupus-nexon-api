// src/modules/usuarios/dto/usuario-response.dto.ts - NOVO ARQUIVO
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UsuarioStatus } from './create-usuario.dto';

export interface UserPermissionResponse {
  id: number;
  name: string;
  guard_name: string;
  source: 'role' | 'direct';
}

export interface UserRoleResponse {
  id: number;
  name: string;
  guard_name: string;
}

export class UsuarioResponseDto {
  @ApiProperty({ description: 'ID único do usuário' })
  id: string;

  @ApiProperty({ description: 'Status do usuário', enum: UsuarioStatus })
  status: UsuarioStatus;

  @ApiPropertyOptional({ description: 'ID da concessionária atual' })
  concessionaria_atual_id?: string;

  @ApiPropertyOptional({ description: 'ID da organização atual' })
  organizacao_atual?: string;

  @ApiProperty({ description: 'Nome completo do usuário' })
  nome: string;

  @ApiProperty({ description: 'Email do usuário' })
  email: string;

  @ApiPropertyOptional({ description: 'Telefone do usuário' })
  telefone?: string;

  @ApiPropertyOptional({ description: 'Instagram do usuário' })
  instagram?: string;

  @ApiPropertyOptional({ description: 'CPF ou CNPJ do usuário' })
  cpf_cnpj?: string;

  @ApiPropertyOptional({ description: 'Cidade do usuário' })
  cidade?: string;

  @ApiPropertyOptional({ description: 'Estado do usuário' })
  estado?: string;

  @ApiPropertyOptional({ description: 'Endereço do usuário' })
  endereco?: string;

  @ApiPropertyOptional({ description: 'CEP do usuário' })
  cep?: string;

  @ApiPropertyOptional({ description: 'ID do gerente responsável' })
  manager_id?: string;

  @ApiPropertyOptional({ description: 'URL da foto de perfil do usuário' })
  avatar_url?: string;

  @ApiPropertyOptional({
    description: 'Role do usuário (coluna usuarios.role)',
    example: 'admin'
  })
  role?: string;

  @ApiProperty({
    description: 'Permissões do usuário (objetos completos)',
    type: 'array',
    example: [
      { id: 1, name: 'Dashboard', guard_name: 'web', source: 'role' },
      { id: 5, name: 'Configuracoes', guard_name: 'web', source: 'direct' }
    ]
  })
  all_permissions: UserPermissionResponse[];

  @ApiProperty({
    description: 'Roles do usuário (nomes)',
    type: [String],
    example: ['admin']
  })
  roles: string[];

  @ApiPropertyOptional({ 
    description: 'Role detalhada do usuário (sistema Spatie)',
    example: { id: 1, name: 'admin', guard_name: 'web' }
  })
  role_details?: UserRoleResponse;

  @ApiProperty({ description: 'Data de criação' })
  created_at: Date;

  @ApiProperty({ description: 'Data de última atualização' })
  updated_at: Date;

  // Campos adicionais para resposta de criação
  @ApiPropertyOptional({ description: 'Senha temporária (apenas na criação)' })
  senhaTemporaria?: string;

  @ApiPropertyOptional({ description: 'Indica se é primeiro acesso (apenas na criação)' })
  primeiroAcesso?: boolean;
}