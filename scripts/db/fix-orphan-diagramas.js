/**
 * Script para identificar e corrigir registros órfãos em diagramas_unitarios
 * Execução: node prisma/scripts/fix-orphan-diagramas.js
 */

const { PrismaClient } = require('@aupus/api-shared');

const prisma = new PrismaClient();

async function main() {
  console.log('🔍 Verificando registros órfãos em diagramas_unitarios...\n');

  try {
    // 1. Buscar todos os diagramas
    const diagramas = await prisma.$queryRaw`
      SELECT
        d.id,
        d.unidade_id,
        d.nome,
        d.created_at
      FROM diagramas_unitarios d
      LEFT JOIN unidades u ON d.unidade_id = u.id
      WHERE u.id IS NULL
    `;

    if (diagramas.length === 0) {
      console.log('✅ Nenhum registro órfão encontrado!');
      console.log('   Você pode executar: npx prisma db push\n');
      return;
    }

    console.log(`⚠️  Encontrados ${diagramas.length} registro(s) órfão(s):\n`);
    console.table(diagramas);

    // 2. Verificar se existem unidades disponíveis
    const unidadesDisponiveis = await prisma.unidades.findMany({
      where: { deleted_at: null },
      select: {
        id: true,
        nome: true,
        tipo: true,
        status: true
      },
      take: 5,
      orderBy: { created_at: 'desc' }
    });

    console.log('\n📋 Unidades disponíveis para reassociação:');
    console.table(unidadesDisponiveis);

    console.log('\n🛠️  OPÇÕES DE CORREÇÃO:\n');
    console.log('1. SOFT DELETE (Recomendado)');
    console.log('   Marcar os diagramas órfãos como deletados');
    console.log('   Comando: node prisma/scripts/fix-orphan-diagramas.js --soft-delete\n');

    console.log('2. HARD DELETE');
    console.log('   Deletar permanentemente os diagramas órfãos');
    console.log('   Comando: node prisma/scripts/fix-orphan-diagramas.js --hard-delete\n');

    if (unidadesDisponiveis.length > 0) {
      console.log('3. REASSOCIAR');
      console.log('   Associar a uma unidade existente');
      console.log(`   Comando: node prisma/scripts/fix-orphan-diagramas.js --reassociar ${unidadesDisponiveis[0].id}\n`);
    }

    // 3. Executar ação se argumento foi passado
    const action = process.argv[2];
    const targetId = process.argv[3];

    if (action === '--soft-delete') {
      console.log('🗑️  Executando SOFT DELETE...');

      const result = await prisma.$executeRaw`
        UPDATE diagramas_unitarios
        SET deleted_at = NOW()
        WHERE id IN (
          SELECT d.id
          FROM diagramas_unitarios d
          LEFT JOIN unidades u ON d.unidade_id = u.id
          WHERE u.id IS NULL
        )
      `;

      console.log(`✅ ${result} registro(s) marcado(s) como deletado(s)`);
      console.log('   Execute agora: npx prisma db push\n');

    } else if (action === '--hard-delete') {
      console.log('🗑️  Executando HARD DELETE...');
      console.log('⚠️  ATENÇÃO: Esta ação é IRREVERSÍVEL!\n');

      // Primeiro deletar conexões associadas se existirem
      await prisma.$executeRaw`
        DELETE FROM equipamentos_conexoes
        WHERE diagrama_id IN (
          SELECT d.id
          FROM diagramas_unitarios d
          LEFT JOIN unidades u ON d.unidade_id = u.id
          WHERE u.id IS NULL
        )
      `;

      // Limpar referências em equipamentos
      await prisma.$executeRaw`
        UPDATE equipamentos
        SET diagrama_id = NULL,
            posicao_x = NULL,
            posicao_y = NULL
        WHERE diagrama_id IN (
          SELECT d.id
          FROM diagramas_unitarios d
          LEFT JOIN unidades u ON d.unidade_id = u.id
          WHERE u.id IS NULL
        )
      `;

      // Deletar diagramas
      const result = await prisma.$executeRaw`
        DELETE FROM diagramas_unitarios
        WHERE id IN (
          SELECT d.id
          FROM diagramas_unitarios d
          LEFT JOIN unidades u ON d.unidade_id = u.id
          WHERE u.id IS NULL
        )
      `;

      console.log(`✅ ${result} registro(s) deletado(s) permanentemente`);
      console.log('   Execute agora: npx prisma db push\n');

    } else if (action === '--reassociar' && targetId) {
      console.log(`🔄 Reassociando diagramas para unidade: ${targetId}...`);

      // Verificar se a unidade existe
      const unidade = await prisma.unidades.findUnique({
        where: { id: targetId }
      });

      if (!unidade) {
        console.error(`❌ Erro: Unidade ${targetId} não encontrada!`);
        process.exit(1);
      }

      const result = await prisma.$executeRaw`
        UPDATE diagramas_unitarios
        SET unidade_id = ${targetId}
        WHERE id IN (
          SELECT d.id
          FROM diagramas_unitarios d
          LEFT JOIN unidades u ON d.unidade_id = u.id
          WHERE u.id IS NULL
        )
      `;

      console.log(`✅ ${result} registro(s) reassociado(s) para a unidade: ${unidade.nome}`);
      console.log('   Execute agora: npx prisma db push\n');
    }

  } catch (error) {
    console.error('❌ Erro:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
