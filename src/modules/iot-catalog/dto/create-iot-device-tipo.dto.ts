import { IsNotEmpty, IsObject, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class CreateIotDeviceTipoDto {
  @IsNotEmpty({ message: 'codigo eh obrigatorio' })
  @IsString()
  @MaxLength(50)
  @Matches(/^[a-z][a-z0-9_]*$/, {
    message: 'codigo deve ser snake_case (a-z, 0-9, _) comecando com letra',
  })
  codigo!: string;

  @IsNotEmpty({ message: 'nome eh obrigatorio' })
  @IsString()
  @MaxLength(100)
  nome!: string;

  /**
   * Shape: { ai: Point[], bi: Point[], bo: Point[], group_order?, publish? }
   * Validacao estrutural mais profunda fica a cargo da UI.
   */
  @IsOptional()
  @IsObject({ message: 'pontos deve ser um objeto' })
  pontos?: Record<string, unknown>;
}
