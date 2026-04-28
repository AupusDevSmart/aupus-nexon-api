// prisma/seeds/seed-planos-tarefas.ts
import { PrismaClient, StatusPlano, StatusTarefa, TipoManutencao, CategoriaTarefa, FrequenciaTarefa, CondicaoAtivo, TipoRecurso } from '@aupus/api-shared';

const prisma = new PrismaClient();

async function seedPlanosManutencao() {
  console.log('🌱 Seeding planos de manutenção e tarefas...');

  // Plano 1: Sistema de Controle Principal (UC)
  const plano1 = await prisma.planos_manutencao.create({
    data: {
      equipamento_id: 'cmesudng400012ffkncdeu6nl',
      nome: 'Manutenção Sistema de Controle SIMATIC S7-1500',
      descricao: 'Plano de manutenção preventiva e preditiva para o sistema de controle principal da planta industrial',
      versao: '1.0',
      status: StatusPlano.ATIVO,
      ativo: true,
      data_vigencia_inicio: new Date('2025-01-01'),
      data_vigencia_fim: new Date('2025-12-31'),
      observacoes: 'Plano crítico - equipamento essencial para operação',
      criado_por: '01K2CPBYE07B3HWW0CZHHB3ZCR' // Administrador
    }
  });

  // Tarefas do Plano 1
  await prisma.tarefas.createMany({
    data: [
      {
        plano_manutencao_id: plano1.id,
        equipamento_id: 'cmesudng400012ffkncdeu6nl',
        planta_id: 'cmekb23pr00012f4o4nqp9ypz',
        tag: 'SIS-INSP-001',
        nome: 'Inspeção Visual dos Módulos',
        descricao: 'Inspeção visual completa de todos os módulos do sistema SIMATIC S7-1500, verificando LEDs de status, conexões e integridade física',
        categoria: CategoriaTarefa.ELETRICA,
        tipo_manutencao: TipoManutencao.PREVENTIVA,
        frequencia: FrequenciaTarefa.SEMANAL,
        condicao_ativo: CondicaoAtivo.FUNCIONANDO,
        criticidade: 5,
        duracao_estimada: 1.5,
        tempo_estimado: 90,
        ordem: 1,
        responsavel: 'Técnico Eletricista',
        planejador: 'João Consultor',
        observacoes: 'Atenção especial aos LEDs de erro',
        status: StatusTarefa.ATIVA,
        ativo: true,
        criado_por: '01K2CPBZ7NZMAA5J9P30GVCYGD'
      },
      {
        plano_manutencao_id: plano1.id,
        equipamento_id: 'cmesudng400012ffkncdeu6nl',
        planta_id: 'cmekb23pr00012f4o4nqp9ypz',
        tag: 'SIS-LIMP-001',
        nome: 'Limpeza e Verificação de Conectores',
        descricao: 'Limpeza dos conectores e bornes, verificação do torque das conexões elétricas',
        categoria: CategoriaTarefa.LIMPEZA,
        tipo_manutencao: TipoManutencao.PREVENTIVA,
        frequencia: FrequenciaTarefa.MENSAL,
        condicao_ativo: CondicaoAtivo.PARADO,
        criticidade: 4,
        duracao_estimada: 2,
        tempo_estimado: 120,
        ordem: 2,
        responsavel: 'Técnico Eletricista',
        planejador: 'João Consultor',
        status: StatusTarefa.ATIVA,
        ativo: true,
        criado_por: '01K2CPBZ7NZMAA5J9P30GVCYGD'
      },
      {
        plano_manutencao_id: plano1.id,
        equipamento_id: 'cmesudng400012ffkncdeu6nl',
        planta_id: 'cmekb23pr00012f4o4nqp9ypz',
        tag: 'SIS-CAL-001',
        nome: 'Calibração de Sensores e Atuadores',
        descricao: 'Calibração completa de todos os sensores e atuadores conectados ao sistema',
        categoria: CategoriaTarefa.CALIBRACAO,
        tipo_manutencao: TipoManutencao.PREVENTIVA,
        frequencia: FrequenciaTarefa.TRIMESTRAL,
        condicao_ativo: CondicaoAtivo.PARADO,
        criticidade: 5,
        duracao_estimada: 4,
        tempo_estimado: 240,
        ordem: 3,
        responsavel: 'Instrumentista Senior',
        planejador: 'João Consultor',
        observacoes: 'Requerer certificado de calibração',
        status: StatusTarefa.ATIVA,
        ativo: true,
        criado_por: '01K2CPBZ7NZMAA5J9P30GVCYGD'
      }
    ]
  });

  // Plano 2: Transformador Principal
  const plano2 = await prisma.planos_manutencao.create({
    data: {
      equipamento_id: 'cmesudnop00032ffk5ma35abw',
      nome: 'Manutenção Transformador WEG TR-500-220',
      descricao: 'Plano de manutenção para transformador de alta criticidade, incluindo análises preditivas',
      versao: '1.2',
      status: StatusPlano.ATIVO,
      ativo: true,
      data_vigencia_inicio: new Date('2025-01-01'),
      observacoes: 'Transformador crítico - paradas devem ser programadas',
      criado_por: '01K2CPBYE07B3HWW0CZHHB3ZCR'
    }
  });

  // Tarefas do Plano 2
  await prisma.tarefas.createMany({
    data: [
      {
        plano_manutencao_id: plano2.id,
        equipamento_id: 'cmesudnop00032ffk5ma35abw',
        planta_id: 'cmekb23pr00012f4o4nqp9ypz',
        tag: 'TRF-OLEO-001',
        nome: 'Análise do Óleo Isolante',
        descricao: 'Coleta e análise do óleo isolante para verificação de qualidade, umidade e gases dissolvidos',
        categoria: CategoriaTarefa.INSPECAO,
        tipo_manutencao: TipoManutencao.PREDITIVA,
        frequencia: FrequenciaTarefa.SEMESTRAL,
        condicao_ativo: CondicaoAtivo.FUNCIONANDO,
        criticidade: 5,
        duracao_estimada: 1,
        tempo_estimado: 60,
        ordem: 1,
        responsavel: 'Técnico Eletricista',
        observacoes: 'Enviar amostra para laboratório credenciado',
        status: StatusTarefa.ATIVA,
        ativo: true,
        criado_por: '01K2CPBYE07B3HWW0CZHHB3ZCR'
      },
      {
        plano_manutencao_id: plano2.id,
        equipamento_id: 'cmesudnop00032ffk5ma35abw',
        planta_id: 'cmekb23pr00012f4o4nqp9ypz',
        tag: 'TRF-TERM-001',
        nome: 'Termografia Completa',
        descricao: 'Termografia de todos os componentes do transformador e conexões externas',
        categoria: CategoriaTarefa.INSPECAO,
        tipo_manutencao: TipoManutencao.PREDITIVA,
        frequencia: FrequenciaTarefa.BIMESTRAL,
        condicao_ativo: CondicaoAtivo.FUNCIONANDO,
        criticidade: 4,
        duracao_estimada: 2,
        tempo_estimado: 120,
        ordem: 2,
        responsavel: 'Termografista',
        status: StatusTarefa.ATIVA,
        ativo: true,
        criado_por: '01K2CPBYE07B3HWW0CZHHB3ZCR'
      }
    ]
  });

  // Plano 3: Sistema de Refrigeração
  const plano3 = await prisma.planos_manutencao.create({
    data: {
      equipamento_id: 'cmesudnzl00072ffkkc5uoidk',
      nome: 'Manutenção Sistema Refrigeração Carrier',
      descricao: 'Plano de manutenção preventiva para sistema de refrigeração da câmara fria',
      versao: '1.0',
      status: StatusPlano.ATIVO,
      ativo: true,
      data_vigencia_inicio: new Date('2025-01-01'),
      criado_por: '3tp6gd6hmhyw0cf0mbf0cvi54v'
    }
  });

  // Tarefas do Plano 3
  await prisma.tarefas.createMany({
    data: [
      {
        plano_manutencao_id: plano3.id,
        equipamento_id: 'cmesudnzl00072ffkkc5uoidk',
        planta_id: 'cmekb23xd00032f4o1rw4g8rk',
        tag: 'REF-FILT-001',
        nome: 'Substituição de Filtros',
        descricao: 'Substituição de todos os filtros de ar do sistema de refrigeração',
        categoria: CategoriaTarefa.MECANICA,
        tipo_manutencao: TipoManutencao.PREVENTIVA,
        frequencia: FrequenciaTarefa.MENSAL,
        condicao_ativo: CondicaoAtivo.PARADO,
        criticidade: 3,
        duracao_estimada: 1,
        tempo_estimado: 60,
        ordem: 1,
        responsavel: 'Técnico Refrigeração',
        status: StatusTarefa.ATIVA,
        ativo: true,
        criado_por: '3tp6gd6hmhyw0cf0mbf0cvi54v'
      },
      {
        plano_manutencao_id: plano3.id,
        equipamento_id: 'cmesudnzl00072ffkkc5uoidk',
        planta_id: 'cmekb23xd00032f4o1rw4g8rk',
        tag: 'REF-GAS-001',
        nome: 'Verificação de Vazamentos',
        descricao: 'Inspeção completa do sistema para detecção de vazamentos de gás refrigerante',
        categoria: CategoriaTarefa.INSPECAO,
        tipo_manutencao: TipoManutencao.PREVENTIVA,
        frequencia: FrequenciaTarefa.SEMANAL,
        condicao_ativo: CondicaoAtivo.FUNCIONANDO,
        criticidade: 4,
        duracao_estimada: 0.5,
        tempo_estimado: 30,
        ordem: 2,
        responsavel: 'Técnico Refrigeração',
        status: StatusTarefa.ATIVA,
        ativo: true,
        criado_por: '3tp6gd6hmhyw0cf0mbf0cvi54v'
      }
    ]
  });

  // Plano 4: Compressor de Ar Industrial
  const plano4 = await prisma.planos_manutencao.create({
    data: {
      equipamento_id: 'cmesudoh1000f2ffk75yy4lqe',
      nome: 'Manutenção Compressor Atlas Copco GA 22',
      descricao: 'Plano de manutenção preventiva para compressor de ar industrial',
      versao: '2.0',
      status: StatusPlano.ATIVO,
      ativo: true,
      observacoes: 'Seguir rigorosamente o cronograma de lubrificação',
      criado_por: 'fkl8xxjkwgb2rtnmxxlotewpwf'
    }
  });

  // Tarefas do Plano 4 com sub-tarefas e recursos
  const tarefaCompressor = await prisma.tarefas.create({
    data: {
      plano_manutencao_id: plano4.id,
      equipamento_id: 'cmesudoh1000f2ffk75yy4lqe',
      planta_id: 'cmekb245400072f4oyfcrcxzw',
      tag: 'COM-LUB-001',
      nome: 'Lubrificação Completa do Compressor',
      descricao: 'Troca de óleo e filtros, lubrificação dos mancais e verificação do sistema de lubrificação automática',
      categoria: CategoriaTarefa.LUBRIFICACAO,
      tipo_manutencao: TipoManutencao.PREVENTIVA,
      frequencia: FrequenciaTarefa.PERSONALIZADA,
      frequencia_personalizada: 500, // A cada 500 horas de operação
      condicao_ativo: CondicaoAtivo.PARADO,
      criticidade: 4,
      duracao_estimada: 3,
      tempo_estimado: 180,
      ordem: 1,
      responsavel: 'Técnico Mecânico Senior',
      planejador: 'Maria Gerente',
      observacoes: 'Verificar manual do fabricante para especificações do óleo',
      status: StatusTarefa.ATIVA,
      ativo: true,
      criado_por: 'fkl8xxjkwgb2rtnmxxlotewpwf'
    }
  });

  // Sub-tarefas para a tarefa de lubrificação
  await prisma.sub_tarefas.createMany({
    data: [
      {
        tarefa_id: tarefaCompressor.id,
        descricao: 'Drenar óleo usado completamente',
        obrigatoria: true,
        tempo_estimado: 15,
        ordem: 1
      },
      {
        tarefa_id: tarefaCompressor.id,
        descricao: 'Substituir filtro de óleo',
        obrigatoria: true,
        tempo_estimado: 30,
        ordem: 2
      },
      {
        tarefa_id: tarefaCompressor.id,
        descricao: 'Aplicar óleo novo conforme especificação',
        obrigatoria: true,
        tempo_estimado: 20,
        ordem: 3
      },
      {
        tarefa_id: tarefaCompressor.id,
        descricao: 'Verificar nível de óleo após funcionamento',
        obrigatoria: true,
        tempo_estimado: 10,
        ordem: 4
      },
      {
        tarefa_id: tarefaCompressor.id,
        descricao: 'Lubrificar mancais externos',
        obrigatoria: false,
        tempo_estimado: 45,
        ordem: 5
      },
      {
        tarefa_id: tarefaCompressor.id,
        descricao: 'Testar sistema de lubrificação automática',
        obrigatoria: true,
        tempo_estimado: 30,
        ordem: 6
      }
    ]
  });

  // Recursos necessários para a tarefa de lubrificação
  await prisma.recursos_tarefa.createMany({
    data: [
      {
        tarefa_id: tarefaCompressor.id,
        tipo: TipoRecurso.MATERIAL,
        descricao: 'Óleo Atlas Copco Roto-Inject Fluid',
        quantidade: 25,
        unidade: 'litros',
        obrigatorio: true
      },
      {
        tarefa_id: tarefaCompressor.id,
        tipo: TipoRecurso.PECA,
        descricao: 'Filtro de óleo Atlas Copco 1622-3114-99',
        quantidade: 1,
        unidade: 'unidade',
        obrigatorio: true
      },
      {
        tarefa_id: tarefaCompressor.id,
        tipo: TipoRecurso.MATERIAL,
        descricao: 'Graxa para mancais SKF LGMT 3',
        quantidade: 500,
        unidade: 'gramas',
        obrigatorio: false
      },
      {
        tarefa_id: tarefaCompressor.id,
        tipo: TipoRecurso.FERRAMENTA,
        descricao: 'Chave de filtro 32-40mm',
        quantidade: 1,
        unidade: 'unidade',
        obrigatorio: true
      },
      {
        tarefa_id: tarefaCompressor.id,
        tipo: TipoRecurso.FERRAMENTA,
        descricao: 'Bomba de graxa pneumática',
        quantidade: 1,
        unidade: 'unidade',
        obrigatorio: false
      },
      {
        tarefa_id: tarefaCompressor.id,
        tipo: TipoRecurso.TECNICO,
        descricao: 'Técnico Mecânico com certificação Atlas Copco',
        quantidade: 1,
        unidade: 'pessoa',
        obrigatorio: true
      }
    ]
  });

  // Tarefa de inspeção com frequência personalizada
  await prisma.tarefas.create({
    data: {
      plano_manutencao_id: plano4.id,
      equipamento_id: 'cmesudoh1000f2ffk75yy4lqe',
      planta_id: 'cmekb245400072f4oyfcrcxzw',
      tag: 'COM-INSP-001',
      nome: 'Inspeção de Vibração e Ruído',
      descricao: 'Medição de níveis de vibração e ruído para detecção precoce de problemas mecânicos',
      categoria: CategoriaTarefa.INSPECAO,
      tipo_manutencao: TipoManutencao.PREDITIVA,
      frequencia: FrequenciaTarefa.PERSONALIZADA,
      frequencia_personalizada: 15, // A cada 15 dias
      condicao_ativo: CondicaoAtivo.FUNCIONANDO,
      criticidade: 3,
      duracao_estimada: 1,
      tempo_estimado: 60,
      ordem: 2,
      responsavel: 'Técnico em Vibração',
      status: StatusTarefa.ATIVA,
      ativo: true,
      criado_por: 'fkl8xxjkwgb2rtnmxxlotewpwf'
    }
  });

  // Plano 5: Grupo Gerador (com tarefa em revisão)
  const plano5 = await prisma.planos_manutencao.create({
    data: {
      equipamento_id: 'cmesudo8k000b2ffkp6ufhcax',
      nome: 'Manutenção Grupo Gerador Caterpillar',
      descricao: 'Plano de manutenção para grupo gerador de emergência',
      versao: '1.1',
      status: StatusPlano.EM_REVISAO,
      ativo: false,
      observacoes: 'Plano sendo revisado após última falha',
      criado_por: 'e1tymz8qcwm3mx5lh0ictnl1je'
    }
  });

  await prisma.tarefas.createMany({
    data: [
      {
        plano_manutencao_id: plano5.id,
        equipamento_id: 'cmesudo8k000b2ffkp6ufhcax',
        planta_id: 'cmekb241300052f4o9frhlfqy',
        tag: 'GER-TEST-001',
        nome: 'Teste de Funcionamento',
        descricao: 'Teste semanal de funcionamento do grupo gerador sob carga parcial',
        categoria: CategoriaTarefa.INSPECAO,
        tipo_manutencao: TipoManutencao.PREVENTIVA,
        frequencia: FrequenciaTarefa.SEMANAL,
        condicao_ativo: CondicaoAtivo.QUALQUER,
        criticidade: 5,
        duracao_estimada: 1,
        tempo_estimado: 60,
        ordem: 1,
        responsavel: 'Eletricista',
        status: StatusTarefa.EM_REVISAO,
        ativo: false,
        criado_por: 'e1tymz8qcwm3mx5lh0ictnl1je'
      }
    ]
  });

  console.log('✅ Seed de planos e tarefas concluído!');
  console.log(`   • ${await prisma.planos_manutencao.count()} planos criados`);
  console.log(`   • ${await prisma.tarefas.count()} tarefas criadas`);
  console.log(`   • ${await prisma.sub_tarefas.count()} sub-tarefas criadas`);
  console.log(`   • ${await prisma.recursos_tarefa.count()} recursos criados`);
}

// Função principal
async function main() {
  try {
    await seedPlanosManutencao();
    console.log('🎉 Seed completed successfully!');
  } catch (error) {
    console.error('❌ Error seeding database:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Executar se for chamado diretamente
if (require.main === module) {
  main();
}

export { seedPlanosManutencao };