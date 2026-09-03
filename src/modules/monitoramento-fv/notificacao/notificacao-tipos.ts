import { PrismaService } from '@/core';

/**
 * REGISTRO DE TIPOS DE NOTIFICAÇÃO (em código, padrão do commandRegistry).
 *
 * Cada tipo sabe: seu escopo (planta|unidade), seu gatilho (cron hh:mm | evento) e
 * como MONTAR o texto (builder). O relatório de geração diária do BDO é só o PRIMEIRO
 * tipo — novos plugam aqui sem schema novo. O ENVIO real (WhatsApp) NÃO acontece aqui:
 * os builders só produzem texto; o dispatcher (Fase 2) é quem envia, e sempre com
 * autorização/preview (ver docs/INTEGRACAO_NEXON_DASHBOARD.md e a regra de segurança).
 */

export type NotificacaoGatilho =
  | { tipo: 'cron'; hora: string } // "21:05" (America/Sao_Paulo)
  | { tipo: 'evento' };

export interface NotificacaoBuilderCtx {
  prisma: PrismaService;
  unidadeId?: string | null;
  plantaId?: string | null;
  proprietarioId?: string | null;
  data: string; // YYYY-MM-DD (BRT)
}

export interface NotificacaoTipo {
  id: string;
  label: string;
  escopo: 'planta' | 'unidade' | 'proprietario';
  gatilho: NotificacaoGatilho;
  /** Monta o texto do alvo/data. Retorna null quando não há dado (ex.: dia sem geração). */
  builder: (ctx: NotificacaoBuilderCtx) => Promise<string | null>;
}

function fmtKwh(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  try {
    return v.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  } catch {
    return String(Math.round(v));
  }
}

/** Tipo `geracao_diaria`: realizado × meta do dia de UMA unidade (usina). */
async function buildGeracaoDiaria(ctx: NotificacaoBuilderCtx): Promise<string | null> {
  const uid = (ctx.unidadeId ?? '').trim();
  if (!uid) return null;
  const rows = await ctx.prisma.$queryRaw<
    Array<{ nome: string | null; kwh_realizado: number; kwh_previsto: number }>
  >`
    SELECT u.nome AS nome, g.kwh_realizado, g.kwh_previsto
    FROM geracao_diaria_plantas g
    LEFT JOIN unidades u ON u.id = g.unidade_id
    WHERE g.unidade_id = ${uid} AND g.data = ${ctx.data}::date
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const r = rows[0];
  const real = Number(r.kwh_realizado) || 0;
  const prev = Number(r.kwh_previsto) || 0;
  const pct = prev > 0 ? Math.round((real / prev) * 100) : null;
  const nome = (r.nome ?? 'Usina').trim();
  const metaTxt = prev > 0 ? ` / meta ${fmtKwh(prev)} kWh` : '';
  const pctTxt = pct != null ? ` (${pct}% da meta)` : '';
  return `☀️ *${nome}* — ${ctx.data}\nGeração: ${fmtKwh(real)} kWh${metaTxt}${pctTxt}`;
}

/**
 * Tipo `boletim_diario`: o Boletim Diário de Operação enviado ao DONO no privado (não o do
 * grupo). Agrega TODAS as usinas do proprietário no dia, no formato aprovado pelo usuário.
 */
async function buildBoletimDiario(ctx: NotificacaoBuilderCtx): Promise<string | null> {
  const pid = (ctx.proprietarioId ?? '').trim();
  if (!pid) return null;
  const rows = await ctx.prisma.$queryRaw<Array<{ nome: string; kwh_realizado: number }>>`
    SELECT TRIM(u.nome) AS nome, g.kwh_realizado
    FROM geracao_diaria_plantas g
    JOIN unidades u ON TRIM(u.id) = TRIM(g.unidade_id) AND u.deleted_at IS NULL
    JOIN plantas p ON TRIM(p.id) = TRIM(u.planta_id) AND p.deleted_at IS NULL
    WHERE TRIM(p.proprietario_id) = ${pid} AND g.data = ${ctx.data}::date
    ORDER BY u.nome
  `;
  if (rows.length === 0) return null;
  const [y, m, d] = ctx.data.split('-');
  const dataBr = `${d}/${m}/${y}`;
  const cabecalho =
    `Boa noite! Este é o Boletim Diário de Operação da Aupus Energia. A seguir apresentamos ` +
    `a geração do dia ${dataBr} realizada pelo empreendimento.`;
  const blocos = rows.map(
    (r) => `*${(r.nome ?? 'Usina').trim()}*\n\nGeração do dia: ${fmtKwh(Number(r.kwh_realizado) || 0)} kWh`,
  );
  return `${cabecalho}\n\n${blocos.join('\n______________________\n')}`;
}

export const NOTIFICACAO_TIPOS: readonly NotificacaoTipo[] = [
  {
    id: 'geracao_diaria',
    label: 'Geração diária (realizado × meta)',
    escopo: 'unidade',
    gatilho: { tipo: 'cron', hora: '21:05' },
    builder: buildGeracaoDiaria,
  },
  {
    id: 'boletim_diario',
    label: 'Boletim Diário de Operação (privado, por dono)',
    escopo: 'proprietario',
    gatilho: { tipo: 'cron', hora: '21:10' },
    builder: buildBoletimDiario,
  },
];

export function getNotificacaoTipo(id: string): NotificacaoTipo | undefined {
  return NOTIFICACAO_TIPOS.find((t) => t.id === id);
}
