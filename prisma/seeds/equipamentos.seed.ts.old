import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function seedEquipamentos() {
  console.log('🌱 Seeding equipamentos...');

  // Buscar plantas existentes
  const plantas = await prisma.plantas.findMany({
    include: {
      proprietario: {
        select: {
          id: true,
          nome: true,
        }
      }
    }
  });

  if (plantas.length === 0) {
    console.log('❌ Nenhuma planta encontrada. Execute o seed de plantas primeiro.');
    return;
  }

  console.log(`✅ Encontradas ${plantas.length} plantas para criação de equipamentos`);

  // Limpar equipamentos existentes (para recriar)
  await prisma.equipamentos_dados_tecnicos.deleteMany();
  await prisma.equipamentos.deleteMany();

  // Equipamentos UC para cada planta
  const equipamentosUC = [
    // Planta Industrial São Paulo
    {
      nome: 'Sistema de Controle Principal',
      classificacao: 'UC' as const,
      planta_id: plantas.find(p => p.nome === 'Planta Industrial São Paulo')?.id,
      proprietario_id: plantas.find(p => p.nome === 'Planta Industrial São Paulo')?.proprietario_id,
      fabricante: 'Siemens',
      modelo: 'SIMATIC S7-1500',
      numero_serie: 'SIE2024001',
      criticidade: '5' as const,
      tipo_equipamento: 'sistema_controle',
      localizacao: 'Sala de Controle - Galpão Principal',
      valor_imobilizado: 15000.00,
      valor_contabil: 13500.00,
      em_operacao: 'sim',
      tipo_depreciacao: 'linear',
      vida_util: 10,
      fornecedor: 'Siemens Brasil',
      centro_custo: 'PROD-001',
      plano_manutencao: 'PM-SIS-001',
    },
    {
      nome: 'Transformador Principal TR-01',
      classificacao: 'UC' as const,
      planta_id: plantas.find(p => p.nome === 'Planta Industrial São Paulo')?.id,
      proprietario_id: plantas.find(p => p.nome === 'Planta Industrial São Paulo')?.proprietario_id,
      fabricante: 'WEG',
      modelo: 'TR-500-220',
      numero_serie: 'WEG2024001',
      criticidade: '5' as const,
      tipo_equipamento: 'transformador',
      localizacao: 'Subestação - Área Externa',
      valor_imobilizado: 85000.00,
      valor_contabil: 78000.00,
      em_operacao: 'sim',
      tipo_depreciacao: 'linear',
      vida_util: 25,
      fornecedor: 'WEG Equipamentos',
      centro_custo: 'INFRA-001',
      plano_manutencao: 'PM-TRF-001',
    },
    {
      nome: 'Esteira Transportadora Principal',
      classificacao: 'UC' as const,
      planta_id: plantas.find(p => p.nome === 'Planta Industrial São Paulo')?.id,
      proprietario_id: plantas.find(p => p.nome === 'Planta Industrial São Paulo')?.proprietario_id,
      fabricante: 'Conveyor Tech',
      modelo: 'CT-2000',
      numero_serie: 'CT2024001',
      criticidade: '3' as const,
      tipo_equipamento: 'esteira_transportadora',
      localizacao: 'Linha de Produção A',
      valor_imobilizado: 35000.00,
      valor_contabil: 31500.00,
      em_operacao: 'sim',
      tipo_depreciacao: 'uso',
      vida_util: 15,
      fornecedor: 'Conveyor Tech Ltda',
      centro_custo: 'PROD-002',
      plano_manutencao: 'PM-EST-001',
    },

    // Centro de Distribuição Rio
    {
      nome: 'Sistema de Refrigeração',
      classificacao: 'UC' as const,
      planta_id: plantas.find(p => p.nome === 'Centro de Distribuição Rio')?.id,
      proprietario_id: plantas.find(p => p.nome === 'Centro de Distribuição Rio')?.proprietario_id,
      fabricante: 'Carrier',
      modelo: 'AQUA-SNAP-150',
      numero_serie: 'CAR2024001',
      criticidade: '4' as const,
      tipo_equipamento: 'sistema_refrigeracao',
      localizacao: 'Câmara Fria - Armazém 3',
      valor_imobilizado: 45000.00,
      valor_contabil: 40500.00,
      em_operacao: 'sim',
      tipo_depreciacao: 'linear',
      vida_util: 12,
      fornecedor: 'Carrier Brasil',
      centro_custo: 'LOG-001',
      plano_manutencao: 'PM-REF-001',
    },
    {
      nome: 'Empilhadeira Elétrica',
      classificacao: 'UC' as const,
      planta_id: plantas.find(p => p.nome === 'Centro de Distribuição Rio')?.id,
      proprietario_id: plantas.find(p => p.nome === 'Centro de Distribuição Rio')?.proprietario_id,
      fabricante: 'Toyota',
      modelo: '8FBMT25',
      numero_serie: 'TOY2024001',
      criticidade: '3' as const,
      tipo_equipamento: 'empilhadeira',
      localizacao: 'Área de Armazenagem',
      valor_imobilizado: 28000.00,
      valor_contabil: 25200.00,
      em_operacao: 'sim',
      tipo_depreciacao: 'uso',
      vida_util: 10,
      fornecedor: 'Toyota Material Handling',
      centro_custo: 'LOG-002',
      plano_manutencao: 'PM-EMP-001',
    },

    // Unidade Administrativa BH
    {
      nome: 'Grupo Gerador de Emergência',
      classificacao: 'UC' as const,
      planta_id: plantas.find(p => p.nome === 'Unidade Administrativa BH')?.id,
      proprietario_id: plantas.find(p => p.nome === 'Unidade Administrativa BH')?.proprietario_id,
      fabricante: 'Caterpillar',
      modelo: 'C9-275kVA',
      numero_serie: 'CAT2024001',
      criticidade: '4' as const,
      tipo_equipamento: 'grupo_gerador',
      localizacao: 'Subsolo - Casa de Máquinas',
      valor_imobilizado: 65000.00,
      valor_contabil: 58500.00,
      em_operacao: 'sim',
      tipo_depreciacao: 'linear',
      vida_util: 20,
      fornecedor: 'Caterpillar Brasil',
      centro_custo: 'ADM-001',
      plano_manutencao: 'PM-GER-001',
    },
    {
      nome: 'Sistema de Ar Condicionado Central',
      classificacao: 'UC' as const,
      planta_id: plantas.find(p => p.nome === 'Unidade Administrativa BH')?.id,
      proprietario_id: plantas.find(p => p.nome === 'Unidade Administrativa BH')?.proprietario_id,
      fabricante: 'Trane',
      modelo: 'CGAM-150',
      numero_serie: 'TRA2024001',
      criticidade: '2' as const,
      tipo_equipamento: 'ar_condicionado',
      localizacao: 'Cobertura - Casa de Máquinas',
      valor_imobilizado: 42000.00,
      valor_contabil: 37800.00,
      em_operacao: 'sim',
      tipo_depreciacao: 'linear',
      vida_util: 15,
      fornecedor: 'Trane Brasil',
      centro_custo: 'ADM-002',
      plano_manutencao: 'PM-AC-001',
    },

    // Oficina João Silva
    {
      nome: 'Compressor de Ar Industrial',
      classificacao: 'UC' as const,
      planta_id: plantas.find(p => p.nome === 'Oficina João Silva')?.id,
      proprietario_id: plantas.find(p => p.nome === 'Oficina João Silva')?.proprietario_id,
      fabricante: 'Atlas Copco',
      modelo: 'GA 22',
      numero_serie: 'AC2024001',
      criticidade: '4' as const,
      tipo_equipamento: 'compressor',
      localizacao: 'Área de Manutenção',
      valor_imobilizado: 35000.00,
      valor_contabil: 32000.00,
      em_operacao: 'sim',
      tipo_depreciacao: 'linear',
      vida_util: 12,
      fornecedor: 'Atlas Copco Brasil',
      centro_custo: 'MAN-001',
      plano_manutencao: 'PM-COM-001',
    },
    {
      nome: 'Ponte Rolante 5 Toneladas',
      classificacao: 'UC' as const,
      planta_id: plantas.find(p => p.nome === 'Oficina João Silva')?.id,
      proprietario_id: plantas.find(p => p.nome === 'Oficina João Silva')?.proprietario_id,
      fabricante: 'Condor',
      modelo: 'PR-5000',
      numero_serie: 'CON2024001',
      criticidade: '3' as const,
      tipo_equipamento: 'ponte_rolante',
      localizacao: 'Área de Montagem',
      valor_imobilizado: 22000.00,
      valor_contabil: 19800.00,
      em_operacao: 'sim',
      tipo_depreciacao: 'uso',
      vida_util: 18,
      fornecedor: 'Condor Equipamentos',
      centro_custo: 'MAN-002',
      plano_manutencao: 'PM-PR-001',
    },
  ];

  // Filtrar equipamentos que têm planta válida
  const equipamentosValidos = equipamentosUC.filter(eq => eq.planta_id && eq.proprietario_id);

  const equipamentosCreated = [];
  for (const equipamento of equipamentosValidos) {
    const created = await prisma.equipamentos.create({
      data: equipamento,
    });
    equipamentosCreated.push(created);
    console.log(`✅ Equipamento UC criado: ${created.nome} - ${plantas.find(p => p.id === created.planta_id)?.nome}`);
  }

  // Criar componentes UAR para alguns equipamentos
  const componentesUAR = [
    // Componentes do Sistema de Controle Principal
    {
      nome: 'Sensor de Temperatura CPU',
      classificacao: 'UAR' as const,
      equipamento_pai_id: equipamentosCreated.find(e => e.nome === 'Sistema de Controle Principal')?.id,
      planta_id: equipamentosCreated.find(e => e.nome === 'Sistema de Controle Principal')?.planta_id,
      proprietario_id: equipamentosCreated.find(e => e.nome === 'Sistema de Controle Principal')?.proprietario_id,
      fabricante: 'Siemens',
      modelo: 'SITRANS T',
      numero_serie: 'SIE-TEMP-001',
      criticidade: '4' as const,
      tipo_equipamento: 'sensor_temperatura',
      localizacao_especifica: 'Painel Principal - Módulo CPU',
      plano_manutencao: 'PM-SENS-001',
    },
    {
      nome: 'Módulo de Comunicação Ethernet',
      classificacao: 'UAR' as const,
      equipamento_pai_id: equipamentosCreated.find(e => e.nome === 'Sistema de Controle Principal')?.id,
      planta_id: equipamentosCreated.find(e => e.nome === 'Sistema de Controle Principal')?.planta_id,
      proprietario_id: equipamentosCreated.find(e => e.nome === 'Sistema de Controle Principal')?.proprietario_id,
      fabricante: 'Siemens',
      modelo: 'CP343-1',
      numero_serie: 'SIE-ETH-001',
      criticidade: '3' as const,
      tipo_equipamento: 'modulo_comunicacao',
      localizacao_especifica: 'Slot 3 - Rack Principal',
      plano_manutencao: 'PM-COM-001',
    },

    // Componentes do Transformador Principal
    {
      nome: 'Relé de Proteção REL-001',
      classificacao: 'UAR' as const,
      equipamento_pai_id: equipamentosCreated.find(e => e.nome === 'Transformador Principal TR-01')?.id,
      planta_id: equipamentosCreated.find(e => e.nome === 'Transformador Principal TR-01')?.planta_id,
      proprietario_id: equipamentosCreated.find(e => e.nome === 'Transformador Principal TR-01')?.proprietario_id,
      fabricante: 'Schneider Electric',
      modelo: 'SEPAM S20',
      numero_serie: 'SCH-REL-001',
      criticidade: '5' as const,
      tipo_equipamento: 'rele_protecao',
      localizacao_especifica: 'Painel de Proteção - Lado Primário',
      plano_manutencao: 'PM-REL-001',
    },
    {
      nome: 'Termômetro Digital',
      classificacao: 'UAR' as const,
      equipamento_pai_id: equipamentosCreated.find(e => e.nome === 'Transformador Principal TR-01')?.id,
      planta_id: equipamentosCreated.find(e => e.nome === 'Transformador Principal TR-01')?.planta_id,
      proprietario_id: equipamentosCreated.find(e => e.nome === 'Transformador Principal TR-01')?.proprietario_id,
      fabricante: 'Wika',
      modelo: 'TF45',
      numero_serie: 'WIK-TEMP-001',
      criticidade: '3' as const,
      tipo_equipamento: 'termometro',
      localizacao_especifica: 'Tanque Principal - Lateral Direita',
      plano_manutencao: 'PM-TERM-001',
    },

    // Componentes do Compressor
    {
      nome: 'Filtro de Ar Comprimido',
      classificacao: 'UAR' as const,
      equipamento_pai_id: equipamentosCreated.find(e => e.nome === 'Compressor de Ar Industrial')?.id,
      planta_id: equipamentosCreated.find(e => e.nome === 'Compressor de Ar Industrial')?.planta_id,
      proprietario_id: equipamentosCreated.find(e => e.nome === 'Compressor de Ar Industrial')?.proprietario_id,
      fabricante: 'Atlas Copco',
      modelo: 'DD+ PD+',
      numero_serie: 'AC-FILT-001',
      criticidade: '3' as const,
      tipo_equipamento: 'filtro_ar',
      localizacao_especifica: 'Entrada de Ar - Lateral Esquerda',
      plano_manutencao: 'PM-FILT-001',
    },
    {
      nome: 'Válvula de Segurança',
      classificacao: 'UAR' as const,
      equipamento_pai_id: equipamentosCreated.find(e => e.nome === 'Compressor de Ar Industrial')?.id,
      planta_id: equipamentosCreated.find(e => e.nome === 'Compressor de Ar Industrial')?.planta_id,
      proprietario_id: equipamentosCreated.find(e => e.nome === 'Compressor de Ar Industrial')?.proprietario_id,
      fabricante: 'Atlas Copco',
      modelo: 'SV-22',
      numero_serie: 'AC-VALVE-001',
      criticidade: '5' as const,
      tipo_equipamento: 'valvula_seguranca',
      localizacao_especifica: 'Reservatório - Saída Principal',
      plano_manutencao: 'PM-VALV-001',
    },

    // Componente do Sistema de Refrigeração
    {
      nome: 'Sensor de Temperatura Ambiente',
      classificacao: 'UAR' as const,
      equipamento_pai_id: equipamentosCreated.find(e => e.nome === 'Sistema de Refrigeração')?.id,
      planta_id: equipamentosCreated.find(e => e.nome === 'Sistema de Refrigeração')?.planta_id,
      proprietario_id: equipamentosCreated.find(e => e.nome === 'Sistema de Refrigeração')?.proprietario_id,
      fabricante: 'Honeywell',
      modelo: 'T775A',
      numero_serie: 'HON-TEMP-001',
      criticidade: '4' as const,
      tipo_equipamento: 'sensor_temperatura',
      localizacao_especifica: 'Câmara Fria - Parede Central',
      plano_manutencao: 'PM-SENS-002',
    },
  ];

  // Filtrar componentes que têm equipamento pai válido
  const componentesValidos = componentesUAR.filter(comp => comp.equipamento_pai_id);

  for (const componente of componentesValidos) {
    const created = await prisma.equipamentos.create({
      data: componente,
    });
    const equipamentoPai = equipamentosCreated.find(e => e.id === componente.equipamento_pai_id);
    console.log(`✅ Componente UAR criado: ${created.nome} -> ${equipamentoPai?.nome}`);
  }

  // Criar alguns dados técnicos
  const dadosTecnicos = [
    // Sistema de Controle Principal
    {
      equipamento_id: equipamentosCreated.find(e => e.nome === 'Sistema de Controle Principal')?.id,
      campo: 'memoria_ram',
      valor: '4',
      tipo: 'number',
      unidade: 'GB',
    },
    {
      equipamento_id: equipamentosCreated.find(e => e.nome === 'Sistema de Controle Principal')?.id,
      campo: 'temperatura_operacao',
      valor: '-25 a +60',
      tipo: 'text',
      unidade: '°C',
    },

    // Transformador
    {
      equipamento_id: equipamentosCreated.find(e => e.nome === 'Transformador Principal TR-01')?.id,
      campo: 'potencia_nominal',
      valor: '500',
      tipo: 'number',
      unidade: 'kVA',
    },
    {
      equipamento_id: equipamentosCreated.find(e => e.nome === 'Transformador Principal TR-01')?.id,
      campo: 'tensao_primaria',
      valor: '13800',
      tipo: 'number',
      unidade: 'V',
    },
    {
      equipamento_id: equipamentosCreated.find(e => e.nome === 'Transformador Principal TR-01')?.id,
      campo: 'tensao_secundaria',
      valor: '220',
      tipo: 'number',
      unidade: 'V',
    },

    // Compressor
    {
      equipamento_id: equipamentosCreated.find(e => e.nome === 'Compressor de Ar Industrial')?.id,
      campo: 'pressao_trabalho',
      valor: '8',
      tipo: 'number',
      unidade: 'bar',
    },
    {
      equipamento_id: equipamentosCreated.find(e => e.nome === 'Compressor de Ar Industrial')?.id,
      campo: 'vazao_ar',
      valor: '3.5',
      tipo: 'number',
      unidade: 'm³/min',
    },
  ];

  const dadosValidos = dadosTecnicos.filter(dado => dado.equipamento_id);

  for (const dadoTecnico of dadosValidos) {
    await prisma.equipamentos_dados_tecnicos.create({
      data: dadoTecnico,
    });
  }

  console.log(`✅ Criados ${equipamentosCreated.length} equipamentos UC`);
  console.log(`✅ Criados ${componentesValidos.length} componentes UAR`);
  console.log(`✅ Criados ${dadosValidos.length} dados técnicos`);
  console.log('🎉 Seed de equipamentos concluído!');
}

// Para uso independente
if (require.main === module) {
  seedEquipamentos()
    .catch((e) => {
      console.error('❌ Erro no seed de equipamentos:', e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}