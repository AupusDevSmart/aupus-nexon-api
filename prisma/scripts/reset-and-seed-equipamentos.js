/**
 * Script para resetar e popular tabelas de equipamentos
 *
 * Este script:
 * 1. Remove todos os equipamentos e dados relacionados
 * 2. Popula com equipamentos realistas e completos
 * 3. Associa corretamente com tipos de equipamentos
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('🔄 Iniciando reset e seed de equipamentos...\n');

  // ============================================
  // PASSO 1: LIMPAR DADOS EXISTENTES
  // ============================================
  console.log('🗑️  PASSO 1: Limpando dados existentes...\n');

  // Deletar na ordem correta para evitar constraints

  // 1. Deletar tarefas_os (depende de tarefas)
  const deletedTarefasOS = await prisma.tarefas_os.deleteMany({});
  console.log(`   ✅ Removidas ${deletedTarefasOS.count} tarefas_os`);

  // 2. Deletar tarefas_programacao_os (depende de tarefas)
  const deletedTarefasProgOS = await prisma.tarefas_programacao_os.deleteMany({});
  console.log(`   ✅ Removidas ${deletedTarefasProgOS.count} tarefas_programacao_os`);

  // 3. Deletar TODAS as tarefas
  const deletedTarefas = await prisma.tarefas.deleteMany({});
  console.log(`   ✅ Removidas ${deletedTarefas.count} tarefas`);

  // 4. Deletar ordens de serviço (depende de programacoes_os)
  const deletedOS = await prisma.ordens_servico.deleteMany({});
  console.log(`   ✅ Removidas ${deletedOS.count} ordens de serviço`);

  // 5. Deletar programações de OS
  const deletedProgramacoes = await prisma.programacoes_os.deleteMany({});
  console.log(`   ✅ Removidas ${deletedProgramacoes.count} programações OS`);

  // 5. Deletar TODOS os planos de manutenção
  const deletedPlanos = await prisma.planos_manutencao.deleteMany({});
  console.log(`   ✅ Removidos ${deletedPlanos.count} planos de manutenção`);

  // 6. Deletar anexos de anomalias
  const deletedAnexosAnomalias = await prisma.anexos_anomalias.deleteMany({});
  console.log(`   ✅ Removidos ${deletedAnexosAnomalias.count} anexos de anomalias`);

  // 7. Deletar histórico de anomalias
  const deletedHistoricoAnomalias = await prisma.historico_anomalias.deleteMany({});
  console.log(`   ✅ Removidos ${deletedHistoricoAnomalias.count} históricos de anomalias`);

  // 8. Deletar TODAS as anomalias
  const deletedAnomalias = await prisma.anomalias.deleteMany({});
  console.log(`   ✅ Removidas ${deletedAnomalias.count} anomalias`);

  // Deletar equipamentos_conexoes
  const deletedConexoes = await prisma.equipamentos_conexoes.deleteMany({});
  console.log(`   ✅ Removidas ${deletedConexoes.count} conexões`);

  // Deletar equipamentos_dados (dados históricos MQTT)
  const deletedDados = await prisma.equipamentos_dados.deleteMany({});
  console.log(`   ✅ Removidos ${deletedDados.count} dados históricos`);

  // Deletar equipamentos_dados_tecnicos
  const deletedDadosTecnicos = await prisma.equipamentos_dados_tecnicos.deleteMany({});
  console.log(`   ✅ Removidos ${deletedDadosTecnicos.count} dados técnicos`);

  // Deletar todos os equipamentos
  const deletedEquipamentos = await prisma.equipamentos.deleteMany({});
  console.log(`   ✅ Removidos ${deletedEquipamentos.count} equipamentos\n`);

  // ============================================
  // PASSO 2: BUSCAR DADOS DE REFERÊNCIA
  // ============================================
  console.log('📋 PASSO 2: Buscando dados de referência...\n');

  // Buscar unidades disponíveis
  const unidades = await prisma.unidades.findMany({
    where: { deleted_at: null },
    include: {
      planta: true
    },
    take: 20
  });
  console.log(`   ✅ Encontradas ${unidades.length} unidades`);

  // Buscar tipos de equipamentos
  const tiposEquipamentos = await prisma.tipos_equipamentos.findMany({});
  console.log(`   ✅ Encontrados ${tiposEquipamentos.length} tipos de equipamentos\n`);

  // Criar mapa de tipos por código
  const tiposPorCodigo = {};
  tiposEquipamentos.forEach(tipo => {
    tiposPorCodigo[tipo.codigo] = tipo;
  });

  // ============================================
  // PASSO 3: POPULAR EQUIPAMENTOS
  // ============================================
  console.log('📦 PASSO 3: Populando equipamentos...\n');

  let totalCriados = 0;

  for (const unidade of unidades) {
    console.log(`\n   🏢 Unidade: ${unidade.nome} (${unidade.tipo})`);

    const equipamentos = [];

    // Definir equipamentos baseado no tipo de unidade
    switch (unidade.tipo) {
      case 'UFV': // Usina Fotovoltaica
        equipamentos.push(
          // Medidores
          {
            nome: `Medidor Principal - ${unidade.nome}`,
            tag: `MED-${unidade.nome.substring(0, 3).toUpperCase()}-01`,
            classificacao: 'UC',
            tipo_equipamento_id: tiposPorCodigo['MEDIDOR']?.id,
            fabricante: 'Landis+Gyr',
            modelo: 'E750',
            numero_serie: `LG${Date.now().toString().slice(-10)}`,
            criticidade: '1',
            em_operacao: 'sim',
            localizacao: 'Subestação Principal',
            valor_imobilizado: '15000',
            valor_contabil: '13500',
            vida_util: 15,
            status: 'NORMAL'
          },
          // Transformador
          {
            nome: `Transformador Principal - ${unidade.nome}`,
            tag: `TRF-${unidade.nome.substring(0, 3).toUpperCase()}-01`,
            classificacao: 'UC',
            tipo_equipamento_id: tiposPorCodigo['TRANSFORMADOR']?.id,
            fabricante: 'WEG',
            modelo: 'TTR-500',
            numero_serie: `WEG${Date.now().toString().slice(-10)}`,
            criticidade: '1',
            em_operacao: 'sim',
            localizacao: 'Subestação',
            valor_imobilizado: '250000',
            valor_contabil: '220000',
            vida_util: 25,
            status: 'NORMAL'
          },
          // Inversores
          {
            nome: `Inversor Central 1 - ${unidade.nome}`,
            tag: `INV-${unidade.nome.substring(0, 3).toUpperCase()}-01`,
            classificacao: 'UC',
            tipo_equipamento_id: tiposPorCodigo['INVERSOR']?.id,
            fabricante: 'ABB',
            modelo: 'PVS-100-TL',
            numero_serie: `ABB${Date.now().toString().slice(-10)}`,
            criticidade: '2',
            em_operacao: 'sim',
            localizacao: 'Casa de Inversores',
            valor_imobilizado: '180000',
            valor_contabil: '160000',
            vida_util: 20,
            status: 'NORMAL'
          },
          {
            nome: `Inversor Central 2 - ${unidade.nome}`,
            tag: `INV-${unidade.nome.substring(0, 3).toUpperCase()}-02`,
            classificacao: 'UC',
            tipo_equipamento_id: tiposPorCodigo['INVERSOR']?.id,
            fabricante: 'ABB',
            modelo: 'PVS-100-TL',
            numero_serie: `ABB${(Date.now() + 1).toString().slice(-10)}`,
            criticidade: '2',
            em_operacao: 'sim',
            localizacao: 'Casa de Inversores',
            valor_imobilizado: '180000',
            valor_contabil: '160000',
            vida_util: 20,
            status: 'NORMAL'
          },
          // String Boxes
          {
            nome: `String Box 1 - ${unidade.nome}`,
            tag: `SB-${unidade.nome.substring(0, 3).toUpperCase()}-01`,
            classificacao: 'UC',
            tipo_equipamento_id: tiposPorCodigo['DISJUNTOR']?.id,
            fabricante: 'Phoenix Contact',
            modelo: 'SB-16-1',
            numero_serie: `SB${Date.now().toString().slice(-10)}`,
            criticidade: '3',
            em_operacao: 'sim',
            localizacao: 'String 1',
            valor_imobilizado: '8000',
            valor_contabil: '7200',
            vida_util: 20,
            status: 'NORMAL'
          },
          {
            nome: `String Box 2 - ${unidade.nome}`,
            tag: `SB-${unidade.nome.substring(0, 3).toUpperCase()}-02`,
            classificacao: 'UC',
            tipo_equipamento_id: tiposPorCodigo['DISJUNTOR']?.id,
            fabricante: 'Phoenix Contact',
            modelo: 'SB-16-2',
            numero_serie: `SB${(Date.now() + 1).toString().slice(-10)}`,
            criticidade: '3',
            em_operacao: 'sim',
            localizacao: 'String 2',
            valor_imobilizado: '8000',
            valor_contabil: '7200',
            vida_util: 20,
            status: 'NORMAL'
          },
          {
            nome: `String Box 3 - ${unidade.nome}`,
            tag: `SB-${unidade.nome.substring(0, 3).toUpperCase()}-03`,
            classificacao: 'UC',
            tipo_equipamento_id: tiposPorCodigo['DISJUNTOR']?.id,
            fabricante: 'Phoenix Contact',
            modelo: 'SB-16-3',
            numero_serie: `SB${(Date.now() + 2).toString().slice(-10)}`,
            criticidade: '3',
            em_operacao: 'sim',
            localizacao: 'String 3',
            valor_imobilizado: '8000',
            valor_contabil: '7200',
            vida_util: 20,
            status: 'NORMAL'
          },
          // Disjuntores
          {
            nome: `Disjuntor Geral - ${unidade.nome}`,
            tag: `DJ-${unidade.nome.substring(0, 3).toUpperCase()}-01`,
            classificacao: 'UC',
            tipo_equipamento_id: tiposPorCodigo['DISJUNTOR']?.id,
            fabricante: 'Schneider Electric',
            modelo: 'NSX400',
            numero_serie: `SE${Date.now().toString().slice(-10)}`,
            criticidade: '1',
            em_operacao: 'sim',
            localizacao: 'Quadro Principal',
            valor_imobilizado: '12000',
            valor_contabil: '10800',
            vida_util: 25,
            status: 'NORMAL'
          }
        );
        break;

      case 'Transformador':
        equipamentos.push(
          {
            nome: `Transformador Principal - ${unidade.nome}`,
            tag: `TRF-${unidade.nome.substring(0, 3).toUpperCase()}-01`,
            classificacao: 'UC',
            tipo_equipamento_id: tiposPorCodigo['TRANSFORMADOR']?.id,
            fabricante: 'WEG',
            modelo: 'TTR-2500',
            numero_serie: `WEG${Date.now().toString().slice(-10)}`,
            criticidade: '1',
            em_operacao: 'sim',
            localizacao: 'Subestação Principal',
            valor_imobilizado: '500000',
            valor_contabil: '450000',
            vida_util: 30,
            status: 'NORMAL'
          },
          {
            nome: `Medidor AT - ${unidade.nome}`,
            tag: `MED-AT-${unidade.nome.substring(0, 3).toUpperCase()}`,
            classificacao: 'UC',
            tipo_equipamento_id: tiposPorCodigo['MEDIDOR']?.id,
            fabricante: 'Landis+Gyr',
            modelo: 'E650',
            numero_serie: `LG${Date.now().toString().slice(-10)}`,
            criticidade: '1',
            em_operacao: 'sim',
            localizacao: 'Primário',
            valor_imobilizado: '18000',
            valor_contabil: '16200',
            vida_util: 15,
            status: 'NORMAL'
          },
          {
            nome: `Medidor BT - ${unidade.nome}`,
            tag: `MED-BT-${unidade.nome.substring(0, 3).toUpperCase()}`,
            classificacao: 'UC',
            tipo_equipamento_id: tiposPorCodigo['MEDIDOR']?.id,
            fabricante: 'Landis+Gyr',
            modelo: 'E350',
            numero_serie: `LG${(Date.now() + 1).toString().slice(-10)}`,
            criticidade: '2',
            em_operacao: 'sim',
            localizacao: 'Secundário',
            valor_imobilizado: '10000',
            valor_contabil: '9000',
            vida_util: 15,
            status: 'NORMAL'
          },
          {
            nome: `Disjuntor AT - ${unidade.nome}`,
            tag: `DJ-AT-${unidade.nome.substring(0, 3).toUpperCase()}`,
            classificacao: 'UC',
            tipo_equipamento_id: tiposPorCodigo['DISJUNTOR']?.id,
            fabricante: 'Schneider Electric',
            modelo: 'NSX630',
            numero_serie: `SE${Date.now().toString().slice(-10)}`,
            criticidade: '1',
            em_operacao: 'sim',
            localizacao: 'Primário',
            valor_imobilizado: '25000',
            valor_contabil: '22500',
            vida_util: 25,
            status: 'NORMAL'
          }
        );
        break;

      case 'Inversor':
        equipamentos.push(
          {
            nome: `Inversor Central - ${unidade.nome}`,
            tag: `INV-${unidade.nome.substring(0, 3).toUpperCase()}-01`,
            classificacao: 'UC',
            tipo_equipamento_id: tiposPorCodigo['INVERSOR']?.id,
            fabricante: 'SMA',
            modelo: 'Sunny Central 500',
            numero_serie: `SMA${Date.now().toString().slice(-10)}`,
            criticidade: '1',
            em_operacao: 'sim',
            localizacao: 'Casa de Inversores',
            valor_imobilizado: '250000',
            valor_contabil: '225000',
            vida_util: 20,
            status: 'NORMAL'
          },
          {
            nome: `Medidor DC - ${unidade.nome}`,
            tag: `MED-DC-${unidade.nome.substring(0, 3).toUpperCase()}`,
            classificacao: 'UC',
            tipo_equipamento_id: tiposPorCodigo['MEDIDOR']?.id,
            fabricante: 'Phoenix Contact',
            modelo: 'DC-Meter-100',
            numero_serie: `PC${Date.now().toString().slice(-10)}`,
            criticidade: '2',
            em_operacao: 'sim',
            localizacao: 'Entrada DC',
            valor_imobilizado: '5000',
            valor_contabil: '4500',
            vida_util: 10,
            status: 'NORMAL'
          },
          {
            nome: `Medidor AC - ${unidade.nome}`,
            tag: `MED-AC-${unidade.nome.substring(0, 3).toUpperCase()}`,
            classificacao: 'UC',
            tipo_equipamento_id: tiposPorCodigo['MEDIDOR']?.id,
            fabricante: 'Landis+Gyr',
            modelo: 'E450',
            numero_serie: `LG${Date.now().toString().slice(-10)}`,
            criticidade: '2',
            em_operacao: 'sim',
            localizacao: 'Saída AC',
            valor_imobilizado: '12000',
            valor_contabil: '10800',
            vida_util: 15,
            status: 'NORMAL'
          }
        );
        break;

      case 'Motor':
        equipamentos.push(
          {
            nome: `Motor Principal - ${unidade.nome}`,
            tag: `MOT-${unidade.nome.substring(0, 3).toUpperCase()}-01`,
            classificacao: 'UC',
            tipo_equipamento_id: tiposPorCodigo['MOTOR']?.id,
            fabricante: 'WEG',
            modelo: 'W22-150HP',
            numero_serie: `WEG${Date.now().toString().slice(-10)}`,
            criticidade: '1',
            em_operacao: 'sim',
            localizacao: 'Sala de Máquinas',
            valor_imobilizado: '85000',
            valor_contabil: '76500',
            vida_util: 20,
            status: 'NORMAL'
          },
          {
            nome: `Medidor do Motor - ${unidade.nome}`,
            tag: `MED-MOT-${unidade.nome.substring(0, 3).toUpperCase()}`,
            classificacao: 'UC',
            tipo_equipamento_id: tiposPorCodigo['MEDIDOR']?.id,
            fabricante: 'Schneider Electric',
            modelo: 'PM5560',
            numero_serie: `SE${Date.now().toString().slice(-10)}`,
            criticidade: '2',
            em_operacao: 'sim',
            localizacao: 'Painel do Motor',
            valor_imobilizado: '8000',
            valor_contabil: '7200',
            vida_util: 15,
            status: 'NORMAL'
          },
          {
            nome: `Soft Starter - ${unidade.nome}`,
            tag: `SS-${unidade.nome.substring(0, 3).toUpperCase()}-01`,
            classificacao: 'UC',
            tipo_equipamento_id: tiposPorCodigo['RELE']?.id,
            fabricante: 'WEG',
            modelo: 'SSW06',
            numero_serie: `WEG${(Date.now() + 1).toString().slice(-10)}`,
            criticidade: '2',
            em_operacao: 'sim',
            localizacao: 'Painel de Comando',
            valor_imobilizado: '15000',
            valor_contabil: '13500',
            vida_util: 15,
            status: 'NORMAL'
          }
        );
        break;

      case 'Carga':
        equipamentos.push(
          {
            nome: `Quadro Distribuição - ${unidade.nome}`,
            tag: `QD-${unidade.nome.substring(0, 3).toUpperCase()}-01`,
            classificacao: 'UC',
            tipo_equipamento_id: tiposPorCodigo['DISJUNTOR']?.id,
            fabricante: 'Schneider Electric',
            modelo: 'QD-400A',
            numero_serie: `SE${Date.now().toString().slice(-10)}`,
            criticidade: '2',
            em_operacao: 'sim',
            localizacao: 'Entrada Principal',
            valor_imobilizado: '20000',
            valor_contabil: '18000',
            vida_util: 25,
            status: 'NORMAL'
          },
          {
            nome: `Medidor de Consumo - ${unidade.nome}`,
            tag: `MED-${unidade.nome.substring(0, 3).toUpperCase()}-01`,
            classificacao: 'UC',
            tipo_equipamento_id: tiposPorCodigo['MEDIDOR']?.id,
            fabricante: 'Landis+Gyr',
            modelo: 'E450',
            numero_serie: `LG${Date.now().toString().slice(-10)}`,
            criticidade: '1',
            em_operacao: 'sim',
            localizacao: 'Entrada',
            valor_imobilizado: '10000',
            valor_contabil: '9000',
            vida_util: 15,
            status: 'NORMAL'
          },
          {
            nome: `Banco de Capacitores - ${unidade.nome}`,
            tag: `BC-${unidade.nome.substring(0, 3).toUpperCase()}-01`,
            classificacao: 'UC',
            tipo_equipamento_id: tiposPorCodigo['CAPACITOR']?.id,
            fabricante: 'WEG',
            modelo: 'BC-150kVAr',
            numero_serie: `WEG${Date.now().toString().slice(-10)}`,
            criticidade: '3',
            em_operacao: 'sim',
            localizacao: 'Quadro Principal',
            valor_imobilizado: '30000',
            valor_contabil: '27000',
            vida_util: 20,
            status: 'NORMAL'
          }
        );
        break;

      default:
        // Equipamentos genéricos
        equipamentos.push(
          {
            nome: `Medidor Principal - ${unidade.nome}`,
            tag: `MED-${unidade.nome.substring(0, 3).toUpperCase()}-01`,
            classificacao: 'UC',
            tipo_equipamento_id: tiposPorCodigo['MEDIDOR']?.id,
            fabricante: 'Genérico',
            modelo: 'MED-001',
            numero_serie: `GEN${Date.now().toString().slice(-10)}`,
            criticidade: '2',
            em_operacao: 'sim',
            localizacao: 'Principal',
            valor_imobilizado: '5000',
            valor_contabil: '4500',
            vida_util: 10,
            status: 'NORMAL'
          }
        );
    }

    // Criar os equipamentos no banco
    for (const equipData of equipamentos) {
      const equipamento = await prisma.equipamentos.create({
        data: {
          ...equipData,
          unidade_id: unidade.id,
          planta_id: unidade.planta_id,
        }
      });
      console.log(`      ✅ ${equipamento.nome}`);
      totalCriados++;
    }
  }

  console.log(`\n✅ Total de equipamentos criados: ${totalCriados}\n`);

  console.log('🎉 Seed concluído com sucesso!\n');
}

main()
  .catch((e) => {
    console.error('❌ Erro:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
