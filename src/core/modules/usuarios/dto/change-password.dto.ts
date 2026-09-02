// src/modules/usuarios/dto/change-password.dto.ts
import { IsString, IsNotEmpty, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ChangePasswordDto {
  @ApiProperty({ 
    description: 'Senha atual do usuário'
  })
  @IsString()
  @IsNotEmpty()
  senhaAtual: string;

  @ApiProperty({ 
    description: 'Nova senha (mínimo 6 caracteres)'
  })
  @IsString()
  @MinLength(6)
  novaSenha: string;
}