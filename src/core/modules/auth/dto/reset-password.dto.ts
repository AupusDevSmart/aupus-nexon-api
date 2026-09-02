import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * DTO para concluir a redefinicao de senha via token enviado por email.
 */
export class ResetPasswordWithTokenDto {
  @ApiProperty({ description: 'Email da conta' })
  @IsEmail({}, { message: 'Email invalido' })
  @IsNotEmpty({ message: 'Email e obrigatorio' })
  email: string;

  @ApiProperty({ description: 'Token recebido no link do email' })
  @IsString()
  @IsNotEmpty({ message: 'Token e obrigatorio' })
  token: string;

  @ApiProperty({ description: 'Nova senha (minimo 6 caracteres)' })
  @IsString()
  @IsNotEmpty({ message: 'Nova senha e obrigatoria' })
  @MinLength(6, { message: 'A senha deve ter no minimo 6 caracteres' })
  novaSenha: string;

  @ApiProperty({ description: 'Confirmacao da nova senha' })
  @IsString()
  @IsNotEmpty({ message: 'Confirmacao da senha e obrigatoria' })
  confirmarSenha: string;
}
