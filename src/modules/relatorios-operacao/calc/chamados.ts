/**
 * Bloco "Chamados" dos relatórios de operação (NEXON-33) — lógica PURA, testada em
 * chamados.spec.ts.
 */

import { papelCanonico, ROTULO_PAPEL } from '../../../core/modules/auth/papeis';
import { isoBrt } from './periodo';
import type { ChamadoRelatorio } from '../relatorios-operacao.tipos';

export interface LinhaChamado {
  id: string;
  numero: number;
  equipamento_id: string | null;
  equipamento_nome: string | null;
  titulo: string;
  status: string;
  created_at: Date;
  autor_nome: string | null;
  autor_role: string | null;
  fechado_em: Date | null;
}

export interface LinhaEncaminhamento {
  chamado_id: string;
  destino: string;
  contato: string | null;
  status: string;
  referencia_externa: string | null;
  autor_nome?: string | null;
}

/** Papel em texto corrido ("analista de operação"); papel sem nome no NexON → null. */
export function rotuloPapel(role: string | null | undefined): string | null {
  if (!role) return null;
  const p = papelCanonico(role);
  if (p === 'outro') return null;
  return ROTULO_PAPEL[p].toLowerCase();
}

/**
 * Destino já notificado, pronto para exibir. Só encaminhamento ENVIADO conta.
 * Smart Service: "(OS n)" só quando a referência devolvida é um número (o Service devolve o
 * id da solicitação; o número da OS não volta para o NexON).
 */
export function rotuloNotificado(e: LinhaEncaminhamento): string | null {
  if (e.status !== 'ENVIADO') return null;
  const contato = (e.contato ?? '').trim();
  switch (e.destino) {
    case 'SMART_SERVICE': {
      const ref = (e.referencia_externa ?? '').trim();
      return /^\d+$/.test(ref) ? `Smart Service (OS ${ref})` : 'Smart Service';
    }
    case 'WHATSAPP':
      return contato ? `WhatsApp (${contato})` : 'WhatsApp';
    case 'EMAIL':
      return contato ? `E-mail ${contato}` : 'E-mail';
    default:
      return null;
  }
}

export function montarChamados(linhas: LinhaChamado[], encs: LinhaEncaminhamento[]): ChamadoRelatorio[] {
  const porChamado = new Map<string, string[]>();
  for (const e of encs) {
    const r = rotuloNotificado(e);
    if (!r) continue;
    const id = e.chamado_id.trim();
    const l = porChamado.get(id) ?? [];
    if (!l.includes(r)) l.push(r);
    porChamado.set(id, l);
  }
  return [...linhas]
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .map((c) => ({
      numero: Number(c.numero),
      equipamento: c.equipamento_nome?.trim() || '—',
      titulo: c.titulo,
      abertoEm: isoBrt(new Date(c.created_at)) as string,
      abertoPor: c.autor_nome?.trim() || null,
      abertoPorPapel: rotuloPapel(c.autor_role),
      notificado: porChamado.get(c.id.trim()) ?? [],
      status: c.status,
      atendidoEm: c.status === 'FECHADO' && c.fechado_em ? isoBrt(new Date(c.fechado_em)) : null,
    }));
}

/** Contagem por equipamento: abertos (ainda abertos no fim do período) e atendidos (fechados no período). */
export function contarChamados(linhas: LinhaChamado[], equipamentoIds: string[], ini: number, fim: number): { abertos: number; atendidos: number } {
  const ids = new Set(equipamentoIds.map((x) => x.trim()));
  let abertos = 0;
  let atendidos = 0;
  for (const c of linhas) {
    if (!c.equipamento_id || !ids.has(c.equipamento_id.trim())) continue;
    const fechado = c.fechado_em ? new Date(c.fechado_em).getTime() : null;
    if (fechado !== null && fechado >= ini && fechado < fim) atendidos++;
    else if (fechado === null || fechado >= fim) abertos++;
  }
  return { abertos, atendidos };
}
