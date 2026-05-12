import { PrismaClient } from '@aupus/api-shared';

const prisma = new PrismaClient();

const rows = await prisma.equipamentos.findMany({
  where: {
    deleted_at: null,
    OR: [
      { unidade: { nome: { contains: 'solar power', mode: 'insensitive' } } },
      { unidade: { nome: { contains: 'UFV SOLAR', mode: 'insensitive' } } },
    ],
  },
  include: {
    unidade: { select: { nome: true } },
    tipo_equipamento_rel: {
      include: { categoria: { select: { nome: true } } },
    },
  },
});

console.log(`Encontrados ${rows.length} equipamentos da unidade UFV SOLAR POWER:\n`);
for (const e of rows) {
  const cat = e.tipo_equipamento_rel?.categoria?.nome ?? '?';
  const tipo = e.tipo_equipamento_rel?.codigo ?? e.tipo_equipamento ?? '?';
  console.log(`  ${e.id} | ${e.nome} | classif=${e.classificacao} | automacao=${e.automacao} | tipo=${tipo} | categoria=${cat}`);
}

const disjuntores = rows.filter((e) => {
  const cat = e.tipo_equipamento_rel?.categoria?.nome ?? '';
  const tipo = e.tipo_equipamento_rel?.nome ?? '';
  const nome = e.nome ?? '';
  return /disjuntor/i.test(cat) || /disjuntor/i.test(tipo) || /disjuntor/i.test(nome);
});

console.log(`\n${disjuntores.length} disjuntor(es):`);
for (const d of disjuntores) {
  console.log(`  ${d.id} | ${d.nome}`);
}

await prisma.$disconnect();
