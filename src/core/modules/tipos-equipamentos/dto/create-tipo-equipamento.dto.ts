import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateTipoEquipamentoDto {
  @IsNotEmpty({ message: 'O código é obrigatório' })
  @IsString({ message: 'O código deve ser uma string' })
  @MaxLength(50, { message: 'O código deve ter no máximo 50 caracteres' })
  codigo: string;

  @IsNotEmpty({ message: 'O nome é obrigatório' })
  @IsString({ message: 'O nome deve ser uma string' })
  @MaxLength(100, { message: 'O nome deve ter no máximo 100 caracteres' })
  nome: string;

  @IsNotEmpty({ message: 'A categoria é obrigatória' })
  @IsString({ message: 'O ID da categoria deve ser uma string válida' })
  categoriaId: string;

  @IsNotEmpty({ message: 'O fabricante é obrigatório' })
  @IsString({ message: 'O fabricante deve ser uma string' })
  @MaxLength(100, { message: 'O fabricante deve ter no máximo 100 caracteres' })
  fabricante: string;
}
