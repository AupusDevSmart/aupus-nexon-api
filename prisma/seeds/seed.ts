// prisma/seed.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Iniciando seed dos dados...');

  // Limpar apenas plantas (não mexer em usuários existentes)
  await prisma.plantas.deleteMany();

  // Verificar se existem usuários ou criar alguns para exemplo
  const usuariosCount = await prisma.usuarios.count();
  
  let usuariosProprietarios;
  
  if (usuariosCount === 0) {
    console.log('📝 Criando usuários proprietários de exemplo...');
    
    // Criar usuários proprietários se não existirem
    await prisma.usuarios.createMany({
      data: [
        {
          id: 'usr_empresa_abc_01234567890',
          nome: 'Empresa ABC Ltda',
          email: 'contato@empresaabc.com.br',
          cpf_cnpj: '12.345.678/0001-90',
          role: 'proprietario',
          status: 'Ativo',
          is_active: true,
          cidade: 'São Paulo',
          estado: 'SP',
        },
        {
          id: 'usr_joao_silva_12345678900',
          nome: 'João Silva',
          email: 'joao.silva@email.com',
          cpf_cnpj: '123.456.789-00',
          role: 'proprietario',
          status: 'Ativo',
          is_active: true,
          cidade: 'Campinas',
          estado: 'SP',
        },
        {
          id: 'usr_maria_santos_98765432001',
          nome: 'Maria Santos Consultoria ME',
          email: 'contato@mariasantos.com.br',
          cpf_cnpj: '98.765.432/0001-10',
          role: 'proprietario',
          status: 'Ativo',
          is_active: true,
          cidade: 'Rio de Janeiro',
          estado: 'RJ',
        },
        {
          id: 'usr_tech_solutions_1122233',
          nome: 'Tech Solutions Ltda',
          email: 'contato@techsolutions.com.br',
          cpf_cnpj: '11.222.333/0001-44',
          role: 'proprietario',
          status: 'Ativo',
          is_active: true,
          cidade: 'Belo Horizonte',
          estado: 'MG',
        },
        {
          id: 'usr_ana_costa_98765432100',
          nome: 'Ana Costa',
          email: 'ana.costa@email.com',
          cpf_cnpj: '987.654.321-00',
          role: 'proprietario',
          status: 'Ativo',
          is_active: true,
          cidade: 'Guarulhos',
          estado: 'SP',
        },
        {
          id: 'usr_industria_xyz_5566677',
          nome: 'Indústria XYZ S.A.',
          email: 'contato@industriaxyz.com.br',
          cpf_cnpj: '55.666.777/0001-88',
          role: 'proprietario',
          status: 'Ativo',
          is_active: true,
          cidade: 'São Bernardo do Campo',
          estado: 'SP',
        },
      ],
    });
    
    usuariosProprietarios = await prisma.usuarios.findMany({
      where: {
        role: 'proprietario'
      }
    });
  } else {
    // Buscar usuários existentes que podem ser proprietários
    usuariosProprietarios = await prisma.usuarios.findMany({
      where: {
        OR: [
          { role: 'proprietario' },
          { role: 'admin' },
          { role: 'manager' }
        ],
        is_active: true,
        deleted_at: null
      },
      take: 6 // Pegar até 6 usuários para as plantas exemplo
    });
  }

  if (usuariosProprietarios.length === 0) {
    console.log('❌ Nenhum usuário encontrado para ser proprietário');
    return;
  }

  console.log(`✅ Encontrados ${usuariosProprietarios.length} usuários proprietários`);

  // Criar plantas usando os usuários existentes
  const plantasData = [
    {
      nome: 'Planta Industrial São Paulo',
      cnpj: '12.345.678/0001-90',
      localizacao: 'Zona Sul - Galpão Principal',
      horario_funcionamento: '06:00 às 22:00',
      logradouro: 'Av. Industrial, 1000',
      bairro: 'Distrito Industrial',
      cidade: 'São Paulo',
      uf: 'SP',
      cep: '01234-567',
      proprietario_id: usuariosProprietarios[0].id,
    },
    {
      nome: 'Centro de Distribuição Rio',
      cnpj: '98.765.432/0001-10',
      localizacao: 'Porto - Armazém 3',
      horario_funcionamento: '24 horas',
      logradouro: 'Rua do Porto, 500',
      bairro: 'Porto Maravilha',
      cidade: 'Rio de Janeiro',
      uf: 'RJ',
      cep: '20000-123',
      proprietario_id: usuariosProprietarios[1] ? usuariosProprietarios[1].id : usuariosProprietarios[0].id,
    },
    {
      nome: 'Unidade Administrativa BH',
      cnpj: '11.222.333/0001-44',
      localizacao: 'Centro - Edifício Comercial',
      horario_funcionamento: '08:00 às 18:00',
      logradouro: 'Av. Afonso Pena, 3000',
      bairro: 'Centro',
      cidade: 'Belo Horizonte',
      uf: 'MG',
      cep: '30000-456',
      proprietario_id: usuariosProprietarios[2] ? usuariosProprietarios[2].id : usuariosProprietarios[0].id,
    },
    {
      nome: 'Oficina João Silva',
      cnpj: '55.666.777/0001-88',
      localizacao: 'Zona Norte - Oficina Principal',
      horario_funcionamento: '07:00 às 17:00',
      logradouro: 'Rua das Oficinas, 200',
      bairro: 'Vila Industrial',
      cidade: 'Campinas',
      uf: 'SP',
      cep: '13000-789',
      proprietario_id: usuariosProprietarios[3] ? usuariosProprietarios[3].id : usuariosProprietarios[0].id,
    },
  ];

  for (const plantaData of plantasData) {
    await prisma.plantas.create({
      data: plantaData
    });
  }

  console.log(`✅ Criadas ${plantasData.length} plantas`);
  console.log('🎉 Seed concluído com sucesso!');
}

main()
  .catch((e) => {
    console.error('❌ Erro no seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });