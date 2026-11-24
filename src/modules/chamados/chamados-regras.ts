/**
 * Regras puras dos chamados (NEXON-24). Sem Prisma: testadas em chamados-regras.spec.ts.
 *
 * O NexON não gera ordem de serviço. O chamado registra o pedido de reparo e é
 * encaminhado para o Smart Service ou para o WhatsApp/e-mail que o proprietário indicar.
 */

export const TIPOS = ['INTERNO', 'EXTERNO'] as const;
/** Motivos do reparo (INTERNO) e do chamado com terceiro (EXTERNO). OUTRO vale para os dois. */
export const MOTIVOS_INTERNO = ['FALHA', 'ALARME', 'CAMPO', 'OUTRO'] as const;
export const MOTIVOS_EXTERNO = ['FALTA_ENERGIA', 'OSCILACAO', 'REDE', 'MEDICAO', 'RELIGACAO', 'OUTRO'] as const;
export const MOTIVOS = ['FALHA', 'ALARME', 'CAMPO', 'OUTRO', 'FALTA_ENERGIA', 'OSCILACAO', 'REDE', 'MEDICAO', 'RELIGACAO'] as const;
export const PRIORIDADES = ['BAIXA', 'MEDIA', 'ALTA', 'URGENTE'] as const;
/** INTERNO: ABERTO → ENCAMINHADO → FECHADO. EXTERNO: ABERTO → EM_ANDAMENTO → RESOLVIDO | CANCELADO. */
export const STATUS_INTERNO = ['ABERTO', 'ENCAMINHADO', 'FECHADO'] as const;
export const STATUS_EXTERNO = ['ABERTO', 'EM_ANDAMENTO', 'RESOLVIDO', 'CANCELADO'] as const;
export const STATUS = ['ABERTO', 'ENCAMINHADO', 'FECHADO', 'EM_ANDAMENTO', 'RESOLVIDO', 'CANCELADO'] as const;
export const CANAIS = ['WEB', 'APP'] as const;
export const DESTINOS = ['SMART_SERVICE', 'WHATSAPP', 'EMAIL'] as const;

export type Tipo = (typeof TIPOS)[number];
export type Motivo = (typeof MOTIVOS)[number];
export type Prioridade = (typeof PRIORIDADES)[number];
export type StatusChamado = (typeof STATUS)[number];
export type Destino = (typeof DESTINOS)[number];

export const MOTIVO_ROTULO: Record<Motivo, string> = {
  FALHA: 'Falha',
  ALARME: 'Alarme',
  CAMPO: 'Visto em campo',
  OUTRO: 'Outro',
  FALTA_ENERGIA: 'Falta de energia',
  OSCILACAO: 'Oscilação de tensão',
  REDE: 'Rede / poste / cabo',
  MEDICAO: 'Medição / fatura',
  RELIGACAO: 'Religação / ligação nova',
};

export const STATUS_ROTULO: Record<StatusChamado, string> = {
  ABERTO: 'Aberto',
  ENCAMINHADO: 'Encaminhado',
  FECHADO: 'Fechado',
  EM_ANDAMENTO: 'Em andamento',
  RESOLVIDO: 'Resolvido',
  CANCELADO: 'Cancelado',
};

export const TIPO_ROTULO: Record<Tipo, string> = { INTERNO: 'Reparo', EXTERNO: 'Externo' };

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

/** Status que contam no número do menu: tudo que ainda não foi fechado/resolvido. */
export const STATUS_ABERTOS: StatusChamado[] = ['ABERTO', 'ENCAMINHADO', 'EM_ANDAMENTO'];
/** Status finais: contam como encerrados nas estatísticas. */
export const STATUS_ENCERRADOS: StatusChamado[] = ['FECHADO', 'RESOLVIDO', 'CANCELADO'];

export function estaAberto(status: string): boolean {
  return (STATUS_ABERTOS as string[]).includes(status);
}

/** Motivo aceito para o tipo. */
export function motivoValido(tipo: Tipo, motivo: string): boolean {
  return ((tipo === 'EXTERNO' ? MOTIVOS_EXTERNO : MOTIVOS_INTERNO) as readonly string[]).includes(motivo);
}

/**
 * Troca de status do chamado EXTERNO (o INTERNO usa encaminhar/fechar). Qualquer status do
 * externo pode ir para outro — o órgão reabre protocolo —, menos ficar no mesmo.
 */
export function podeMudarStatus(tipo: string, de: string, para: string): { ok: true } | { erro: string } {
  if (tipo !== 'EXTERNO') return { erro: 'Chamado de reparo usa encaminhar e fechar' };
  if (!(STATUS_EXTERNO as readonly string[]).includes(para)) return { erro: `Status inválido: ${para}` };
  if (de === para) return { erro: `O chamado já está ${STATUS_ROTULO[para as StatusChamado].toLowerCase()}` };
  return { ok: true };
}

/** Início do relógio do chamado: começo da ocorrência, abertura no órgão ou cadastro. */
export function inicioDoChamado(c: { ocorrencia_em?: Date | null; aberto_em?: Date | null; created_at: Date }): Date {
  return c.ocorrencia_em ?? c.aberto_em ?? c.created_at;
}

/** Horas entre o início e o encerramento (ou agora, se aberto). Nunca negativo. */
export function duracaoHoras(
  c: { ocorrencia_em?: Date | null; aberto_em?: Date | null; created_at: Date; fechado_em?: Date | null },
  agora: Date = new Date(),
): number {
  const fim = c.fechado_em ?? agora;
  return Math.max(0, (fim.getTime() - inicioDoChamado(c).getTime()) / 36e5);
}

export interface LinhaEstatistica {
  tipo: string;
  status: string;
  motivo: string;
  orgao: string | null;
  planta_id: string | null;
  equipamento_id: string | null;
  ocorrencia_em: Date | null;
  aberto_em: Date | null;
  previsao_em: Date | null;
  fechado_em: Date | null;
  created_at: Date;
}

/** Chave AAAA-MM no fuso de Brasília. */
export function mesBR(d: Date): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).format(d);
  return p.slice(0, 7);
}

/** Últimos `n` meses (AAAA-MM), do mais antigo ao atual. */
export function ultimosMeses(n: number, agora: Date = new Date()): string[] {
  const [a, m] = mesBR(agora).split('-').map(Number);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const t = a * 12 + (m - 1) - i;
    out.push(`${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`);
  }
  return out;
}

const media = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);

function top(m: Map<string, number>, n: number) {
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([chave, total]) => ({ chave, total }));
}

/**
 * Indicadores da página de chamados, sobre as linhas já recortadas pelo escopo e pelos filtros.
 * Puro: o service só busca as linhas e troca ids por nomes.
 */
export function agregarEstatisticas(linhas: LinhaEstatistica[], agora: Date = new Date(), meses = 12) {
  const abertos = linhas.filter((l) => estaAberto(l.status));
  const resolvidos = linhas.filter((l) => l.status === 'RESOLVIDO' || l.status === 'FECHADO');
  const inicioMes = mesBR(agora);
  const chaves = ultimosMeses(meses, agora);
  const porMes = new Map(chaves.map((k) => [k, { mes: k, abertos: 0, resolvidos: 0 }]));
  const conta = (m: Map<string, number>, k: string | null | undefined) => {
    const c = (k ?? '').trim() || '—';
    m.set(c, (m.get(c) ?? 0) + 1);
  };
  const porStatus = new Map<string, number>();
  const porMotivo = new Map<string, number>();
  const porOrgao = new Map<string, number>();
  const porPlanta = new Map<string, number>();
  const porEquipamento = new Map<string, number>();

  for (const l of linhas) {
    const a = porMes.get(mesBR(inicioDoChamado(l)));
    if (a) a.abertos++;
    if (l.fechado_em && (l.status === 'RESOLVIDO' || l.status === 'FECHADO')) {
      const r = porMes.get(mesBR(l.fechado_em));
      if (r) r.resolvidos++;
    }
    conta(porStatus, l.status);
    conta(porMotivo, l.motivo);
    if (l.tipo === 'EXTERNO') conta(porOrgao, l.orgao);
    if (l.planta_id) conta(porPlanta, l.planta_id);
    if (l.equipamento_id) conta(porEquipamento, l.equipamento_id);
  }

  const horasResolucao = resolvidos.map((l) => duracaoHoras(l, agora));
  const faltas = resolvidos.filter((l) => l.motivo === 'FALTA_ENERGIA').map((l) => duracaoHoras(l, agora));
  const atrasados = abertos.filter((l) => l.previsao_em && l.previsao_em.getTime() < agora.getTime()).length;
  const maisAntigo = abertos.reduce<number | null>((max, l) => {
    const h = duracaoHoras(l, agora);
    return max === null || h > max ? h : max;
  }, null);

  return {
    totais: {
      total: linhas.length,
      abertos: abertos.length,
      externos_abertos: abertos.filter((l) => l.tipo === 'EXTERNO').length,
      internos_abertos: abertos.filter((l) => l.tipo !== 'EXTERNO').length,
      resolvidos: resolvidos.length,
      resolvidos_no_mes: resolvidos.filter((l) => l.fechado_em && mesBR(l.fechado_em) === inicioMes).length,
      abertos_no_mes: linhas.filter((l) => mesBR(inicioDoChamado(l)) === inicioMes).length,
      previsao_vencida: atrasados,
      horas_media_resolucao: media(horasResolucao),
      horas_media_falta_energia: media(faltas),
      horas_aberto_mais_antigo: maisAntigo === null ? null : Math.round(maisAntigo * 10) / 10,
    },
    por_mes: [...porMes.values()],
    por_status: top(porStatus, 10),
    por_motivo: top(porMotivo, 10),
    por_orgao: top(porOrgao, 6),
    por_planta: top(porPlanta, 8),
    por_equipamento: top(porEquipamento, 8),
  };
}

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
