import axios from 'axios';
import type { Prisma } from '@prisma/client';

/**
 * A saúde da sincronização (10/11/2026), para a tela de admin e o smoke do
 * deploy. Igual nos dois backends.
 *
 * O módulo ficou 7 semanas fora do NexON (16/09 a 06/11) e a fila do Service
 * passou de 2.600 tentativas por evento; o único sinal era um aviso no log na
 * terceira tentativa. Aqui se vê, numa chamada: quanto está parado, desde
 * quando, o que travou e se o outro lado responde.
 */

type Leitor = Pick<Prisma.TransactionClient, 'sincronizacao_outbox' | 'sincronizacao_exclusoes_pendentes'>;

export interface SaudeDaSincronizacao {
  pendentes: number;
  pendente_mais_antigo_em: string | null;
  minutos_do_mais_antigo: number | null;
  /** Os que já falharam 3 vezes ou mais (a dependência ausente antiga aparece aqui) */
  travados: { id: string; recurso: string; registro_id: string; operacao: string; tentativas: number; erro: string | null; criado_em: string }[];
  ultimo_entregue_em: string | null;
  avisos_de_exclusao_pendentes: number;
  destino: { configurado: boolean; status: number | null; origem: string | null; erro: string | null };
}

export async function saudeDaSincronizacao(db: Leitor): Promise<SaudeDaSincronizacao> {
  const [pendentes, maisAntigo, travados, ultimo, avisos, destino] = await Promise.all([
    db.sincronizacao_outbox.count({ where: { entregue_em: null } }),
    db.sincronizacao_outbox.findFirst({ where: { entregue_em: null }, orderBy: { criado_em: 'asc' }, select: { criado_em: true } }),
    db.sincronizacao_outbox.findMany({
      where: { entregue_em: null, tentativas: { gte: 3 } },
      orderBy: { id: 'asc' },
      take: 20,
      select: { id: true, recurso: true, registro_id: true, operacao: true, tentativas: true, erro: true, criado_em: true },
    }),
    // Pelo id (a chave): ordenar pela entrega leria a fila inteira, que cresce para sempre e não tem índice nela
    db.sincronizacao_outbox.findFirst({ where: { entregue_em: { not: null } }, orderBy: { id: 'desc' }, select: { entregue_em: true } }),
    db.sincronizacao_exclusoes_pendentes.count({ where: { decisao: null } }),
    pingDoDestino(),
  ]);
  return {
    pendentes,
    pendente_mais_antigo_em: maisAntigo?.criado_em.toISOString() ?? null,
    minutos_do_mais_antigo: maisAntigo ? Math.floor((Date.now() - maisAntigo.criado_em.getTime()) / 60_000) : null,
    travados: travados.map((t) => ({
      ...t,
      id: t.id.toString(),
      erro: t.erro?.slice(0, 300) ?? null,
      criado_em: t.criado_em.toISOString(),
    })),
    ultimo_entregue_em: ultimo?.entregue_em?.toISOString() ?? null,
    avisos_de_exclusao_pendentes: avisos,
    destino,
  };
}

/** A prova de vida do outro lado, com o token (sem ele, a rota responde 401) */
async function pingDoDestino(): Promise<SaudeDaSincronizacao['destino']> {
  const url = process.env.SINCRONIZACAO_DESTINO_URL;
  const token = process.env.SINCRONIZACAO_TOKEN;
  if (!url || !token) return { configurado: false, status: null, origem: null, erro: 'SINCRONIZACAO_DESTINO_URL ou SINCRONIZACAO_TOKEN vazio' };
  try {
    const r = await axios.get<{ origem?: string; data?: { origem?: string } }>(`${url.replace(/\/$/, '')}/sincronizacao/ping`, {
      headers: { 'x-sincronizacao-token': token },
      timeout: 5_000,
      validateStatus: () => true,
    });
    const origem = r.data?.origem ?? r.data?.data?.origem ?? null;
    return { configurado: true, status: r.status, origem, erro: r.status === 200 ? null : `o outro lado respondeu ${r.status}` };
  } catch (e) {
    return { configurado: true, status: null, origem: null, erro: e instanceof Error ? e.message : 'sem resposta' };
  }
}
