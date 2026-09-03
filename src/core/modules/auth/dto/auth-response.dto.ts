import { ApiProperty } from '@nestjs/swagger';
import { UsuarioResponseDto } from '../../usuarios/dto/usuario-response.dto';

/**
 * DTO de resposta de autenticação
 * Retornado após login bem-sucedido
 */
export class AuthResponseDto {
  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    description: 'Token de acesso JWT',
  })
  access_token: string;

  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    description: 'Token de renovação (refresh token)',
  })
  refresh_token: string;

  @ApiProperty({
    example: 'Bearer',
    description: 'Tipo do token',
  })
  token_type: string;

  @ApiProperty({
    example: 3600,
    description: 'Tempo de expiração do access_token em segundos',
  })
  expires_in: number;

  @ApiProperty({
    type: () => UsuarioResponseDto,
    description: 'Dados do usuário autenticado',
  })
  user: UsuarioResponseDto;
}
