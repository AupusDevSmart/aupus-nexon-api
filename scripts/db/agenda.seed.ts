import { PrismaClient, TipoFeriado } from '@aupus/api-shared';

const prisma = new PrismaClient();

export async function seedAgenda() {
  console.log('📅 Seeding agenda (feriados e configurações de dias úteis)...');

  // Buscar plantas existentes
  const plantas = await prisma.plantas.findMany({
    select: { id: true, nome: true, cidade: true }
  });

  if (plantas.length === 0) {
    console.log('❌ Nenhuma planta encontrada. Execute o seed de plantas primeiro.');
    return;
  }

  console.log(`✅ Encontradas ${plantas.length} plantas para configuração da agenda`);

  // Limpar dados existentes da agenda
  await prisma.feriado_plantas.deleteMany();
  await prisma.configuracao_plantas.deleteMany();
  await prisma.feriados.deleteMany();
  await prisma.configuracoes_dias_uteis.deleteMany();

  // ==================== FERIADOS ====================

  console.log('📅 Criando feriados...');

  // Feriados Nacionais (Gerais)
  const feriadosNacionais = [
    {
      nome: 'Confraternização Universal',
      data: new Date('2024-01-01'),
      tipo: TipoFeriado.NACIONAL,
      geral: true,
      recorrente: true,
      descricao: 'Ano Novo - Feriado Nacional'
    },
    {
      nome: 'Tiradentes',
      data: new Date('2024-04-21'),
      tipo: TipoFeriado.NACIONAL,
      geral: true,
      recorrente: true,
      descricao: 'Dia de Tiradentes - Feriado Nacional'
    },
    {
      nome: 'Dia do Trabalho',
      data: new Date('2024-05-01'),
      tipo: TipoFeriado.NACIONAL,
      geral: true,
      recorrente: true,
      descricao: 'Dia do Trabalhador - Feriado Nacional'
    },
    {
      nome: 'Independência do Brasil',
      data: new Date('2024-09-07'),
      tipo: TipoFeriado.NACIONAL,
      geral: true,
      recorrente: true,
      descricao: 'Dia da Independência - Feriado Nacional'
    },
    {
      nome: 'Nossa Senhora Aparecida',
      data: new Date('2024-10-12'),
      tipo: TipoFeriado.NACIONAL,
      geral: true,
      recorrente: true,
      descricao: 'Padroeira do Brasil - Feriado Nacional'
    },
    {
      nome: 'Finados',
      data: new Date('2024-11-02'),
      tipo: TipoFeriado.NACIONAL,
      geral: true,
      recorrente: true,
      descricao: 'Dia de Finados - Feriado Nacional'
    },
    {
      nome: 'Proclamação da República',
      data: new Date('2024-11-15'),
      tipo: TipoFeriado.NACIONAL,
      geral: true,
      recorrente: true,
      descricao: 'Proclamação da República - Feriado Nacional'
    },
    {
      nome: 'Natal',
      data: new Date('2024-12-25'),
      tipo: TipoFeriado.NACIONAL,
      geral: true,
      recorrente: true,
      descricao: 'Nascimento de Jesus Cristo - Feriado Nacional'
    }
  ];

  const feriadosNacionaisCriados = [];
  for (const feriado of feriadosNacionais) {
    const feriadoCriado = await prisma.feriados.create({ data: feriado });
    feriadosNacionaisCriados.push(feriadoCriado);
  }

  console.log(`✅ Criados ${feriadosNacionaisCriados.length} feriados nacionais (gerais)`);

  // Feriados Estaduais/Municipais (Específicos por planta)
  const feriadosEspecificos = [];

  // Feriados de São Paulo (para plantas de SP)
  const plantasSP = plantas.filter(p => p.cidade.includes('São Paulo') || p.cidade.includes('Guarulhos'));
  if (plantasSP.length > 0) {
    const feriadosSP = [
      {
        nome: 'Revolução Constitucionalista',
        data: new Date('2024-07-09'),
        tipo: TipoFeriado.ESTADUAL,
        geral: false,
        recorrente: true,
        descricao: 'Revolução de 1932 - Feriado Estadual de São Paulo'
      },
      {
        nome: 'Aniversário de São Paulo',
        data: new Date('2024-01-25'),
        tipo: TipoFeriado.MUNICIPAL,
        geral: false,
        recorrente: true,
        descricao: 'Aniversário da cidade de São Paulo'
      }
    ];

    for (const feriado of feriadosSP) {
      const feriadoCriado = await prisma.feriados.create({ data: feriado });
      feriadosEspecificos.push({ feriado: feriadoCriado, plantas: plantasSP });
    }
  }

  // Feriados do Rio de Janeiro
  const plantasRJ = plantas.filter(p => p.cidade.includes('Rio'));
  if (plantasRJ.length > 0) {
    const feriadosRJ = [
      {
        nome: 'São Jorge',
        data: new Date('2024-04-23'),
        tipo: TipoFeriado.ESTADUAL,
        geral: false,
        recorrente: true,
        descricao: 'Dia de São Jorge - Feriado Estadual do Rio de Janeiro'
      },
      {
        nome: 'Morte de Zumbi dos Palmares',
        data: new Date('2024-11-20'),
        tipo: TipoFeriado.ESTADUAL,
        geral: false,
        recorrente: true,
        descricao: 'Consciência Negra - Feriado Estadual do Rio de Janeiro'
      }
    ];

    for (const feriado of feriadosRJ) {
      const feriadoCriado = await prisma.feriados.create({ data: feriado });
      feriadosEspecificos.push({ feriado: feriadoCriado, plantas: plantasRJ });
    }
  }

  // Feriados de Minas Gerais
  const plantasMG = plantas.filter(p => p.cidade.includes('Belo Horizonte'));
  if (plantasMG.length > 0) {
    const feriadosMG = [
      {
        nome: 'Tiradentes - MG',
        data: new Date('2024-04-21'),
        tipo: TipoFeriado.ESTADUAL,
        geral: false,
        recorrente: true,
        descricao: 'Tiradentes - Herói mineiro - Feriado Estadual de MG'
      }
    ];

    for (const feriado of feriadosMG) {
      const feriadoCriado = await prisma.feriados.create({ data: feriado });
      feriadosEspecificos.push({ feriado: feriadoCriado, plantas: plantasMG });
    }
  }

  // Criar relacionamentos feriado-plantas para feriados específicos
  let totalRelacionamentosFeriados = 0;
  for (const { feriado, plantas: plantasRelacionadas } of feriadosEspecificos) {
    const relacionamentos = plantasRelacionadas.map(planta => ({
      feriado_id: feriado.id,
      planta_id: planta.id
    }));

    await prisma.feriado_plantas.createMany({ data: relacionamentos });
    totalRelacionamentosFeriados += relacionamentos.length;
  }

  console.log(`✅ Criados ${feriadosEspecificos.length} feriados específicos com ${totalRelacionamentosFeriados} relacionamentos`);

  // ==================== CONFIGURAÇÕES DE DIAS ÚTEIS ====================

  console.log('⚙️ Criando configurações de dias úteis...');

  // Configuração Geral (Segunda a Sexta)
  const configGeralComercial = await prisma.configuracoes_dias_uteis.create({
    data: {
      nome: 'Horário Comercial Padrão',
      descricao: 'Configuração padrão para empresas: Segunda a Sexta-feira',
      segunda: true,
      terca: true,
      quarta: true,
      quinta: true,
      sexta: true,
      sabado: false,
      domingo: false,
      geral: true,
      ativo: true
    }
  });

  console.log(`✅ Configuração geral criada: ${configGeralComercial.nome}`);

  // Configurações específicas
  const configIndustrial = await prisma.configuracoes_dias_uteis.create({
    data: {
      nome: 'Operação Industrial 24h',
      descricao: 'Para plantas industriais que operam todos os dias da semana',
      segunda: true,
      terca: true,
      quarta: true,
      quinta: true,
      sexta: true,
      sabado: true,
      domingo: true,
      geral: false,
      ativo: true
    }
  });

  // Associar plantas industriais (que têm "Industrial" no nome)
  const plantasIndustriais = plantas.filter(p =>
    p.nome.toLowerCase().includes('industrial') ||
    p.nome.toLowerCase().includes('distribuição')
  );

  if (plantasIndustriais.length > 0) {
    const relacionamentosIndustriais = plantasIndustriais.map(planta => ({
      configuracao_id: configIndustrial.id,
      planta_id: planta.id
    }));

    await prisma.configuracao_plantas.createMany({ data: relacionamentosIndustriais });
    console.log(`✅ Configuração industrial associada a ${plantasIndustriais.length} plantas`);
  }

  // Configuração para oficinas (Segunda a Sábado)
  const configOficinas = await prisma.configuracoes_dias_uteis.create({
    data: {
      nome: 'Horário Oficinas',
      descricao: 'Para oficinas e serviços: Segunda a Sábado',
      segunda: true,
      terca: true,
      quarta: true,
      quinta: true,
      sexta: true,
      sabado: true,
      domingo: false,
      geral: false,
      ativo: true
    }
  });

  // Associar plantas que são oficinas
  const plantasOficinas = plantas.filter(p =>
    p.nome.toLowerCase().includes('oficina') ||
    p.nome.toLowerCase().includes('manutenção')
  );

  if (plantasOficinas.length > 0) {
    const relacionamentosOficinas = plantasOficinas.map(planta => ({
      configuracao_id: configOficinas.id,
      planta_id: planta.id
    }));

    await prisma.configuracao_plantas.createMany({ data: relacionamentosOficinas });
    console.log(`✅ Configuração de oficinas associada a ${plantasOficinas.length} plantas`);
  }

  // Resumo final
  const totalFeriados = await prisma.feriados.count();
  const totalConfiguracoes = await prisma.configuracoes_dias_uteis.count();
  const totalRelacionamentosFeriadosTotal = await prisma.feriado_plantas.count();
  const totalRelacionamentosConfiguracoes = await prisma.configuracao_plantas.count();

  console.log('\n📊 RESUMO DA AGENDA:');
  console.log(`   📅 ${totalFeriados} feriados criados`);
  console.log(`   ⚙️ ${totalConfiguracoes} configurações de dias úteis criadas`);
  console.log(`   🔗 ${totalRelacionamentosFeriadosTotal} relacionamentos feriado-planta`);
  console.log(`   🔗 ${totalRelacionamentosConfiguracoes} relacionamentos configuração-planta`);
  console.log('✅ Seed da agenda concluído com sucesso!\n');
}

// Executar seed se arquivo for chamado diretamente
if (require.main === module) {
  seedAgenda()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}