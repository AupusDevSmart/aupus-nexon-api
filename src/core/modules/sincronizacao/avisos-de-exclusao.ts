import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Recurso } from './recursos';
import { TABELA, apagarComDescendentes, comDescendentes, descendentes, type Elo } from './arvore';

/**
 * A exclusão que vem do outro produto vira AVISO, e o desvínculo de lá desliga
 * o vínculo daqui (10/11/2026). Igual nos dois backends.
 *
 * O incidente: em 26/10 o Service apagou 15 registros compartilhados; a fila
 * aplicou as exclusões no NexON 12 dias depois e escondeu usinas com TON ativa,
 * sem ninguém de lá ter decidido. Agora a exclusão de lá deixa o registro aqui,
 * desliga o vínculo e registra um aviso: alguém decide "apagar aqui também" ou
 * "manter só aqui", e a decisão fica na auditoria.
 */

type Tx = Prisma.TransactionClient;
type Leitor = Pick<Tx, 'sincronizacao_exclusoes_pendentes' | '$queryRaw'>;

/** O registro existe aqui, e está apagado? */
export async function estadoLocal(tx: Pick<Tx, '$queryRaw'>, recurso: Recurso, id: string): Promise<{ existe: boolean; apagado: boolean }> {
  const [linha] = await tx.$queryRaw<{ deleted_at: Date | null }[]>`
    SELECT deleted_at FROM ${Prisma.raw(TABELA[recurso])} WHERE id = ${id.trim()}::bpchar LIMIT 1`;
  return { existe: !!linha, apagado: !!linha?.deleted_at };
}

const desligarVinculo = (tx: Tx, recurso: Recurso, id: string) =>
  tx.sincronizacao_vinculos.update({
    where: { recurso_registro_id: { recurso, registro_id: id } },
    data: { ativo: false, atualizado_em: new Date() },
  });

/** O par (recurso, id) dos elos, para o `IN (SELECT * FROM unnest(...))` */
const paresDe = (elos: Elo[]) => Prisma.sql`SELECT * FROM unnest(${elos.map((e) => e.recurso)}::text[], ${elos.map((e) => e.registro_id)}::text[])`;

/**
 * Chegou uma exclusão do outro produto. `vinculoAtivo`: este registro estava
 * compartilhado aqui (quem chama já recusou o vínculo desligado).
 */
export async function receberExclusao(
  tx: Tx,
  e: { recurso: Recurso; id: string; origem: string; apagadoEm: Date | null; apagadoPor: string | null; vinculoAtivo: boolean },
): Promise<{ detalhe: string }> {
  if (!e.vinculoAtivo) return { detalhe: 'apagado no outro produto: aqui não havia vínculo' };
  // Desligado: a próxima edição daqui não recria lá o que foi apagado
  await desligarVinculo(tx, e.recurso, e.id);

  const local = await estadoLocal(tx, e.recurso, e.id);
  if (!local.existe || local.apagado) return { detalhe: 'apagado no outro produto; aqui já não estava (o vínculo foi desligado)' };

  // Uma pendente por registro (o índice único parcial garante; a reentrega não duplica)
  const pendente = await tx.sincronizacao_exclusoes_pendentes.findFirst({
    where: { recurso: e.recurso, registro_id: e.id, decisao: null },
    select: { id: true },
  });
  if (!pendente) {
    await tx.sincronizacao_exclusoes_pendentes.create({
      data: { recurso: e.recurso, registro_id: e.id, origem: e.origem, apagado_em: e.apagadoEm, apagado_por: e.apagadoPor?.slice(0, 255) ?? null },
    });
  }
  return { detalhe: 'apagado no outro produto: aqui o registro fica, o vínculo foi desligado e há um aviso para decidir' };
}

/** O outro produto parou de compartilhar: só o vínculo daqui se desliga, o dado fica */
export async function receberDesvinculo(tx: Tx, e: { recurso: Recurso; id: string; vinculoAtivo: boolean }): Promise<{ detalhe: string }> {
  if (!e.vinculoAtivo) return { detalhe: 'o outro produto parou de compartilhar; aqui não havia vínculo' };
  await desligarVinculo(tx, e.recurso, e.id);
  return { detalhe: 'o outro produto parou de compartilhar: o vínculo daqui foi desligado, o dado fica' };
}

/**
 * O aviso pendente deste registro perdeu o sentido: lá ele voltou (restaurado, ou
 * compartilhado de novo). Fecha como 'restaurado', sem quem decidiu.
 */
export async function fecharAvisoRestaurado(tx: Tx, recurso: Recurso, id: string): Promise<number> {
  const { count } = await tx.sincronizacao_exclusoes_pendentes.updateMany({
    where: { recurso, registro_id: id, decisao: null },
    data: { decisao: 'restaurado', decidido_em: new Date() },
  });
  return count;
}

/**
 * O outro produto restaurou um registro que tinha apagado (10/11/2026). O aviso
 * daqui dizia "apagado lá" e deixou de ser verdade: decidir "apagar" em cima dele
 * apagaria aqui um registro vivo lá. O vínculo continua desligado: religar é o
 * compartilhar, de qualquer lado.
 */
export async function receberRestauro(tx: Tx, e: { recurso: Recurso; id: string }): Promise<{ detalhe: string }> {
  if (await fecharAvisoRestaurado(tx, e.recurso, e.id)) {
    return { detalhe: 'restaurado no outro produto: o aviso de exclusão daqui se fechou (o vínculo continua desligado)' };
  }
  const local = await estadoLocal(tx, e.recurso, e.id);
  if (local.apagado) return { detalhe: 'restaurado no outro produto; aqui ele já tinha sido apagado por decisão e continua apagado' };
  return { detalhe: 'restaurado no outro produto; aqui não havia aviso pendente' };
}

export interface AvisoDeExclusao {
  id: string;
  recurso: Recurso;
  registro_id: string;
  /** O nome do registro aqui (nulo se ele não existe mais) */
  nome: string | null;
  origem: string;
  apagado_em: string | null;
  apagado_por: string | null;
  recebido_em: string;
  /** Avisos de registros debaixo deste (a planta apagada lá manda um por instalação e por equipamento): a decisão leva junto */
  abaixo: number;
}

export interface ListaDeAvisos {
  /** Quantos avisos pedem decisão (os de cima; os de baixo vão junto) */
  total: number;
  avisos: AvisoDeExclusao[];
}

/** Quantos a tela recebe; o total diz quantos há */
const LIMITE_DA_LISTA = 200;

/**
 * Os avisos esperando decisão, do mais novo ao mais velho, com o nome de cada
 * registro aqui. Só os de cima: a planta apagada no outro produto manda um aviso
 * para ela e um para cada instalação e equipamento debaixo dela (278 numa planta
 * grande), e a decisão sobre a planta vale para eles. Os de baixo aparecem no
 * `abaixo` do de cima.
 */
export async function listarAvisos(db: Leitor): Promise<ListaDeAvisos> {
  const pendentes = await db.sincronizacao_exclusoes_pendentes.findMany({
    where: { decisao: null },
    orderBy: [{ recebido_em: 'desc' }, { id: 'desc' }],
  });
  if (pendentes.length === 0) return { total: 0, avisos: [] };

  const raizDe = await raizesDosAvisos(db, pendentes.some((p) => p.recurso === 'unidades' || p.recurso === 'equipamentos'));
  const abaixo = new Map<string, number>();
  for (const raiz of raizDe.values()) abaixo.set(raiz, (abaixo.get(raiz) ?? 0) + 1);
  const deCima = pendentes.filter((p) => !raizDe.has(p.id.toString()));

  const mostrados = deCima.slice(0, LIMITE_DA_LISTA);
  const nomes = new Map<string, string>();
  for (const recurso of Object.keys(TABELA) as Recurso[]) {
    const ids = mostrados.filter((p) => p.recurso === recurso).map((p) => p.registro_id);
    if (ids.length === 0) continue;
    const linhas = await db.$queryRaw<{ id: string; nome: string }[]>`
      SELECT btrim(id) AS id, nome FROM ${Prisma.raw(TABELA[recurso])} WHERE id = ANY(${ids}::bpchar[])`;
    for (const l of linhas) nomes.set(`${recurso}:${l.id}`, l.nome);
  }
  return {
    total: deCima.length,
    avisos: mostrados.map((p) => ({
      id: p.id.toString(),
      recurso: p.recurso as Recurso,
      registro_id: p.registro_id,
      nome: nomes.get(`${p.recurso}:${p.registro_id}`) ?? null,
      origem: p.origem,
      apagado_em: p.apagado_em?.toISOString() ?? null,
      apagado_por: p.apagado_por,
      recebido_em: p.recebido_em.toISOString(),
      abaixo: abaixo.get(p.id.toString()) ?? 0,
    })),
  };
}

/**
 * Para cada aviso pendente que tem outro pendente acima dele (a instalação da
 * planta, o equipamento da instalação ou do pai), o aviso de cima de tudo.
 * Vazio quando só há avisos de planta e de usuário (nada fica debaixo de outro).
 */
async function raizesDosAvisos(db: Pick<Tx, '$queryRaw'>, temFilhos: boolean): Promise<Map<string, string>> {
  if (!temFilhos) return new Map();
  // UNION (não ALL) na recursão: um pai que aponta para o filho não prende a consulta
  const pares = await db.$queryRaw<{ abaixo: bigint; acima: bigint }[]>`
    WITH RECURSIVE
      p AS (SELECT id, recurso, registro_id FROM sincronizacao_exclusoes_pendentes WHERE decisao IS NULL),
      arestas AS (
        SELECT 'unidades'::text AS recurso, btrim(id) AS rid, 'plantas'::text AS recurso_pai, btrim(planta_id) AS rid_pai
          FROM unidades WHERE planta_id IS NOT NULL
        UNION ALL
        SELECT 'equipamentos', btrim(id), 'unidades', btrim(unidade_id) FROM equipamentos WHERE unidade_id IS NOT NULL
        UNION ALL
        SELECT 'equipamentos', btrim(id), 'equipamentos', btrim(equipamento_pai_id) FROM equipamentos WHERE equipamento_pai_id IS NOT NULL
      ),
      acima AS (
        SELECT p.id AS aviso_id, a.recurso_pai AS recurso, a.rid_pai AS rid
          FROM p JOIN arestas a ON a.recurso = p.recurso AND a.rid = p.registro_id
        UNION
        SELECT acima.aviso_id, a.recurso_pai, a.rid_pai
          FROM acima JOIN arestas a ON a.recurso = acima.recurso AND a.rid = acima.rid
      )
    SELECT acima.aviso_id AS abaixo, p.id AS acima
      FROM acima JOIN p ON p.recurso = acima.recurso AND p.registro_id = acima.rid
     WHERE p.id <> acima.aviso_id`;
  const temAcima = new Set(pares.map((x) => x.abaixo.toString()));
  const raizDe = new Map<string, string>();
  for (const { abaixo, acima } of pares) {
    const a = abaixo.toString();
    // O de cima de tudo é o que não tem ninguém acima; o primeiro achado fica
    if (!temAcima.has(acima.toString()) && !raizDe.has(a)) raizDe.set(a, acima.toString());
  }
  return raizDe;
}

export interface AlcanceDoAviso {
  /** O que vai junto: vivo aqui, debaixo do registro */
  unidades: number;
  equipamentos: number;
  /**
   * Destes, os que NÃO foram apagados no outro produto (existem só aqui, ou
   * continuam lá): apagar aqui também é decisão só daqui, e a tela diz quais.
   */
  naoApagadosLa: { unidades: number; equipamentos: number; nomesDasInstalacoes: string[] };
}

/** O que "apagar aqui também" leva junto, para a tela mostrar antes do clique que apaga */
export async function alcanceDoAviso(db: Leitor, avisoId: string): Promise<AlcanceDoAviso> {
  const aviso = await acharAviso(db, avisoId);
  const abaixo = await descendentes(db, aviso.recurso as Recurso, aviso.registro_id, { soVivos: true });
  const alcance: AlcanceDoAviso = { unidades: 0, equipamentos: 0, naoApagadosLa: { unidades: 0, equipamentos: 0, nomesDasInstalacoes: [] } };
  if (abaixo.length === 0) return alcance;

  const comAviso = await db.$queryRaw<{ recurso: string; registro_id: string }[]>`
    SELECT recurso, registro_id FROM sincronizacao_exclusoes_pendentes
     WHERE decisao IS NULL AND (recurso, registro_id) IN (${paresDe(abaixo)})`;
  const apagadoLa = new Set(comAviso.map((c) => `${c.recurso}:${c.registro_id}`));
  const instalacoesSoAqui: string[] = [];
  for (const e of abaixo) {
    if (e.recurso !== 'unidades' && e.recurso !== 'equipamentos') continue;
    alcance[e.recurso] += 1;
    if (apagadoLa.has(`${e.recurso}:${e.registro_id}`)) continue;
    alcance.naoApagadosLa[e.recurso] += 1;
    if (e.recurso === 'unidades') instalacoesSoAqui.push(e.registro_id);
  }
  if (instalacoesSoAqui.length > 0) {
    const nomes = await db.$queryRaw<{ nome: string }[]>`
      SELECT nome FROM unidades WHERE btrim(id) = ANY(${instalacoesSoAqui}::text[]) ORDER BY nome LIMIT 10`;
    alcance.naoApagadosLa.nomesDasInstalacoes = nomes.map((n) => n.nome);
  }
  return alcance;
}

/** O aviso pelo id da rota. O id é o BIGSERIAL: texto que não é número seria um 500 no BigInt */
async function acharAviso(db: Pick<Tx, 'sincronizacao_exclusoes_pendentes'>, avisoId: string) {
  const aviso = /^\d{1,18}$/.test(avisoId) ? await db.sincronizacao_exclusoes_pendentes.findUnique({ where: { id: BigInt(avisoId) } }) : null;
  if (!aviso) throw new NotFoundException('Aviso de exclusão não encontrado.');
  return aviso;
}

export type Decisao = 'apagar' | 'manter';

/**
 * A decisão sobre um aviso, que vale também para os avisos do que fica debaixo
 * dele. "apagar" apaga aqui também, com o que fica debaixo (a planta leva as
 * instalações e os equipamentos, como na tela), por escrita normal: o que debaixo
 * ainda estiver compartilhado manda o aviso dele para o outro lado. "manter"
 * deixa o registro, e o que fica debaixo, só aqui (o vínculo já está desligado).
 *
 * `equipamentosApagados`: quem chama avisa depois do commit o que a tela avisaria
 * (no NexON, o MQTT deixa de ouvir o equipamento apagado).
 */
export async function decidirAviso(
  tx: Tx,
  avisoId: string,
  decisao: Decisao,
  porQuem?: string | null,
): Promise<{ apagados: number; equipamentosApagados: string[]; avisosFechados: number }> {
  const aviso = await acharAviso(tx, avisoId);
  const recurso = aviso.recurso as Recurso;
  const agora = new Date();
  const quem = porQuem?.trim() || null;

  // Reivindica o aviso antes de qualquer coisa: duas pessoas decidindo juntas, a
  // segunda espera a trava da linha e acha o aviso decidido (409). Antes, as duas
  // passavam, e podia ficar "manter" registrado com o registro já apagado
  const { count } = await tx.sincronizacao_exclusoes_pendentes.updateMany({
    where: { id: aviso.id, decisao: null },
    data: { decisao, decidido_em: agora, decidido_por: quem },
  });
  if (count !== 1) throw new ConflictException('Este aviso já foi decidido.');

  // A árvore inteira, também o já apagado: o aviso de baixo fecha mesmo se o registro dele saiu antes
  const arvore = await comDescendentes(tx, recurso, aviso.registro_id, { soVivos: false });
  const apagados = decisao === 'apagar' ? await apagarComDescendentes(tx, recurso, aviso.registro_id, agora) : null;

  const fechados = await tx.$queryRaw<{ recurso: string; registro_id: string; origem: string }[]>`
    UPDATE sincronizacao_exclusoes_pendentes
       SET decisao = ${decisao}, decidido_em = ${agora}, decidido_por = ${quem}
     WHERE decisao IS NULL AND id <> ${aviso.id} AND (recurso, registro_id) IN (${paresDe(arvore)})
    RETURNING recurso, registro_id, origem`;

  const resultado = decisao === 'apagar' ? 'exclusao_apagada' : 'exclusao_mantida';
  await tx.sincronizacao_auditoria.createMany({
    data: [
      {
        direcao: 'decisao', recurso, registro_id: aviso.registro_id, origem: aviso.origem, resultado, ator: quem,
        detalhe:
          decisao === 'apagar'
            ? `apagado aqui também, com o que ficava debaixo (${apagados?.total ?? 0} registro(s))`
            : 'mantido só aqui, com o que fica debaixo: deixou de ser compartilhado',
      },
      // Cada aviso fechado junto tem a linha dele: "por que este equipamento sumiu" tem resposta
      ...fechados.map((f) => ({
        direcao: 'decisao', recurso: f.recurso, registro_id: f.registro_id, origem: f.origem, resultado, ator: quem,
        detalhe: `${decisao === 'apagar' ? 'apagado' : 'mantido'} junto com ${recurso}/${aviso.registro_id} (aviso ${aviso.id})`,
      })),
    ],
  });
  return { apagados: apagados?.total ?? 0, equipamentosApagados: apagados?.idsDosEquipamentos ?? [], avisosFechados: fechados.length };
}
