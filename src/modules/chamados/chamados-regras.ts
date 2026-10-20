/**
 * Regras puras dos chamados (NEXON-24). Sem Prisma: testadas em chamados-regras.spec.ts.
 *
 * O NexON não gera ordem de serviço. O chamado registra o pedido de reparo e é
 * encaminhado para o Smart Service ou para o WhatsApp/e-mail que o proprietário indicar.
 */

export const MOTIVOS = ['FALHA', 'ALARME', 'CAMPO', 'OUTRO'] as const;
export const PRIORIDADES = ['BAIXA', 'MEDIA', 'ALTA', 'URGENTE'] as const;
export const STATUS = ['ABERTO', 'ENCAMINHADO', 'FECHADO'] as const;
export const CANAIS = ['WEB', 'APP'] as const;
export const DESTINOS = ['SMART_SERVICE', 'WHATSAPP', 'EMAIL'] as const;

export type Motivo = (typeof MOTIVOS)[number];
export type Prioridade = (typeof PRIORIDADES)[number];
export type StatusChamado = (typeof STATUS)[number];
export type Destino = (typeof DESTINOS)[number];

export const MOTIVO_ROTULO: Record<Motivo, string> = {
  FALHA: 'Falha',
  ALARME: 'Alarme',
  CAMPO: 'Visto em campo',
  OUTRO: 'Outro',
};

export const PRIORIDADE_ROTULO: Record<Prioridade, string> = {
  BAIXA: 'Baixa',
  MEDIA: 'Média',
  ALTA: 'Alta',
  URGENTE: 'Urgente',
};

export const DESTINO_ROTULO: Record<Destino, string> = {
  SMART_SERVICE: 'Smart Service',
  WHATSAPP: 'WhatsApp',
  EMAIL: 'E-mail',
};

/** Status que contam no número do menu: tudo que ainda não foi fechado. */
export const STATUS_ABERTOS: StatusChamado[] = ['ABERTO', 'ENCAMINHADO'];

/** Tentativas de envio antes de o encaminhamento virar FALHOU. */
export const MAX_TENTATIVAS = 5;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Telefone só com dígitos, com DDI 55 quando vier sem. Null se não parece telefone. */
export function normalizarTelefone(v: string | null | undefined): string | null {
  const d = (v ?? '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) return `55${d}`;
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) return d;
  return null;
}

/**
 * Valida e normaliza o contato do destino. Smart Service não leva contato.
 * Devolve `{ contato }` ou `{ erro }` com a frase para a tela.
 */
export function validarContato(
  destino: Destino,
  contato: string | null | undefined,
): { contato: string | null } | { erro: string } {
  if (destino === 'SMART_SERVICE') return { contato: null };
  const c = (contato ?? '').trim();
  if (!c) return { erro: `Informe o ${destino === 'EMAIL' ? 'e-mail' : 'WhatsApp'} de destino` };
  if (destino === 'EMAIL') {
    return EMAIL_RE.test(c) ? { contato: c.toLowerCase() } : { erro: `E-mail inválido: ${c}` };
  }
  const tel = normalizarTelefone(c);
  return tel ? { contato: tel } : { erro: `WhatsApp inválido: ${c} (use DDD + número)` };
}

/** Pode encaminhar? Fechado não sai mais; reabrir é abrir chamado novo. */
export function podeEncaminhar(status: string): boolean {
  return status === 'ABERTO' || status === 'ENCAMINHADO';
}

export function podeFechar(status: string): boolean {
  return status !== 'FECHADO';
}

export interface ChamadoParaMensagem {
  numero: number;
  titulo: string;
  descricao: string;
  motivo: string;
  prioridade: string;
  autor_nome: string | null;
  created_at: Date;
  equipamento: { nome: string; tag?: string | null } | null;
  unidade: { nome: string } | null;
  planta: { nome: string } | null;
}

function dataHoraBR(d: Date): string {
  return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
}

/** Linhas do chamado, na ordem em que quem recebe precisa ler. */
export function linhasDoChamado(c: ChamadoParaMensagem, observacao?: string | null): string[] {
  const equip = c.equipamento ? `${c.equipamento.nome}${c.equipamento.tag ? ` (${c.equipamento.tag})` : ''}` : '—';
  return [
    `Chamado #${c.numero} — ${c.titulo}`,
    `Equipamento: ${equip}`,
    `Local: ${[c.planta?.nome, c.unidade?.nome].filter(Boolean).join(' · ') || '—'}`,
    `Motivo: ${MOTIVO_ROTULO[c.motivo as Motivo] ?? c.motivo} · Prioridade: ${PRIORIDADE_ROTULO[c.prioridade as Prioridade] ?? c.prioridade}`,
    `Aberto por ${c.autor_nome ?? '—'} em ${dataHoraBR(c.created_at)}`,
    '',
    c.descricao,
    ...(observacao?.trim() ? ['', `Observação: ${observacao.trim()}`] : []),
  ];
}

export function textoWhatsapp(c: ChamadoParaMensagem, observacao?: string | null): string {
  const [titulo, ...resto] = linhasDoChamado(c, observacao);
  return [`*NexON · ${titulo}*`, ...resto].join('\n');
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function emailDoChamado(c: ChamadoParaMensagem, observacao?: string | null): { assunto: string; html: string } {
  const linhas = linhasDoChamado(c, observacao);
  const html = [
    `<h2 style="font-family:sans-serif;margin:0 0 12px">${esc(linhas[0])}</h2>`,
    `<div style="font-family:sans-serif;font-size:14px;line-height:1.5">`,
    ...linhas.slice(1).map((l) => (l ? `<p style="margin:0">${esc(l).replace(/\n/g, '<br>')}</p>` : '<br>')),
    `</div>`,
    `<p style="font-family:sans-serif;font-size:12px;color:#777;margin-top:16px">Enviado pelo NexON · Aupus Energia</p>`,
  ].join('');
  return { assunto: `[NexON] Chamado #${c.numero} — ${c.titulo}`, html };
}

/** Termo de busca livre: número (#12 ou 12) ou texto em título/descrição/equipamento. */
export function interpretarBusca(busca: string | null | undefined): { numero?: number; texto?: string } {
  const b = (busca ?? '').trim();
  if (!b) return {};
  const m = /^#?(\d{1,9})$/.exec(b);
  if (m) return { numero: Number(m[1]), texto: b };
  return { texto: b };
}
