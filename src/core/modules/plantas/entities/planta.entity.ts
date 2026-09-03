// src/modules/plantas/entities/planta.entity.ts
import { ApiProperty } from '@nestjs/swagger';

export class ProprietarioBasico {
  @ApiProperty({ example: 'usr_empresa_abc_01234567890', description: 'ID do proprietário' })
  id: string;

  @ApiProperty({ example: 'Empresa ABC Ltda', description: 'Nome/Razão social do proprietário' })
  nome: string;

  @ApiProperty({ example: '12.345.678/0001-90', description: 'CPF/CNPJ do proprietário' })
  cpf_cnpj?: string;

  @ApiProperty({ 
    example: 'pessoa_juridica', 
    enum: ['pessoa_fisica', 'pessoa_juridica'],
    description: 'Tipo do proprietário baseado no CPF/CNPJ' 
  })
  tipo: 'pessoa_fisica' | 'pessoa_juridica';
}

export class Endereco {
  @ApiProperty({ example: 'Av. Industrial, 1000', description: 'Logradouro completo' })
  logradouro: string;

  @ApiProperty({ example: 'Distrito Industrial', description: 'Bairro' })
  bairro?: string;

  @ApiProperty({ example: 'São Paulo', description: 'Cidade' })
  cidade: string;

  @ApiProperty({ example: 'SP', description: 'UF' })
  uf: string;

  @ApiProperty({ example: '01234-567', description: 'CEP' })
  cep: string;
}

export class Planta {
  @ApiProperty({ example: 'plt_01234567890123456789012345', description: 'ID único da planta' })
  id: string;

  @ApiProperty({ example: 'Planta Industrial São Paulo', description: 'Nome da planta' })
  nome: string;

  @ApiProperty({ example: '12.345.678/0001-90', description: 'CNPJ da planta' })
  cnpj: string;

  @ApiProperty({ example: 'Zona Sul - Galpão Principal', description: 'Localização específica' })
  localizacao: string;

  @ApiProperty({ example: '06:00 às 22:00', description: 'Horário de funcionamento' })
  horarioFuncionamento: string;

  @ApiProperty({ example: '123456789', description: 'Número da Unidade Consumidora', required: false })
  numeroUc?: string;

  @ApiProperty({ type: Endereco, description: 'Endereço completo' })
  endereco: Endereco;

  @ApiProperty({ example: 'usr_empresa_abc_01234567890', description: 'ID do proprietário' })
  proprietarioId: string;

  @ApiProperty({ type: ProprietarioBasico, description: 'Dados básicos do proprietário' })
  proprietario?: ProprietarioBasico;

  @ApiProperty({ example: '2024-01-15T10:30:00.000Z', description: 'Data de criação' })
  criadoEm: Date;

  @ApiProperty({ example: '2024-01-15T10:30:00.000Z', description: 'Data da última atualização' })
  atualizadoEm: Date;
}