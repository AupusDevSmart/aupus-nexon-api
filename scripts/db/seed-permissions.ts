/**
 * SEED: Permissões Modernas - Sistema Padronizado
 *
 * Este seed popula a tabela `permissions` com todas as permissões
 * seguindo o padrão moderno: recurso.acao
 */

import { PrismaClient } from '@aupus/api-shared';
import { getAllPermissions } from './permissions-structure';

const prisma = new PrismaClient();

async function seedPermissions() {
  console.log('🌱 Iniciando seed de permissões...\n');

  const permissions = getAllPermissions();

  console.log(`📋 Total de permissões a criar: ${permissions.length}\n`);

  let created = 0;
  let skipped = 0;

  for (const permission of permissions) {
    try {
      // Verificar se já existe
      const existing = await prisma.permissions.findFirst({
        where: { name: permission.name }
      });

      if (existing) {
        console.log(`⏭️  Pulando: ${permission.name} (já existe)`);
        skipped++;

        // Atualizar display_name e description se mudaram
        await prisma.permissions.update({
          where: { id: existing.id },
          data: {
            display_name: permission.display_name,
            description: permission.description,
          }
        });

        continue;
      }

      // Criar nova permissão
      await prisma.permissions.create({
        data: {
          name: permission.name,
          display_name: permission.display_name,
          description: permission.description,
          guard_name: 'web',
        }
      });

      console.log(`✅ Criada: ${permission.name}`);
      created++;

    } catch (error) {
      console.error(`❌ Erro ao criar ${permission.name}:`, error);
    }
  }

  console.log(`\n📊 Resumo:`);
  console.log(`   ✅ Criadas: ${created}`);
  console.log(`   ⏭️  Puladas: ${skipped}`);
  console.log(`   📋 Total: ${permissions.length}`);
}

async function cleanOldPermissions() {
  console.log('\n🧹 Limpando permissões antigas (opcional)...\n');

  // Lista de permissões legadas que podem ser removidas
  const legacyPermissions = [
    'MonitoramentoConsumo',
    'GeracaoEnergia',
    'Oportunidades',
    'Prospeccao',
    'Financeiro',
    'AreaDoAssociado',
    'AreaDoProprietario',
    'Associados',
    'Organizacoes',
    'Usuarios',
    'UnidadesConsumidoras',
    'Configuracoes',
    'Documentos',
    'Arquivos',
    'CadastroConcessionarias',
    'CadastroOrganizacoes',
    'Cadastros',
    'CadastroUnidadesConsumidoras',
    'CadastroUsuarios',
    'FinanceiroAdmin',
    'FinanceiroConsultor',
    'Monitoramento',
    'MonitoramentoOrganizacoes',
    'NET',
    'PainelGeral',
    'PainelGeralCativos',
    'PainelGeralClube',
    'PainelGeralOrganizacoes',
    'Reclamacoes',
    'SuperAdmin',
    'CRM',
    'MinhasUsinas',
    'Equipamentos',
    'Plantas',
    'Dashboard',
  ];

  let deleted = 0;

  for (const legacyName of legacyPermissions) {
    try {
      const result = await prisma.permissions.deleteMany({
        where: { name: legacyName }
      });

      if (result.count > 0) {
        console.log(`🗑️  Removida: ${legacyName}`);
        deleted += result.count;
      }
    } catch (error) {
      console.error(`❌ Erro ao remover ${legacyName}:`, error);
    }
  }

  console.log(`\n📊 Total de permissões legadas removidas: ${deleted}`);
}

async function seedRoles() {
  console.log('\n🔑 Verificando roles do sistema...\n');

  const requiredRoles = [
    'super_admin',
    'admin',
    'gerente',
    'analista',
    'proprietario',
    'operador',
  ];

  for (const roleName of requiredRoles) {
    const existing = await prisma.roles.findFirst({
      where: { name: roleName },
    });

    if (existing) {
      console.log(`⏭️  Role já existe: ${roleName}`);
    } else {
      await prisma.roles.create({
        data: {
          name: roleName,
          guard_name: 'web',
        },
      });
      console.log(`✅ Role criada: ${roleName}`);
    }
  }
}

async function main() {
  console.log('═'.repeat(60));
  console.log('  SEED DE PERMISSÕES - SISTEMA PADRONIZADO');
  console.log('═'.repeat(60));
  console.log();

  try {
    // Criar permissões modernas
    await seedPermissions();

    // Garantir que todas as roles necessárias existam
    await seedRoles();

    // Perguntar se quer limpar as antigas (comentado por segurança)
    // await cleanOldPermissions();

    console.log('\n✅ Seed de permissões e roles concluído com sucesso!\n');

  } catch (error) {
    console.error('\n❌ Erro durante o seed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
