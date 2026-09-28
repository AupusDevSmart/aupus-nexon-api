import { Prisma } from '@prisma/client';

/**
 * Filtros da listagem de logs_mqtt — PUROS (só montam SQL), testados em
 * logs-mqtt-filtros.spec.ts. As colunas de trilha (reconhecido_em, resolvido_em,
 * silenciado_ate, dispositivo) não estão no schema Prisma, então a listagem é SQL.
 */

export const TIPOS_LOG = ['alerta', 'comando', 'acesso'] as const;
export type TipoLog = (typeof TIPOS_LOG)[number];

export const STATUS_ALARME = ['ativo', 'reconhecido', 'resolvido'] as const;
export type StatusAlarme = (typeof STATUS_ALARME)[number];

/** 'alerta,comando' → ['alerta','comando']. Vazio/ausente → null (todos os de logs_mqtt). */
export function parseTipos(csv?: string | null): TipoLog[] | null {
  if (!csv) return null;
  const itens = csv
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t): t is TipoLog => (TIPOS_LOG as readonly string[]).includes(t));
  return itens.length ? [...new Set(itens)] : null;
}

/**
 * Janela do "ativo", em dias (env ALARME_ATIVO_JANELA_DIAS, padrão 7; 0 = sem
 * janela). Sem ela, todo alerta nunca reconhecido desde o início do sistema
 * contaria como falha ativa. Vale para a aba Ativos e para o card do Início.
 */
export function janelaAtivoDias(): number {
  const v = Number(process.env.ALARME_ATIVO_JANELA_DIAS ?? 7);
  return Number.isFinite(v) && v >= 0 ? v : 7;
}

/**
 * Condição SQL do status do alarme (alias da tabela = `l`).
 *   ativo       = alerta, sem reconhecimento nem resolução, não silenciado agora
 *                 (e dentro da janela de `janelaDias`, se > 0)
 *   reconhecido = reconhecido e ainda não resolvido
 *   resolvido   = resolvido
 * Status só se aplica a alerta: a condição já inclui tipo = 'alerta'.
 */
export function condicaoStatus(status: StatusAlarme, agora: Date, janelaDias = janelaAtivoDias()): Prisma.Sql {
  switch (status) {
    case 'ativo': {
      const base = Prisma.sql`l.tipo = 'alerta' AND l.reconhecido_em IS NULL AND l.resolvido_em IS NULL
        AND (l.silenciado_ate IS NULL OR l.silenciado_ate <= now())`;
      if (janelaDias > 0) {
        const desde = new Date(agora.getTime() - janelaDias * 24 * 60 * 60 * 1000);
        return Prisma.sql`${base} AND l.created_at >= ${desde}`;
      }
      return base;
    }
    case 'reconhecido':
      return Prisma.sql`l.tipo = 'alerta' AND l.reconhecido_em IS NOT NULL AND l.resolvido_em IS NULL`;
    case 'resolvido':
      return Prisma.sql`l.tipo = 'alerta' AND l.resolvido_em IS NOT NULL`;
  }
}

/** Junta condições com AND (lista vazia → TRUE). */
export function juntarE(conds: Prisma.Sql[]): Prisma.Sql {
  return conds.length ? Prisma.join(conds, ' AND ') : Prisma.sql`TRUE`;
}

/**
 * Erro de "SQL da trilha ainda não aplicado" (coluna ou tabela inexistente —
 * Postgres 42703 / 42P01)? Aí a listagem cai no caminho antigo em vez de 500.
 */
export function colunaTrilhaAusente(e: unknown): boolean {
  const err = e as { code?: string; meta?: { code?: string }; message?: string } | null;
  const pg = err?.meta?.code ?? err?.code;
  if (pg === '42703' || pg === '42P01') return true;
  return /(column|relation) "?[\w.]+"? does not exist/i.test(err?.message ?? '');
}
