/**
 * Script para corrigir tipo_equipamento_id órfãos
 *
 * Problema: Equipamentos com tipo_equipamento_id apontando para IDs que não existem
 * Solução: Mapear IDs incorretos para os IDs corretos da tabela tipos_equipamentos
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('🔧 Iniciando correção de tipo_equipamento_id...\n');

  // Buscar todos os tipos de equipamentos válidos
  const tiposValidos = await prisma.tipos_equipamentos.findMany({
    select: {
      id: true,
      codigo: true,
    }
  });

  console.log(`✅ Encontrados ${tiposValidos.length} tipos de equipamentos válidos\n`);

  // Criar mapeamento: codigo -> id correto
  const mapeamento = tiposValidos.reduce((acc, tipo) => {
    acc[tipo.codigo] = tipo.id;
    return acc;
  }, {});

  // Buscar todos os equipamentos
  const equipamentos = await prisma.equipamentos.findMany({
    where: {
      deleted_at: null,
      tipo_equipamento_id: { not: null }
    },
    select: {
      id: true,
      nome: true,
      tipo_equipamento_id: true,
    }
  });

  console.log(`📋 Encontrados ${equipamentos.length} equipamentos com tipo_equipamento_id\n`);

  // Verificar quais equipamentos têm IDs inválidos
  const equipamentosComProblema = [];

  for (const equip of equipamentos) {
    const idAtual = equip.tipo_equipamento_id;
    const tipoExiste = tiposValidos.find(t => t.id.trim() === idAtual.trim());

    if (!tipoExiste) {
      equipamentosComProblema.push(equip);
    }
  }

  console.log(`❌ Encontrados ${equipamentosComProblema.length} equipamentos com tipo_equipamento_id inválido\n`);

  if (equipamentosComProblema.length === 0) {
    console.log('✅ Todos os equipamentos estão OK!');
    return;
  }

  // Tentar corrigir baseado em padrões comuns
  let corrigidos = 0;
  let naoCorrigidos = 0;

  for (const equip of equipamentosComProblema) {
    const idAtual = equip.tipo_equipamento_id.trim();

    // Tentar extrair o código do ID atual
    // Padrão: 01JAQTE1{CODIGO}{ZEROS}
    // Exemplo: 01JAQTE1DISJUNTOR0000008 -> DISJUNTOR

    let codigo = null;

    // Remover prefixo "01JAQTE1"
    const semPrefixo = idAtual.replace('01JAQTE1', '');

    // Tentar encontrar um código válido que case com o início
    for (const [key, value] of Object.entries(mapeamento)) {
      if (semPrefixo.startsWith(key)) {
        codigo = key;
        break;
      }
    }

    if (codigo && mapeamento[codigo]) {
      const idCorreto = mapeamento[codigo];
      console.log(`🔄 Corrigindo ${equip.nome}:`);
      console.log(`   De: "${idAtual}"`);
      console.log(`   Para: "${idCorreto.trim()}" (${codigo})`);

      try {
        await prisma.equipamentos.update({
          where: { id: equip.id },
          data: { tipo_equipamento_id: idCorreto }
        });
        corrigidos++;
      } catch (error) {
        console.log(`   ❌ Erro ao atualizar: ${error.message}`);
        naoCorrigidos++;
      }
    } else {
      console.log(`⚠️  Não foi possível determinar o código para ${equip.nome} (ID: ${idAtual})`);
      naoCorrigidos++;
    }
  }

  console.log(`\n📊 Resumo:`);
  console.log(`   ✅ Corrigidos: ${corrigidos}`);
  console.log(`   ❌ Não corrigidos: ${naoCorrigidos}`);
  console.log(`   📋 Total: ${equipamentosComProblema.length}`);
}

main()
  .catch((e) => {
    console.error('❌ Erro:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
