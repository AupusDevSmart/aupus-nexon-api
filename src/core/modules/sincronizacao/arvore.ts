import { Prisma } from '@prisma/client';
import type { Recurso } from './recursos';

/**
 * O que fica debaixo de um registro compartilhado (10/11/2026): a planta tem
 * instalações, a instalação tem equipamentos, o equipamento tem
 * sub-equipamentos. Usado para parar de compartilhar junto, para apagar junto
 * (o aviso de exclusão aceito) e para avisar, antes de excluir, o que é
 * compartilhado na cascata.
 *
 * Em SQL e não pelo Prisma: as quatro tabelas são Char(26) com ids de 25 e de
 * 26 caracteres, e a comparação aqui é pelo `btrim` (o `include` do Prisma
 * compara em JS e perde o de 25). Igual nos dois backends.
 */

type Leitor = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** As tabelas pelo nome do recurso (o nome vai cru no SQL: só estes quatro) */
export const TABELA: Record<Recurso, string> = { usuarios: 'usuarios', plantas: 'plantas', unidades: 'unidades', equipamentos: 'equipamentos' };

export interface Elo {
  recurso: Recurso;
  registro_id: string;
}

/**
 * Os descendentes, sem o próprio registro. `soVivos`: só os não apagados (o que
 * a exclusão ainda alcança); sem ele, todos (parar de compartilhar desliga
 * também o vínculo do que já foi apagado).
 */
export async function descendentes(db: Leitor, recurso: Recurso, id: string, { soVivos }: { soVivos: boolean }): Promise<Elo[]> {
  if (recurso === 'usuarios') return [];
  const raiz = id.trim();
  const linhas = await db.$queryRaw<{ recurso: Recurso; registro_id: string }[]>`
    WITH RECURSIVE
      u AS (
        SELECT btrim(id) AS id FROM unidades
         WHERE ${recurso}::text = 'plantas' AND btrim(planta_id) = ${raiz}
           AND (NOT ${soVivos}::boolean OR deleted_at IS NULL)
      ),
      e AS (
        SELECT btrim(q.id) AS id FROM equipamentos q
         WHERE (NOT ${soVivos}::boolean OR q.deleted_at IS NULL)
           AND (    (${recurso}::text = 'plantas' AND btrim(q.unidade_id) IN (SELECT id FROM u))
                 OR (${recurso}::text = 'unidades' AND btrim(q.unidade_id) = ${raiz})
                 OR (${recurso}::text = 'equipamentos' AND btrim(q.equipamento_pai_id) = ${raiz}))
        UNION
        SELECT btrim(q.id) FROM equipamentos q JOIN e ON btrim(q.equipamento_pai_id) = e.id
         WHERE (NOT ${soVivos}::boolean OR q.deleted_at IS NULL)
      )
    SELECT 'unidades' AS recurso, id AS registro_id FROM u
    UNION ALL
    SELECT 'equipamentos', id FROM e`;
  // O sub-equipamento sem instalação (só com o pai) entra pela recursão; o que
  // tem as duas coisas entra uma vez só
  const vistos = new Set<string>();
  return linhas.filter((l) => {
    const chave = `${l.recurso}:${l.registro_id}`;
    if (vistos.has(chave) || (l.recurso === recurso && l.registro_id === raiz)) return false;
    vistos.add(chave);
    return true;
  });
}

/** O registro e tudo debaixo dele, do mais alto ao mais baixo */
export async function comDescendentes(db: Leitor, recurso: Recurso, id: string, opcoes: { soVivos: boolean }): Promise<Elo[]> {
  return [{ recurso, registro_id: id.trim() }, ...(await descendentes(db, recurso, id, opcoes))];
}

export interface Apagados {
  total: number;
  plantas: number;
  unidades: number;
  equipamentos: number;
  usuarios: number;
  /** Os equipamentos apagados (no NexON, o MQTT deixa de ouvi-los) */
  idsDosEquipamentos: string[];
}

/**
 * Apaga (soft delete) o registro e o que fica debaixo dele: o mesmo conjunto que
 * `compartilhadosNaCascata` mostra antes de excluir, e que o aviso de exclusão
 * aceito apaga. Antes, a planta e a instalação apagavam os equipamentos pelo
 * `unidade_id`, e o sub-equipamento (que nasce só com o pai) ficava vivo, e
 * compartilhado, debaixo de um pai apagado, com a tela dizendo que ia junto.
 *
 * Dentro da transação de quem chama, por escrita normal: o trigger enfileira o
 * aviso do que estiver compartilhado. O usuário sai como na tela: inativo, não
 * só apagado (a lista que filtra pelo status ainda o mostraria).
 */
export async function apagarComDescendentes(tx: Leitor, recurso: Recurso, id: string, agora: Date = new Date()): Promise<Apagados> {
  const elos = await comDescendentes(tx, recurso, id, { soVivos: true });
  const apagados: Apagados = { total: 0, plantas: 0, unidades: 0, equipamentos: 0, usuarios: 0, idsDosEquipamentos: [] };
  // De baixo para cima, como a tela fazia
  for (const tabela of ['equipamentos', 'unidades', 'plantas', 'usuarios'] as const) {
    const ids = elos.filter((e) => e.recurso === tabela).map((e) => e.registro_id);
    if (ids.length === 0) continue;
    // Pela chave (o bpchar ignora o espaço do fim do id de 25)
    const linhas =
      tabela === 'usuarios'
        ? await tx.$queryRaw<{ id: string }[]>`
            UPDATE usuarios SET deleted_at = ${agora}, updated_at = ${agora}, is_active = false, status = 'Inativo'
             WHERE id = ANY(${ids}::bpchar[]) AND deleted_at IS NULL RETURNING btrim(id) AS id`
        : await tx.$queryRaw<{ id: string }[]>`
            UPDATE ${Prisma.raw(TABELA[tabela])} SET deleted_at = ${agora}, updated_at = ${agora}
             WHERE id = ANY(${ids}::bpchar[]) AND deleted_at IS NULL RETURNING btrim(id) AS id`;
    apagados[tabela] = linhas.length;
    apagados.total += linhas.length;
    if (tabela === 'equipamentos') apagados.idsDosEquipamentos = linhas.map((l) => l.id);
  }
  return apagados;
}

export interface CompartilhadosNaCascata {
  /** Quantos, entre o registro e o que fica debaixo dele, estão compartilhados agora */
  total: number;
  plantas: number;
  unidades: number;
  equipamentos: number;
  usuarios: number;
  /** O nome das instalações compartilhadas (até 10), para a tela dizer quais */
  nomesDasInstalacoes: string[];
}

/**
 * O que a exclusão alcançaria de compartilhado (só o vivo). A tela mostra antes
 * de excluir, e a API recusa a exclusão sem a confirmação quando há algum.
 */
export async function compartilhadosNaCascata(db: Leitor, recurso: Recurso, id: string): Promise<CompartilhadosNaCascata> {
  const elos = await comDescendentes(db, recurso, id, { soVivos: true });
  const contagem: CompartilhadosNaCascata = { total: 0, plantas: 0, unidades: 0, equipamentos: 0, usuarios: 0, nomesDasInstalacoes: [] };
  if (elos.length === 0) return contagem;

  const ativos = await db.$queryRaw<{ recurso: Recurso; registro_id: string }[]>`
    SELECT v.recurso, v.registro_id
      FROM sincronizacao_vinculos v
      JOIN unnest(${elos.map((e) => e.recurso)}::text[], ${elos.map((e) => e.registro_id)}::text[]) AS c(recurso, registro_id)
        ON v.recurso = c.recurso AND v.registro_id = c.registro_id
     WHERE v.ativo`;
  for (const a of ativos) {
    contagem[a.recurso] += 1;
    contagem.total += 1;
  }

  const unidades = ativos.filter((a) => a.recurso === 'unidades').map((a) => a.registro_id);
  if (unidades.length > 0) {
    const nomes = await db.$queryRaw<{ nome: string }[]>`
      SELECT nome FROM unidades WHERE btrim(id) = ANY(${unidades}::text[]) ORDER BY nome LIMIT 10`;
    contagem.nomesDasInstalacoes = nomes.map((n) => n.nome);
  }
  return contagem;
}

/** Um texto para a recusa da API e para quem lê o log: "1 planta, 3 instalações e 12 equipamentos" */
export function descreverCompartilhados(c: CompartilhadosNaCascata): string {
  const partes = [
    c.plantas && `${c.plantas} ${c.plantas === 1 ? 'planta' : 'plantas'}`,
    c.unidades && `${c.unidades} ${c.unidades === 1 ? 'instalação' : 'instalações'}`,
    c.equipamentos && `${c.equipamentos} ${c.equipamentos === 1 ? 'equipamento' : 'equipamentos'}`,
    c.usuarios && `${c.usuarios} ${c.usuarios === 1 ? 'usuário' : 'usuários'}`,
  ].filter(Boolean) as string[];
  return partes.length <= 1 ? (partes[0] ?? '') : `${partes.slice(0, -1).join(', ')} e ${partes[partes.length - 1]}`;
}
