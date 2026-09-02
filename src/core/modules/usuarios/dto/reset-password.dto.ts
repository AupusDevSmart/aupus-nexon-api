// src/modules/usuarios/dto/reset-password.dto.ts
import { IsString, MinLength, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ResetPasswordDto {
  @ApiProperty({ 
    description: 'Nova senha (mínimo 6 caracteres)'
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(6)
  novaSenha: string;

  @ApiProperty({ 
    description: 'Confirmação da nova senha'
  })
  @IsString()
  @IsNotEmpty()
  confirmarSenha: string;
}