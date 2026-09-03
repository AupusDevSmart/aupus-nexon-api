import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * DTO para renovação de token
 */
export class RefreshTokenDto {
  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    description: 'Refresh token obtido no login',
  })
  @IsString()
  @IsNotEmpty({ message: 'Refresh token é obrigatório' })
  refresh_token: string;
}
