import { PrismaClient } from '@aupus/api-shared';
const prisma = new PrismaClient();
const ids = [
  'cmhdhak3r00bfjqo84ubgtvw8',
  'cmhcg3iqt000pjqo8p05xpfqi',
  'cmhde7fuo0036jqo8p414ge4c',
  'cmhde2va3002qjqo84cz11y2z',
  'cmhddxhld002ojqo81j796hsv',
];
const rows = await prisma.equipamentos.findMany({
  where: { id: { in: ids } },
  select: { id: true, nome: true, classificacao: true, automacao: true, equipamento_pai_id: true },
});
for (const r of rows) {
  console.log(`${r.id} | ${r.nome.padEnd(15)} | classif=${r.classificacao} | automacao=${r.automacao} | pai=${r.equipamento_pai_id ?? 'NULL'}`);
}
await prisma.$disconnect();
