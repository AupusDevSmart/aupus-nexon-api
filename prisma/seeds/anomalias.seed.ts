// prisma/seeds/anomalias.seed.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Dados das anomalias sem IDs fixos - serão mapeados dinamicamente
const anomaliasData = [
  // Anomalias Críticas
  {
    descricao: 'Vazamento severo de óleo no mancal principal do sistema de controle',
    equipamento_nome: 'Sistema de Controle Principal',
    condicao: 'PARADO',
    origem: 'SCADA',
    status: 'AGUARDANDO',
    prioridade: 'CRITICA',
    observacoes: 'Equipamento parado para evitar danos maiores. Necessária intervenção imediata.',
    usuario_nome: 'Administrador'
  },
  {
    descricao: 'Superaquecimento no transformador principal',
    equipamento_nome: 'Transformador Principal TR-01',
    condicao: 'RISCO_ACIDENTE',
    origem: 'SCADA',
    status: 'EM_ANALISE',
    prioridade: 'CRITICA',
    observacoes: 'Temperatura acima de 85°C detectada pelo sistema SCADA. Risco de explosão.',
    usuario_nome: 'João Consultor'
  },
  {
    descricao: 'Vibração excessiva detectada na esteira transportadora',
    equipamento_nome: 'Esteira Transportadora Principal',
    condicao: 'FUNCIONANDO',
    origem: 'OPERADOR',
    status: 'OS_GERADA',
    prioridade: 'CRITICA',
    observacoes: 'Vibração de 12mm/s medida durante inspeção. Limite máximo: 7mm/s.',
    usuario_nome: 'Carlos Vendedor',
    ordem_servico_id: 'OS-2025-001'
  },

  // Anomalias de Alta Prioridade
  {
    descricao: 'Falha na refrigeração da câmara fria',
    equipamento_nome: 'Sistema de Refrigeração',
    condicao: 'FUNCIONANDO',
    origem: 'OPERADOR',
    status: 'AGUARDANDO',
    prioridade: 'ALTA',
    observacoes: 'Temperatura subindo gradualmente. Sistema funcionando em modo reduzido.',
    usuario_nome: 'Maria Gerente'
  },
  {
    descricao: 'Empilhadeira com problema na bateria',
    equipamento_nome: 'Empilhadeira Elétrica',
    condicao: 'FUNCIONANDO',
    origem: 'OPERADOR',
    status: 'EM_ANALISE',
    prioridade: 'ALTA',
    observacoes: 'Autonomia da bateria caiu de 8h para 4h. Necessária verificação.',
    usuario_nome: 'Teste Admin'
  },
  {
    descricao: 'Grupo gerador apresentando ruído anormal',
    equipamento_nome: 'Grupo Gerador de Emergência',
    condicao: 'FUNCIONANDO',
    origem: 'OPERADOR',
    status: 'RESOLVIDA',
    prioridade: 'ALTA',
    observacoes: 'Problema resolvido após troca do filtro de ar e ajuste do motor.',
    usuario_nome: 'Leo Maia'
  },

  // Anomalias de Prioridade Média
  {
    descricao: 'Ar condicionado central com eficiência reduzida',
    equipamento_nome: 'Sistema de Ar Condicionado Central',
    condicao: 'FUNCIONANDO',
    origem: 'OPERADOR',
    status: 'AGUARDANDO',
    prioridade: 'MEDIA',
    observacoes: 'Temperatura ambiente 3°C acima do normal durante picos de calor.',
    usuario_nome: 'Administrador'
  },
  {
    descricao: 'Pressão baixa no compressor de ar',
    equipamento_nome: 'Compressor de Ar Industrial',
    condicao: 'FUNCIONANDO',
    origem: 'SCADA',
    status: 'OS_GERADA',
    prioridade: 'MEDIA',
    observacoes: 'Pressão caiu de 8 bar para 6.5 bar. Possível vazamento no sistema.',
    usuario_nome: 'aaaaaaaa',
    ordem_servico_id: 'OS-2025-002'
  },
  {
    descricao: 'Ponte rolante com movimento irregular',
    equipamento_nome: 'Ponte Rolante 5 Toneladas',
    condicao: 'FUNCIONANDO',
    origem: 'OPERADOR',
    status: 'CANCELADA',
    prioridade: 'MEDIA',
    observacoes: 'Após análise técnica, movimento considerado dentro dos padrões normais.',
    usuario_nome: 'Teste Admin'
  },

  // Anomalias de Baixa Prioridade
  {
    descricao: 'Sensor de temperatura apresentando leituras instáveis',
    equipamento_nome: 'Sensor de Temperatura CPU',
    condicao: 'FUNCIONANDO',
    origem: 'SCADA',
    status: 'AGUARDANDO',
    prioridade: 'BAIXA',
    observacoes: 'Variação de ±2°C nas leituras. Sistema principal funcionando.',
    usuario_nome: 'João Consultor'
  },
  {
    descricao: 'Módulo Ethernet com comunicação intermitente',
    equipamento_nome: 'Módulo de Comunicação Ethernet',
    condicao: 'FUNCIONANDO',
    origem: 'SCADA',
    status: 'AGUARDANDO',
    prioridade: 'BAIXA',
    observacoes: 'Perda de comunicação por 2-3 segundos a cada 30 minutos.',
    usuario_nome: 'Maria Gerente'
  },
  {
    descricao: 'Relé de proteção necessita calibração',
    equipamento_nome: 'Relé de Proteção REL-001',
    condicao: 'FUNCIONANDO',
    origem: 'OPERADOR',
    status: 'OS_GERADA',
    prioridade: 'BAIXA',
    observacoes: 'Calibração preventiva programada conforme cronograma de manutenção.',
    usuario_nome: 'Carlos Vendedor',
    ordem_servico_id: 'OS-2025-003'
  },

  // Anomalias Adicionais
  {
    descricao: 'Termômetro digital com display falhando',
    equipamento_nome: 'Termômetro Digital',
    condicao: 'FUNCIONANDO',
    origem: 'OPERADOR',
    status: 'EM_ANALISE',
    prioridade: 'BAIXA',
    observacoes: 'Display apresenta caracteres ilegíveis ocasionalmente.',
    usuario_nome: 'Administrador'
  },
  {
    descricao: 'Filtro de ar comprimido entupido',
    equipamento_nome: 'Filtro de Ar Comprimido',
    condicao: 'FUNCIONANDO',
    origem: 'OPERADOR',
    status: 'RESOLVIDA',
    prioridade: 'MEDIA',
    observacoes: 'Filtro substituído e sistema testado com sucesso.',
    usuario_nome: 'Leo Maia'
  },
  {
    descricao: 'Válvula de segurança com vedação comprometida',
    equipamento_nome: 'Válvula de Segurança',
    condicao: 'FUNCIONANDO',
    origem: 'OPERADOR',
    status: 'AGUARDANDO',
    prioridade: 'ALTA',
    observacoes: 'Pequeno vazamento detectado na vedação. Pressão estável.',
    usuario_nome: 'aaaaaaaa'
  },
  {
    descricao: 'Equipamento genérico necessita manutenção',
    equipamento_nome: 'aaaaa', // Este equipamento existe na tabela
    condicao: 'FUNCIONANDO',
    origem: 'OPERADOR',
    status: 'AGUARDANDO',
    prioridade: 'MEDIA',
    observacoes: 'Manutenção preventiva programada.',
    usuario_nome: 'Teste Admin'
  }
];

export async function seedAnomalias() {
  console.log('🌱 Iniciando seed de anomalias...');
  
  try {
    // Buscar todos os dados necessários
    const [plantas, equipamentos, usuarios] = await Promise.all([
      prisma.plantas.findMany({
        select: { id: true, nome: true }
      }),
      prisma.equipamentos.findMany({
        select: {
          id: true,
          nome: true,
          classificacao: true,
          localizacao: true,
          localizacao_especifica: true,
          unidade: {
            select: {
              planta_id: true
            }
          }
        }
      }),
      prisma.usuarios.findMany({
        select: { id: true, nome: true }
      })
    ]);

    console.log(`📋 Encontradas: ${plantas.length} plantas, ${equipamentos.length} equipamentos, ${usuarios.length} usuários`);

    if (plantas.length === 0 || equipamentos.length === 0 || usuarios.length === 0) {
      console.log('⚠️ Dados insuficientes. Verifique se plantas, equipamentos e usuários existem.');
      return;
    }

    // Função para encontrar equipamento por nome (busca parcial)
    const findEquipamento = (nome: string) => {
      return equipamentos.find(eq => 
        eq.nome.toLowerCase().includes(nome.toLowerCase()) ||
        nome.toLowerCase().includes(eq.nome.toLowerCase())
      );
    };

    // Função para encontrar usuário por nome (busca parcial)
    const findUsuario = (nome: string) => {
      return usuarios.find(user => 
        user.nome.toLowerCase().includes(nome.toLowerCase()) ||
        nome.toLowerCase().includes(user.nome.toLowerCase())
      );
    };

    // Função para criar histórico baseado no status
    const createHistoricoByStatus = (status: string, criado_por: string, observacoes?: string) => {
      const historicos = [
        {
          acao: 'Anomalia criada',
          usuario: criado_por,
          observacoes: observacoes || 'Anomalia registrada no sistema',
          data: new Date()
        }
      ];

      switch (status) {
        case 'EM_ANALISE':
          historicos.push({
            acao: 'Análise técnica iniciada',
            usuario: 'Equipe Técnica',
            observacoes: 'Investigação técnica em andamento',
            data: new Date()
          });
          break;
        
        case 'OS_GERADA':
          historicos.push(
            {
              acao: 'Análise técnica concluída',
              usuario: 'Equipe Técnica',
              observacoes: 'Necessária intervenção de manutenção',
              data: new Date()
            },
            {
              acao: 'Ordem de Serviço gerada',
              usuario: 'Sistema',
              observacoes: 'OS criada automaticamente',
              data: new Date()
            }
          );
          break;
        
        case 'RESOLVIDA':
          historicos.push(
            {
              acao: 'Análise técnica concluída',
              usuario: 'Equipe Técnica',
              observacoes: 'Solução identificada',
              data: new Date()
            },
            {
              acao: 'Correção aplicada',
              usuario: 'Equipe de Manutenção',
              observacoes: 'Intervenção executada com sucesso',
              data: new Date()
            },
            {
              acao: 'Anomalia resolvida',
              usuario: 'Supervisor',
              observacoes: 'Problema solucionado e testado',
              data: new Date()
            }
          );
          break;
        
        case 'CANCELADA':
          historicos.push(
            {
              acao: 'Análise técnica realizada',
              usuario: 'Equipe Técnica',
              observacoes: 'Problema não confirmado',
              data: new Date()
            },
            {
              acao: 'Anomalia cancelada',
              usuario: 'Supervisor',
              observacoes: 'Falso positivo identificado',
              data: new Date()
            }
          );
          break;
      }

      return historicos;
    };

    // Criar anomalias
    let created = 0;
    let errors = 0;

    for (const anomaliaData of anomaliasData) {
      try {
        // Buscar equipamento
        const equipamento = findEquipamento(anomaliaData.equipamento_nome);
        if (!equipamento) {
          console.log(`❌ Equipamento não encontrado: ${anomaliaData.equipamento_nome}`);
          errors++;
          continue;
        }

        // Buscar planta do equipamento através da unidade
        const planta = plantas.find(p => p.id === equipamento.unidade?.planta_id);
        if (!planta) {
          console.log(`❌ Planta não encontrada para equipamento: ${equipamento.nome}`);
          errors++;
          continue;
        }

        // Buscar usuário
        const usuario = findUsuario(anomaliaData.usuario_nome);
        if (!usuario) {
          console.log(`❌ Usuário não encontrado: ${anomaliaData.usuario_nome}`);
          // Usar um usuário padrão se disponível
          const usuarioDefault = usuarios[0];
          if (!usuarioDefault) {
            errors++;
            continue;
          }
          console.log(`ℹ️ Usando usuário padrão: ${usuarioDefault.nome}`);
        }

        const usuarioFinal = usuario || usuarios[0];

        // Criar data aleatória nos últimos 60 dias
        const dataBase = new Date();
        dataBase.setDate(dataBase.getDate() - Math.floor(Math.random() * 60));

        const historicos = createHistoricoByStatus(
          anomaliaData.status, 
          usuarioFinal.nome, 
          anomaliaData.observacoes
        );

        // Determinar local baseado no equipamento e planta
        const local = equipamento.localizacao_especifica || 
                     equipamento.localizacao || 
                     planta.nome;

        const anomalia = await prisma.anomalias.create({
          data: {
            descricao: anomaliaData.descricao,
            local: local,
            ativo: equipamento.nome,
            data: dataBase,
            condicao: anomaliaData.condicao as any,
            origem: anomaliaData.origem as any,
            status: anomaliaData.status as any,
            prioridade: anomaliaData.prioridade as any,
            observacoes: anomaliaData.observacoes,
            criado_por: usuarioFinal.nome,
            ordem_servico_id: anomaliaData.ordem_servico_id || null,
            planta_id: planta.id,
            equipamento_id: equipamento.id,
            usuario_id: usuarioFinal.id,
            created_at: dataBase,
            updated_at: dataBase,
            historico: {
              create: historicos
            }
          }
        });

        console.log(`✅ Anomalia criada: ${anomalia.descricao.substring(0, 50)}... [${anomalia.status}] - Planta: ${planta.nome}`);
        created++;

      } catch (error) {
        console.error(`❌ Erro ao criar anomalia: ${anomaliaData.descricao.substring(0, 50)}...`, error);
        errors++;
      }
    }

    // Se poucas anomalias foram criadas, criar algumas genéricas
    if (created < 5) {
      console.log('\n🔄 Criando anomalias genéricas para garantir dados...');
      
      for (let i = 0; i < 5; i++) {
        try {
          const equipamentoAleatorio = equipamentos[Math.floor(Math.random() * equipamentos.length)];
          const usuarioAleatorio = usuarios[Math.floor(Math.random() * usuarios.length)];
          const plantaAleatorio = plantas.find(p => p.id === equipamentoAleatorio.unidade?.planta_id);

          if (!plantaAleatorio) continue;

          const dataBase = new Date();
          dataBase.setDate(dataBase.getDate() - Math.floor(Math.random() * 30));

          const status = ['AGUARDANDO', 'EM_ANALISE', 'RESOLVIDA'][Math.floor(Math.random() * 3)];
          const prioridade = ['BAIXA', 'MEDIA', 'ALTA'][Math.floor(Math.random() * 3)];

          const anomalia = await prisma.anomalias.create({
            data: {
              descricao: `Anomalia genérica detectada no equipamento ${equipamentoAleatorio.nome}`,
              local: equipamentoAleatorio.localizacao || plantaAleatorio.nome,
              ativo: equipamentoAleatorio.nome,
              data: dataBase,
              condicao: 'FUNCIONANDO',
              origem: 'OPERADOR',
              status: status as any,
              prioridade: prioridade as any,
              observacoes: `Anomalia ${i + 1} criada automaticamente pelo seed`,
              criado_por: usuarioAleatorio.nome,
              planta_id: plantaAleatorio.id,
              equipamento_id: equipamentoAleatorio.id,
              usuario_id: usuarioAleatorio.id,
              created_at: dataBase,
              updated_at: dataBase,
              historico: {
                create: [
                  {
                    acao: 'Anomalia criada',
                    usuario: usuarioAleatorio.nome,
                    observacoes: 'Anomalia criada automaticamente',
                    data: dataBase
                  }
                ]
              }
            }
          });

          console.log(`✅ Anomalia genérica criada: ${anomalia.ativo} [${status}]`);
          created++;
        } catch (error) {
          console.error(`❌ Erro ao criar anomalia genérica ${i + 1}:`, error);
          errors++;
        }
      }
    }

    // Estatísticas finais
    if (created > 0) {
      const stats = await prisma.anomalias.groupBy({
        by: ['status'],
        _count: { status: true }
      });

      const statsPrioridade = await prisma.anomalias.groupBy({
        by: ['prioridade'],
        _count: { prioridade: true }
      });

      console.log('\n📊 Estatísticas das anomalias criadas:');
      console.log('Por status:');
      stats.forEach(stat => {
        console.log(`  ${stat.status}: ${stat._count.status}`);
      });

      console.log('\nPor prioridade:');
      statsPrioridade.forEach(stat => {
        console.log(`  ${stat.prioridade}: ${stat._count.prioridade}`);
      });
    }

    console.log(`\n🎉 Seed concluído! ${created} anomalias criadas, ${errors} erros.`);

  } catch (error) {
    console.error('❌ Erro ao executar seed de anomalias:', error);
    throw error;
  }
}

// Executar se chamado diretamente
if (require.main === module) {
  seedAnomalias()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}