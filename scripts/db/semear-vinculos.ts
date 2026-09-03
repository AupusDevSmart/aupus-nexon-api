/**
 * Semeia os vinculos a partir do que os dois bancos JA compartilham.
 *
 * Os dois nasceram do mesmo banco no split de 2026-09, entao hoje carregam os
 * mesmos ids: 58 usuarios, 9 plantas, 23 instalacoes e 254 equipamentos existem
 * dos dois lados. Sao os mesmos registros — a duplicacao ja aconteceu, e a
 * unica coisa que falta e o sistema saber disso.
 *
 * Sem este seed, o estado inicial seria "nada compartilhado" e alguem teria de
 * clicar em compartilhar 344 vezes para registrar uma realidade que ja existe.
 * Pior: ate esse clique, editar uma planta nos dois lados divergiria em
 * silencio, que e exatamente o que a sincronizacao existe para evitar.
 *
 * NAO enfileira nada. Marcar como vinculado e diferente de mandar: os registros
 * ja estao iguais dos dois lados, e enfileirar 344 eventos so geraria 344
 * chamadas para reescrever o que ja esta la. A partir daqui, so mudanca de
 * verdade atravessa.
 *
 * Simula por padrao. `--aplicar` para gravar.
 *
 *   npx ts-node scripts/db/semear-vinculos.ts
 *   npx ts-node scripts/db/semear-vinculos.ts --aplicar
 */
import { PrismaClient } from '@prisma/client';

const RECURSOS = ['usuarios', 'plantas', 'unidades', 'equipamentos'] as const;

async function main() {
  const aplicar = process.argv.includes('--aplicar');

  const urlOutro = process.env.SINCRONIZACAO_OUTRO_BANCO_URL;
  if (!urlOutro) {
    console.error(
      'Falta SINCRONIZACAO_OUTRO_BANCO_URL: a URL do banco do OUTRO produto.\n' +
      'E so de leitura, e so para descobrir quais ids ja existem nos dois.',
    );
    process.exit(1);
  }

  const aqui = new PrismaClient();
  const la = new PrismaClient({ datasources: { db: { url: urlOutro } } });

  const no = await aqui.sincronizacao_no.findFirst({ select: { origem: true } });
  if (!no) {
    console.error('sincronizacao_no vazia: este servidor nao sabe o proprio nome.');
    process.exit(1);
  }

  console.log(`\nSemeadura de vinculos — este no e "${no.origem}"`);
  console.log(aplicar ? 'MODO: APLICANDO\n' : 'MODO: SIMULACAO (use --aplicar para gravar)\n');

  let total = 0;

  for (const recurso of RECURSOS) {
    const ids = async (c: PrismaClient) =>
      new Set(
        (await c.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT btrim(id) AS id FROM ${recurso} WHERE deleted_at IS NULL`,
        )).map(r => r.id),
      );

    const daqui = await ids(aqui);
    const dela = await ids(la);
    const comuns = [...daqui].filter(id => dela.has(id));

    const jaVinculados = new Set(
      (await aqui.sincronizacao_vinculos.findMany({
        where: { recurso, registro_id: { in: comuns } },
        select: { registro_id: true },
      })).map(v => v.registro_id),
    );

    const novos = comuns.filter(id => !jaVinculados.has(id));

    console.log(
      `${recurso.padEnd(14)} aqui=${String(daqui.size).padStart(4)}  la=${String(dela.size).padStart(4)}  ` +
      `em comum=${String(comuns.length).padStart(4)}  a vincular=${String(novos.length).padStart(4)}` +
      (daqui.size - comuns.length ? `  (${daqui.size - comuns.length} so daqui, ficam de fora)` : ''),
    );

    if (aplicar && novos.length) {
      // `createMany` com `skipDuplicates`: se rodar duas vezes, a segunda nao
      // faz nada. Versao 0 de proposito — a primeira edicao de verdade sobe
      // para 1 e so ela atravessa.
      await aqui.sincronizacao_vinculos.createMany({
        data: novos.map(id => ({ recurso, registro_id: id, origem: no.origem, ativo: true })),
        skipDuplicates: true,
      });
    }
    total += novos.length;
  }

  console.log(`\n${aplicar ? 'Vinculados' : 'Seriam vinculados'}: ${total}`);
  if (!aplicar) console.log('Nada foi gravado. Rode com --aplicar quando conferir os numeros.\n');

  await aqui.$disconnect();
  await la.$disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
