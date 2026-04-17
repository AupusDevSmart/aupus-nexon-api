import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function seedProgramacaoOS() {
  console.log('🌱 Iniciando seed de Programações e Ordens de Serviço...');

  // IDs das entidades existentes para usar nos relacionamentos
  const plantas = [
    'cmekb23pr00012f4o4nqp9ypz', // Planta Industrial São Paulo
    'cmekb23xd00032f4o1rw4g8rk', // Centro de Distribuição Rio
    'cmekb241300052f4o9frhlfqy', // Unidade Administrativa BH
    'cmekb245400072f4oyfcrcxzw', // Oficina João Silva
  ];

  const equipamentos = [
    'cmesudng400012ffkncdeu6nl', // Sistema de Controle Principal
    'cmesudnop00032ffk5ma35abw', // Transformador Principal TR-01
    'cmesudnzl00072ffkkc5uoidk', // Sistema de Refrigeração
    'cmesudoh1000f2ffk75yy4lqe', // Compressor de Ar Industrial
    'cmesudo8k000b2ffkp6ufhcax', // Grupo Gerador de Emergência
  ];

  const tarefas = [
    'cmfh32n8u00022fxcdqtx5gys', // Inspeção Visual dos Módulos
    'cmfh32n8u00032fxc0efgh3e8', // Limpeza e Verificação de Conectores
    'cmfh32n8u00042fxcbg60kl3e', // Calibração de Sensores e Atuadores
    'cmfh32nxt00072fxcs6vdeka9', // Análise do Óleo Isolante
    'cmfh32olx000b2fxcu9nhojky', // Substituição de Filtros
  ];

  const usuarios = [
    { id: '01K2CPBYE07B3HWW0CZHHB3ZCR', nome: 'Administrador' },
    { id: '01K2CPBZ7NZMAA5J9P30GVCYGD', nome: 'João Consultor' },
    { id: '01K2CPC019T4NXD6NDT0D4PHHZ', nome: 'Maria Gerente' },
    { id: 'fkl8xxjkwgb2rtnmxxlotewpwf', nome: 'aaaaaaaa' },
  ];

  const veiculos = [
    'cmflluf0w00002fvgjflqbxds', // Carro Teste
    'cmfo9cvba00022f2ogx71huj6', // Golzin
  ];

  // 1. PROGRAMAÇÕES DE OS
  console.log('📝 Criando programações de OS...');

  const programacoes = [];

  // Programação 1: APROVADA (origem: tarefa)
  const prog1 = await prisma.programacoes_os.create({
    data: {
      codigo: 'PRG-2025-001',
      descricao: 'Manutenção Preventiva do Sistema de Controle SIMATIC S7-1500',
      local: 'Sala de Controle - Galpão Principal',
      ativo: 'Sistema de Controle Principal',
      condicoes: 'PARADO',
      status: 'APROVADA',
      tipo: 'PREVENTIVA',
      prioridade: 'ALTA',
      origem: 'TAREFA',
      planta_id: plantas[0],
      equipamento_id: equipamentos[0],
      dados_origem: {
        tarefas_ids: [tarefas[0], tarefas[1]],
        plano_manutencao_id: 'cmfh32myo00012fxc86fcw0dj'
      },
      data_previsao_inicio: new Date('2025-10-15'),
      data_previsao_fim: new Date('2025-10-15'),
      tempo_estimado: 4.5,
      duracao_estimada: 4.5,
      necessita_veiculo: true,
      assentos_necessarios: 2,
      carga_necessaria: 50,
      observacoes_veiculo: 'Necessário transporte de equipamentos de calibração',
      data_hora_programada: new Date('2025-10-15T08:00:00'),
      responsavel: 'João Consultor',
      responsavel_id: usuarios[1].id,
      time_equipe: 'Equipe Elétrica',
      orcamento_previsto: 2500.00,
      observacoes: 'Manutenção crítica - parada programada necessária',
      observacoes_programacao: 'Coordenar com produção para parada do sistema',
      justificativa: 'Manutenção preventiva conforme cronograma',
      criado_por: usuarios[0].nome,
      criado_por_id: usuarios[0].id,
      analisado_por: usuarios[2].nome,
      analisado_por_id: usuarios[2].id,
      data_analise: new Date('2025-09-20'),
      aprovado_por: usuarios[2].nome,
      aprovado_por_id: usuarios[2].id,
      data_aprovacao: new Date('2025-09-22'),
    },
  });
  programacoes.push(prog1);

  // Programação 2: EM_ANALISE (origem: anomalia)
  const prog2 = await prisma.programacoes_os.create({
    data: {
      codigo: 'PRG-2025-002',
      descricao: 'Correção de Vazamento no Sistema de Refrigeração',
      local: 'Câmara Fria - Armazém 3',
      ativo: 'Sistema de Refrigeração',
      condicoes: 'FUNCIONANDO',
      status: 'APROVADA',
      tipo: 'CORRETIVA',
      prioridade: 'CRITICA',
      origem: 'ANOMALIA',
      planta_id: plantas[1],
      equipamento_id: equipamentos[2],
      dados_origem: {
        anomalia_descricao: 'Vazamento detectado na tubulação principal',
        anomalia_criticidade: 'ALTA'
      },
      data_previsao_inicio: new Date('2025-10-18'),
      data_previsao_fim: new Date('2025-10-18'),
      tempo_estimado: 6.0,
      duracao_estimada: 8.0,
      necessita_veiculo: true,
      assentos_necessarios: 3,
      carga_necessaria: 100,
      observacoes_veiculo: 'Transporte de soldas e equipamentos pesados',
      orcamento_previsto: 3500.00,
      observacoes: 'Vazamento identificado durante inspeção de rotina',
      justificativa: 'Correção urgente para evitar perda de produtos',
      criado_por: usuarios[1].nome,
      criado_por_id: usuarios[1].id,
      analisado_por: usuarios[2].nome,
      analisado_por_id: usuarios[2].id,
      data_analise: new Date('2025-09-25'),
    },
  });
  programacoes.push(prog2);

  // Programação 3: PENDENTE (origem: manual)
  const prog3 = await prisma.programacoes_os.create({
    data: {
      codigo: 'PRG-2025-003',
      descricao: 'Troca de Óleo e Filtros do Compressor',
      local: 'Área de Manutenção',
      ativo: 'Compressor de Ar Industrial',
      condicoes: 'PARADO',
      status: 'PENDENTE',
      tipo: 'PREVENTIVA',
      prioridade: 'MEDIA',
      origem: 'MANUAL',
      planta_id: plantas[3],
      equipamento_id: equipamentos[3],
      data_previsao_inicio: new Date('2025-10-20'),
      data_previsao_fim: new Date('2025-10-20'),
      tempo_estimado: 3.0,
      duracao_estimada: 4.0,
      necessita_veiculo: false,
      orcamento_previsto: 800.00,
      observacoes: 'Manutenção de rotina conforme manual do fabricante',
      justificativa: 'Prevenção de falhas e aumento da vida útil',
      criado_por: usuarios[3].nome,
      criado_por_id: usuarios[3].id,
    },
  });
  programacoes.push(prog3);

  // Programação 4: RASCUNHO (automática)
  const prog4 = await prisma.programacoes_os.create({
    data: {
      codigo: 'PRG-2025-004',
      descricao: 'Teste de Funcionamento Grupo Gerador',
      local: 'Subsolo - Casa de Máquinas',
      ativo: 'Grupo Gerador de Emergência',
      condicoes: 'FUNCIONANDO',
      status: 'PENDENTE',
      tipo: 'INSPECAO',
      prioridade: 'MEDIA',
      origem: 'TAREFA',
      planta_id: plantas[2],
      equipamento_id: equipamentos[4],
      dados_origem: {
        tarefa_id: tarefas[4],
        automatico: true
      },
      data_previsao_inicio: new Date('2025-10-25'),
      data_previsao_fim: new Date('2025-10-25'),
      tempo_estimado: 1.0,
      duracao_estimada: 1.5,
      necessita_veiculo: false,
      orcamento_previsto: 200.00,
      observacoes: 'Programação gerada automaticamente pelo sistema',
      criado_por: 'Sistema Automático',
    },
  });
  programacoes.push(prog4);

  // 2. MATERIAIS DAS PROGRAMAÇÕES
  console.log('🔧 Criando materiais das programações...');

  // Materiais para Programação 1
  await prisma.materiais_programacao_os.createMany({
    data: [
      {
        programacao_id: prog1.id,
        descricao: 'Conector Industrial IP67',
        quantidade_planejada: 4,
        unidade: 'PC',
        custo_unitario: 125.00,
        custo_total: 500.00,
        confirmado: true,
        disponivel: true,
        observacoes: 'Especificação Siemens original'
      },
      {
        programacao_id: prog1.id,
        descricao: 'Cabo Ethernet Cat6 Industrial',
        quantidade_planejada: 50,
        unidade: 'M',
        custo_unitario: 8.50,
        custo_total: 425.00,
        confirmado: true,
        disponivel: true,
      },
      {
        programacao_id: prog1.id,
        descricao: 'Kit Limpeza Eletrônica',
        quantidade_planejada: 2,
        unidade: 'PC',
        custo_unitario: 45.00,
        custo_total: 90.00,
        confirmado: true,
        disponivel: true,
      }
    ]
  });

  // Materiais para Programação 2
  await prisma.materiais_programacao_os.createMany({
    data: [
      {
        programacao_id: prog2.id,
        descricao: 'Tubo de Cobre 1/2"',
        quantidade_planejada: 10,
        unidade: 'M',
        custo_unitario: 25.00,
        custo_total: 250.00,
        confirmado: false,
        disponivel: true,
        observacoes: 'Verificar compatibilidade com sistema existente'
      },
      {
        programacao_id: prog2.id,
        descricao: 'Solda Prata 15%',
        quantidade_planejada: 0.5,
        unidade: 'KG',
        custo_unitario: 180.00,
        custo_total: 90.00,
        confirmado: true,
        disponivel: true,
      },
      {
        programacao_id: prog2.id,
        descricao: 'Isolamento Térmico',
        quantidade_planejada: 5,
        unidade: 'M',
        custo_unitario: 35.00,
        custo_total: 175.00,
        confirmado: true,
        disponivel: false,
        observacoes: 'Necessário comprar - prazo 3 dias'
      }
    ]
  });

  // 3. FERRAMENTAS DAS PROGRAMAÇÕES
  console.log('🛠️ Criando ferramentas das programações...');

  await prisma.ferramentas_programacao_os.createMany({
    data: [
      {
        programacao_id: prog1.id,
        descricao: 'Multímetro Digital Fluke 87V',
        quantidade: 1,
        confirmada: true,
        disponivel: true,
      },
      {
        programacao_id: prog1.id,
        descricao: 'Kit Chaves de Fenda Isoladas',
        quantidade: 1,
        confirmada: true,
        disponivel: true,
      },
      {
        programacao_id: prog2.id,
        descricao: 'Maçarico para Solda',
        quantidade: 1,
        confirmada: true,
        disponivel: true,
      },
      {
        programacao_id: prog2.id,
        descricao: 'Detector de Vazamento Eletrônico',
        quantidade: 1,
        confirmada: false,
        disponivel: false,
        observacoes: 'Equipamento em manutenção - retorna dia 20'
      }
    ]
  });

  // 4. TÉCNICOS DAS PROGRAMAÇÕES
  console.log('👨‍🔧 Criando técnicos das programações...');

  await prisma.tecnicos_programacao_os.createMany({
    data: [
      {
        programacao_id: prog1.id,
        nome: 'Carlos Silva',
        especialidade: 'Eletricista Industrial',
        horas_estimadas: 4.5,
        custo_hora: 85.00,
        custo_total: 382.50,
        disponivel: true,
        tecnico_id: usuarios[1].id
      },
      {
        programacao_id: prog1.id,
        nome: 'Ana Santos',
        especialidade: 'Instrumentista',
        horas_estimadas: 4.5,
        custo_hora: 95.00,
        custo_total: 427.50,
        disponivel: true,
      },
      {
        programacao_id: prog2.id,
        nome: 'Pedro Oliveira',
        especialidade: 'Técnico em Refrigeração',
        horas_estimadas: 8.0,
        custo_hora: 75.00,
        custo_total: 600.00,
        disponivel: true,
      },
      {
        programacao_id: prog2.id,
        nome: 'José Almeida',
        especialidade: 'Soldador',
        horas_estimadas: 4.0,
        custo_hora: 80.00,
        custo_total: 320.00,
        disponivel: true,
      }
    ]
  });

  // 5. RELACIONAMENTOS TAREFAS-PROGRAMAÇÃO
  console.log('🔗 Criando relacionamentos tarefas-programação...');

  await prisma.tarefas_programacao_os.createMany({
    data: [
      {
        programacao_id: prog1.id,
        tarefa_id: tarefas[0],
        ordem: 1,
        status: 'PENDENTE',
        observacoes: 'Inspeção visual completa dos módulos'
      },
      {
        programacao_id: prog1.id,
        tarefa_id: tarefas[1],
        ordem: 2,
        status: 'PENDENTE',
        observacoes: 'Limpeza após inspeção'
      },
      {
        programacao_id: prog4.id,
        tarefa_id: tarefas[4],
        ordem: 1,
        status: 'PENDENTE',
        observacoes: 'Tarefa automática do sistema'
      }
    ]
  });

  // 6. HISTÓRICO DAS PROGRAMAÇÕES
  console.log('📋 Criando histórico das programações...');

  await prisma.historico_programacao_os.createMany({
    data: [
      {
        programacao_id: prog1.id,
        acao: 'Programação criada',
        usuario: usuarios[0].nome,
        usuario_id: usuarios[0].id,
        status_anterior: null,
        status_novo: 'PENDENTE',
        observacoes: 'Programação criada com base na tarefa de manutenção preventiva'
      },
      {
        programacao_id: prog1.id,
        acao: 'Programação analisada',
        usuario: usuarios[2].nome,
        usuario_id: usuarios[2].id,
        status_anterior: 'PENDENTE',
        status_novo: 'APROVADA',
        observacoes: 'Programação aprovada - pode gerar OS'
      }
    ]
  });

  // 7. ORDEM DE SERVIÇO (gerada da programação aprovada)
  console.log('📄 Criando ordem de serviço...');

  const os1 = await prisma.ordens_servico.create({
    data: {
      programacao_id: prog1.id,
      numero_os: 'OS-2025-001',
      descricao: prog1.descricao,
      local: prog1.local,
      ativo: prog1.ativo,
      condicoes: prog1.condicoes,
      status: 'PENDENTE',
      tipo: prog1.tipo,
      prioridade: prog1.prioridade,
      origem: prog1.origem,
      planta_id: prog1.planta_id,
      equipamento_id: prog1.equipamento_id,
      dados_origem: prog1.dados_origem,
      tempo_estimado: prog1.tempo_estimado,
      duracao_estimada: prog1.duracao_estimada,
      data_hora_programada: prog1.data_hora_programada!,
      responsavel: prog1.responsavel!,
      responsavel_id: prog1.responsavel_id,
      time_equipe: prog1.time_equipe,
      orcamento_previsto: prog1.orcamento_previsto,
      observacoes: prog1.observacoes,
      observacoes_programacao: 'OS gerada automaticamente da programação aprovada',
      criado_por: 'Sistema',
      criado_por_id: usuarios[0].id,
      programado_por: usuarios[2].nome,
      programado_por_id: usuarios[2].id,
    },
  });

  // 8. MATERIAIS DA OS (copiados da programação)
  console.log('🔧 Criando materiais da OS...');

  await prisma.materiais_os.createMany({
    data: [
      {
        os_id: os1.id,
        descricao: 'Conector Industrial IP67',
        quantidade_planejada: 4,
        quantidade_consumida: null, // Será preenchido na execução
        unidade: 'PC',
        custo_unitario: 125.00,
        custo_total: 500.00,
        confirmado: true,
        disponivel: true,
      },
      {
        os_id: os1.id,
        descricao: 'Cabo Ethernet Cat6 Industrial',
        quantidade_planejada: 50,
        quantidade_consumida: null,
        unidade: 'M',
        custo_unitario: 8.50,
        custo_total: 425.00,
        confirmado: true,
        disponivel: true,
      },
      {
        os_id: os1.id,
        descricao: 'Kit Limpeza Eletrônica',
        quantidade_planejada: 2,
        quantidade_consumida: null,
        unidade: 'PC',
        custo_unitario: 45.00,
        custo_total: 90.00,
        confirmado: true,
        disponivel: true,
      }
    ]
  });

  // 9. FERRAMENTAS DA OS
  console.log('🛠️ Criando ferramentas da OS...');

  await prisma.ferramentas_os.createMany({
    data: [
      {
        os_id: os1.id,
        descricao: 'Multímetro Digital Fluke 87V',
        quantidade: 1,
        confirmada: true,
        disponivel: true,
        utilizada: false,
        condicao_antes: 'BOM',
      },
      {
        os_id: os1.id,
        descricao: 'Kit Chaves de Fenda Isoladas',
        quantidade: 1,
        confirmada: true,
        disponivel: true,
        utilizada: false,
        condicao_antes: 'BOM',
      }
    ]
  });

  // 10. TÉCNICOS DA OS
  console.log('👨‍🔧 Criando técnicos da OS...');

  await prisma.tecnicos_os.createMany({
    data: [
      {
        os_id: os1.id,
        nome: 'Carlos Silva',
        especialidade: 'Eletricista Industrial',
        horas_estimadas: 4.5,
        horas_trabalhadas: null, // Será preenchido durante execução
        custo_hora: 85.00,
        custo_total: 382.50,
        disponivel: true,
        presente: false,
        tecnico_id: usuarios[1].id
      },
      {
        os_id: os1.id,
        nome: 'Ana Santos',
        especialidade: 'Instrumentista',
        horas_estimadas: 4.5,
        horas_trabalhadas: null,
        custo_hora: 95.00,
        custo_total: 427.50,
        disponivel: true,
        presente: false,
      }
    ]
  });

  // 11. CHECKLIST DE ATIVIDADES
  console.log('✅ Criando checklist de atividades...');

  await prisma.checklist_atividades_os.createMany({
    data: [
      {
        os_id: os1.id,
        atividade: 'Desligar sistema e isolar energia',
        ordem: 1,
        concluida: false,
        obrigatoria: true,
        tempo_estimado: 15,
        observacoes: 'Procedimento de segurança obrigatório'
      },
      {
        os_id: os1.id,
        atividade: 'Inspeção visual dos módulos',
        ordem: 2,
        concluida: false,
        obrigatoria: true,
        tempo_estimado: 60,
      },
      {
        os_id: os1.id,
        atividade: 'Limpeza dos conectores',
        ordem: 3,
        concluida: false,
        obrigatoria: true,
        tempo_estimado: 90,
      },
      {
        os_id: os1.id,
        atividade: 'Verificação de LEDs de status',
        ordem: 4,
        concluida: false,
        obrigatoria: true,
        tempo_estimado: 30,
      },
      {
        os_id: os1.id,
        atividade: 'Teste de funcionamento',
        ordem: 5,
        concluida: false,
        obrigatoria: true,
        tempo_estimado: 45,
      },
      {
        os_id: os1.id,
        atividade: 'Documentar resultados',
        ordem: 6,
        concluida: false,
        obrigatoria: true,
        tempo_estimado: 30,
      }
    ]
  });

  // 12. RELACIONAMENTOS TAREFAS-OS
  console.log('🔗 Criando relacionamentos tarefas-OS...');

  await prisma.tarefas_os.createMany({
    data: [
      {
        os_id: os1.id,
        tarefa_id: tarefas[0],
        ordem: 1,
        status: 'PENDENTE',
        observacoes: 'Inspeção visual completa dos módulos'
      },
      {
        os_id: os1.id,
        tarefa_id: tarefas[1],
        ordem: 2,
        status: 'PENDENTE',
        observacoes: 'Limpeza após inspeção'
      }
    ]
  });

  // 13. HISTÓRICO DA OS
  console.log('📋 Criando histórico da OS...');

  await prisma.historico_os.createMany({
    data: [
      {
        os_id: os1.id,
        acao: 'OS criada automaticamente',
        usuario: 'Sistema',
        usuario_id: usuarios[0].id,
        status_anterior: null,
        status_novo: 'PENDENTE',
        observacoes: 'OS gerada a partir da programação aprovada PRG-2025-001'
      }
    ]
  });

  // 14. RESERVA DE VEÍCULO - Temporariamente comentado
  console.log('🚗 Pulando reserva de veículo...');

  /*
  await prisma.reserva_veiculo.create({
    data: {
      veiculo_id: veiculos[0],
      solicitante_id: os1.id,
      tipo_solicitante: 'ordem_servico',
      data_inicio: new Date('2025-10-15T07:30:00'),
      hora_fim: '13:00',
      responsavel: os1.responsavel,
      responsavel_id: os1.responsavel_id,
      finalidade: `Execução da OS ${os1.numero_os} - ${os1.descricao}`,
      status: 'ativa',
      observacoes: 'Transporte de técnicos e equipamentos para manutenção'
    }
  });
  */

  // 15. CRIANDO MAIS PROGRAMAÇÕES PARA DIVERSIDADE
  console.log('📝 Criando programações adicionais...');

  // Programação REJEITADA
  const prog5 = await prisma.programacoes_os.create({
    data: {
      codigo: 'PRG-2025-005',
      descricao: 'Ampliação Sistema Elétrico',
      local: 'Painel Principal',
      ativo: 'Sistema de Controle Principal',
      condicoes: 'PARADO',
      status: 'CANCELADA',
      tipo: 'PREVENTIVA',
      prioridade: 'BAIXA',
      origem: 'MANUAL',
      planta_id: plantas[0],
      equipamento_id: equipamentos[0],
      data_previsao_inicio: new Date('2025-11-01'),
      data_previsao_fim: new Date('2025-11-02'),
      tempo_estimado: 16.0,
      duracao_estimada: 18.0,
      necessita_veiculo: true,
      assentos_necessarios: 4,
      carga_necessaria: 200,
      orcamento_previsto: 15000.00,
      observacoes: 'Ampliação não autorizada no momento',
      motivo_rejeicao: 'Orçamento excede limite aprovado para o período',
      criado_por: usuarios[1].nome,
      criado_por_id: usuarios[1].id,
      analisado_por: usuarios[2].nome,
      analisado_por_id: usuarios[2].id,
      data_analise: new Date('2025-09-28'),
    },
  });

  // OS EM EXECUÇÃO
  const prog6 = await prisma.programacoes_os.create({
    data: {
      codigo: 'PRG-2025-006',
      descricao: 'Calibração Instrumentos Transformador',
      local: 'Subestação - Área Externa',
      ativo: 'Transformador Principal TR-01',
      condicoes: 'FUNCIONANDO',
      status: 'APROVADA',
      tipo: 'PREDITIVA',
      prioridade: 'ALTA',
      origem: 'TAREFA',
      planta_id: plantas[0],
      equipamento_id: equipamentos[1],
      dados_origem: {
        tarefa_id: tarefas[3],
        plano_manutencao_id: 'cmfh32npp00062fxcf87uh2n2'
      },
      data_previsao_inicio: new Date('2025-09-30'),
      data_previsao_fim: new Date('2025-09-30'),
      tempo_estimado: 2.0,
      duracao_estimada: 2.5,
      necessita_veiculo: false,
      data_hora_programada: new Date('2025-09-30T14:00:00'),
      responsavel: 'Pedro Oliveira',
      time_equipe: 'Equipe Instrumentação',
      orcamento_previsto: 1200.00,
      observacoes: 'Calibração semestral obrigatória',
      criado_por: 'Sistema Automático',
      analisado_por: usuarios[2].nome,
      analisado_por_id: usuarios[2].id,
      data_analise: new Date('2025-09-28'),
      aprovado_por: usuarios[2].nome,
      aprovado_por_id: usuarios[2].id,
      data_aprovacao: new Date('2025-09-28'),
    },
  });

  const os2 = await prisma.ordens_servico.create({
    data: {
      programacao_id: prog6.id,
      numero_os: 'OS-2025-002',
      descricao: prog6.descricao,
      local: prog6.local,
      ativo: prog6.ativo,
      condicoes: prog6.condicoes,
      status: 'EM_EXECUCAO',
      tipo: prog6.tipo,
      prioridade: prog6.prioridade,
      origem: prog6.origem,
      planta_id: prog6.planta_id,
      equipamento_id: prog6.equipamento_id,
      dados_origem: prog6.dados_origem,
      tempo_estimado: prog6.tempo_estimado,
      duracao_estimada: prog6.duracao_estimada,
      data_hora_programada: prog6.data_hora_programada!,
      responsavel: prog6.responsavel!,
      time_equipe: prog6.time_equipe,
      data_hora_inicio_real: new Date('2025-09-30T14:05:00'),
      equipe_presente: ['Pedro Oliveira', 'Ana Santos'],
      orcamento_previsto: prog6.orcamento_previsto,
      observacoes: prog6.observacoes,
      observacoes_execucao: 'Execução iniciada conforme planejado',
      criado_por: 'Sistema',
      criado_por_id: usuarios[0].id,
      programado_por: usuarios[2].nome,
      programado_por_id: usuarios[2].id,
    },
  });

  // Registro de tempo para OS em execução
  await prisma.registros_tempo_os.create({
    data: {
      os_id: os2.id,
      tecnico_id: usuarios[1].id,
      tecnico_nome: 'Pedro Oliveira',
      data_hora_inicio: new Date('2025-09-30T14:05:00'),
      atividade: 'Preparação e setup dos equipamentos',
      observacoes: 'Inicio da calibração conforme cronograma',
      pausas: []
    }
  });

  // OS FINALIZADA
  const prog7 = await prisma.programacoes_os.create({
    data: {
      codigo: 'PRG-2025-007',
      descricao: 'Limpeza Filtros Sistema Refrigeração',
      local: 'Câmara Fria - Armazém 3',
      ativo: 'Sistema de Refrigeração',
      condicoes: 'PARADO',
      status: 'APROVADA',
      tipo: 'PREVENTIVA',
      prioridade: 'MEDIA',
      origem: 'TAREFA',
      planta_id: plantas[1],
      equipamento_id: equipamentos[2],
      dados_origem: {
        tarefa_id: tarefas[2]
      },
      data_previsao_inicio: new Date('2025-09-25'),
      data_previsao_fim: new Date('2025-09-25'),
      tempo_estimado: 1.5,
      duracao_estimada: 2.0,
      necessita_veiculo: false,
      data_hora_programada: new Date('2025-09-25T09:00:00'),
      responsavel: 'José Almeida',
      orcamento_previsto: 300.00,
      observacoes: 'Manutenção preventiva mensal',
      criado_por: 'Sistema Automático',
      aprovado_por: usuarios[2].nome,
      aprovado_por_id: usuarios[2].id,
      data_aprovacao: new Date('2025-09-20'),
    },
  });

  const os3 = await prisma.ordens_servico.create({
    data: {
      programacao_id: prog7.id,
      numero_os: 'OS-2025-003',
      descricao: prog7.descricao,
      local: prog7.local,
      ativo: prog7.ativo,
      condicoes: prog7.condicoes,
      status: 'FINALIZADA',
      tipo: prog7.tipo,
      prioridade: prog7.prioridade,
      origem: prog7.origem,
      planta_id: prog7.planta_id,
      equipamento_id: prog7.equipamento_id,
      tempo_estimado: prog7.tempo_estimado,
      duracao_estimada: prog7.duracao_estimada,
      data_hora_programada: prog7.data_hora_programada!,
      responsavel: prog7.responsavel!,
      data_hora_inicio_real: new Date('2025-09-25T09:00:00'),
      data_hora_fim_real: new Date('2025-09-25T10:30:00'),
      // tempo_real_execucao: 90, // 1h30min - campo removido
      equipe_presente: ['José Almeida'],
      orcamento_previsto: 300.00,
      custo_real: 275.00,
      observacoes: prog7.observacoes,
      observacoes_execucao: 'Filtros substituídos conforme programado',
      resultado_servico: 'Todos os filtros foram substituídos. Sistema funcionando perfeitamente.',
      avaliacao_qualidade: 5,
      observacoes_qualidade: 'Excelente execução, dentro do prazo',
      finalizado_por: 'José Almeida',
      finalizado_por_id: usuarios[3].id,
    },
  });

  console.log('✅ Seed concluído com sucesso!');
  console.log(`📊 Estatísticas criadas:`);
  console.log(`   • ${programacoes.length + 4} Programações de OS`);
  console.log(`   • 3 Ordens de Serviço`);
  console.log(`   • Materiais, ferramentas e técnicos associados`);
  console.log(`   • Checklists e históricos completos`);
  console.log(`   • 1 Reserva de veículo`);

  return {
    programacoes: programacoes.length + 4,
    ordens_servico: 3,
    status: 'success'
  };
}

async function main() {
  try {
    await seedProgramacaoOS();
  } catch (error) {
    console.error('❌ Erro durante o seed:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });