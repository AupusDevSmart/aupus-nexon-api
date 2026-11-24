/**
 * Regras puras da falta de energia (NEXON-145). Sem Prisma: testadas em falta-energia-regras.spec.ts.
 *
 * A TON avisa em `<base>/energia` que a rede caiu ou voltou. Passada a confirmação, o NexON abre
 * um chamado EXTERNO na concessionária (NEXON-144) e manda para o robô da Equatorial no WhatsAupus
 * (`POST /api/v1/webhook/nexon/falta-energia`), que conversa com a Clara e devolve o protocolo.
 */

export const STATUS_EVENTO = ['AGUARDANDO', 'CANCELADO', 'ENVIANDO', 'NO_ROBO', 'PROTOCOLO', 'SEM_DADOS', 'FALHOU'] as const;
export type StatusEvento = (typeof STATUS_EVENTO)[number];

export const STATUS_EVENTO_ROTULO: Record<StatusEvento, string> = {
  AGUARDANDO: 'Confirmando a falta',
  CANCELADO: 'Energia voltou antes de abrir',
  ENVIANDO: 'Enviando para o WhatsApp',
  NO_ROBO: 'Conversando com a concessionária',
  PROTOCOLO: 'Protocolo recebido',
  SEM_DADOS: 'Abrir na mão (faltam dados)',
  FALHOU: 'Abrir na mão (robô falhou)',
};

/** Tentativas de entregar ao WhatsAupus antes de virar FALHOU. */
export const MAX_TENTATIVAS = 5;

/** Minutos de falta contínua antes de abrir o chamado (piscada não abre). */
export function minutosConfirmacao(env: string | undefined = process.env.FALTA_ENERGIA_CONFIRMAR_MIN): number {
  const n = Number(env);
  return Number.isFinite(n) && n >= 0 && n <= 120 ? n : 3;
}

/** Desligado só com FALTA_ENERGIA_ATIVO=false/0/nao. */
export function automacaoLigada(env: string | undefined = process.env.FALTA_ENERGIA_ATIVO): boolean {
  return !/^(false|0|nao|não|off)$/i.test((env ?? '').trim());
}

export interface AvisoEnergia {
  tipo: 'falta' | 'retorno';
  /** Quando aconteceu (relógio da TON); sem relógio válido, `agora`. */
  em: Date;
}

const FALTA = /^(falta|sem_?rede|queda|off|down|0|false)$/i;
const RETORNO = /^(retorno|volta|normal|com_?rede|on|up|1|true)$/i;

/**
 * Lê o payload da TON. Aceita `{evento:"falta"|"retorno"}`, `{rede:0|1}` ou `{estado:"sem_rede"|"normal"}`,
 * com `ts` em segundos, milissegundos ou ISO. Relógio fora de ±2 dias de `agora` é ignorado
 * (TON sem NTP manda 1970). Null quando não entende.
 */
export function lerAviso(dados: unknown, agora = new Date()): AvisoEnergia | null {
  if (!dados || typeof dados !== 'object') return null;
  const d = dados as Record<string, unknown>;
  const bruto = d.evento ?? d.estado ?? d.rede ?? d.status;
  if (bruto === undefined || bruto === null) return null;
  const s = String(bruto).trim();
  const tipo = FALTA.test(s) ? 'falta' : RETORNO.test(s) ? 'retorno' : null;
  if (!tipo) return null;
  return { tipo, em: lerInstante(d.ts ?? d.em ?? d.timestamp, agora) };
}

function lerInstante(v: unknown, agora: Date): Date {
  let ms: number | null = null;
  if (typeof v === 'number' && Number.isFinite(v)) ms = v < 1e11 ? v * 1000 : v;
  else if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    ms = Number.isFinite(n) ? (n < 1e11 ? n * 1000 : n) : Date.parse(v);
  }
  if (ms === null || !Number.isFinite(ms)) return agora;
  return Math.abs(ms - agora.getTime()) <= 2 * 86_400_000 ? new Date(ms) : agora;
}

/** Avisos da mesma UC caem no mesmo evento: unidade quando há, senão a planta. */
export function chaveDoEvento(unidadeId: string | null | undefined, plantaId: string): string {
  return unidadeId?.trim() ? `u:${unidadeId.trim()}` : `p:${plantaId.trim()}`;
}

/** Número da instalação (UC) só com dígitos; null se não parece UC. */
export function normalizarUc(v: string | null | undefined): string | null {
  const d = (v ?? '').replace(/\D/g, '');
  return d.length >= 5 && d.length <= 20 ? d : null;
}

const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

/**
 * O robô do WhatsAupus só fala com a Equatorial Goiás (Clara, 62 3243-2020). Vale quando a
 * concessionária da unidade é Equatorial de GO, ou quando não há concessionária e a instalação é em GO.
 */
export function atendidaPeloRobo(o: {
  concessionariaNome: string | null | undefined;
  concessionariaUf: string | null | undefined;
  uf: string | null | undefined;
}): boolean {
  const uf = (o.concessionariaUf || o.uf || '').trim().toUpperCase();
  if (uf !== 'GO') return false;
  if (!o.concessionariaNome?.trim()) return true;
  return semAcento(o.concessionariaNome).includes('EQUATORIAL');
}

export interface DadosInstalacao {
  uc: string | null;
  concessionariaNome: string | null;
  concessionariaUf: string | null;
  planta: {
    nome: string;
    logradouro: string | null;
    bairro: string | null;
    cidade: string | null;
    uf: string | null;
    cep: string | null;
  };
  proprietario: { nome: string; cpfCnpj: string | null; telefone: string | null } | null;
}

/** O que falta para o robô abrir sozinho. Lista vazia = pode mandar. */
export function pendenciasParaRobo(d: DadosInstalacao): string[] {
  const p: string[] = [];
  if (!normalizarUc(d.uc)) p.push('número da UC da unidade');
  if (!atendidaPeloRobo({ concessionariaNome: d.concessionariaNome, concessionariaUf: d.concessionariaUf, uf: d.planta.uf })) {
    p.push('concessionária atendida pelo robô (só Equatorial Goiás)');
  }
  if (!d.proprietario?.nome?.trim()) p.push('proprietário da planta');
  if ((d.proprietario?.telefone ?? '').replace(/\D/g, '').length < 10) p.push('telefone do proprietário');
  return p;
}

/** Corpo do `POST /api/v1/webhook/nexon/falta-energia` do WhatsAupus (NexonWebhookPayload). */
export function montarPayloadWhatsaupus(o: {
  eventoId: string;
  dados: DadosInstalacao;
  inicio: Date;
  equipamentoNome: string | null;
  callbackUrl: string;
}) {
  const { dados } = o;
  const tel = (dados.proprietario?.telefone ?? '').replace(/\D/g, '');
  return {
    eventId: o.eventoId,
    uc: normalizarUc(dados.uc)!,
    endereco: {
      logradouro: dados.planta.logradouro ?? undefined,
      bairro: dados.planta.bairro ?? undefined,
      cidade: dados.planta.cidade ?? undefined,
      uf: dados.planta.uf ?? undefined,
      cep: dados.planta.cep ?? undefined,
    },
    cliente: {
      nome: dados.proprietario?.nome?.trim() || undefined,
      cpfCnpj: dados.proprietario?.cpfCnpj?.replace(/\D/g, '') || undefined,
      telefone: tel.startsWith('55') && tel.length > 11 ? tel.slice(2) : tel,
    },
    ocorrencia: {
      tipo: 'falta_energia',
      inicio: o.inicio.toISOString(),
      descricao: `Falta de energia detectada pela TON${o.equipamentoNome ? ` ${o.equipamentoNome}` : ''} na planta ${dados.planta.nome} (NexON).`,
    },
    callbackUrl: o.callbackUrl,
  };
}

export interface RetornoWhatsaupus {
  status: 'completed' | 'failed' | 'needs_human' | string;
  protocolo: string | null;
  erro: string | null;
  complaintId: string | null;
}

/** Lê o callback do WhatsAupus (dispatchCallback). Protocolo só com dígitos/letras, até 40. */
export function lerRetornoWhatsaupus(body: unknown): RetornoWhatsaupus {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const proto = typeof b.protocoloEquatorial === 'string' ? b.protocoloEquatorial : typeof b.protocolo === 'string' ? b.protocolo : null;
  const limpo = proto ? proto.replace(/[^0-9A-Za-z-]/g, '').slice(0, 40) : null;
  return {
    status: String(b.status ?? '').toLowerCase(),
    protocolo: limpo || null,
    erro: typeof b.errorMessage === 'string' ? b.errorMessage.slice(0, 500) : null,
    complaintId: typeof b.complaintId === 'string' ? b.complaintId.slice(0, 40) : null,
  };
}

/** Duração legível para a nota do chamado ("1 h 05 min", "12 min"). */
export function duracao(de: Date, ate: Date): string {
  const min = Math.max(0, Math.round((ate.getTime() - de.getTime()) / 60_000));
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

export function horaBr(d: Date): string {
  return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
