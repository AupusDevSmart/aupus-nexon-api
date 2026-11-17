import { randomInt } from 'node:crypto';
/**
 * Câmeras (NEXON-88): regras PURAS, sem banco nem Nest — armamento (agenda/manual/desarmado),
 * o que vira alerta, títulos, filtros de evento, URL RTSP e horário local. Testadas em
 * cameras-regras.spec.ts. Contrato: NexON/docs/cameras/API-CAMERAS.md.
 */

export const TIPOS_EVENTO = ['pessoa', 'veiculo', 'animal', 'movimento', 'sem_sinal', 'sinal_restabelecido', 'foto'] as const;
export type TipoEvento = (typeof TIPOS_EVENTO)[number];
export const TIPOS_DETECCAO: readonly TipoEvento[] = ['pessoa', 'veiculo', 'animal', 'movimento'];
export const TIPOS_SISTEMA: readonly TipoEvento[] = ['sem_sinal', 'sinal_restabelecido'];
export const MOTIVOS_DESCARTE = ['desarmado', 'classe_ignorada', 'agente'] as const;
export type MotivoDescarte = (typeof MOTIVOS_DESCARTE)[number];
export const MODOS_ARMAMENTO = ['agenda', 'manual', 'desarmado'] as const;
export type ModoArmamento = (typeof MODOS_ARMAMENTO)[number];
export const DISPOSITIVOS = ['refletor', 'sirene'] as const;
export type Dispositivo = (typeof DISPOSITIVOS)[number];
export const STATUS_CAMERA = ['online', 'offline', 'desconhecido'] as const;
export const ESTADOS_COMANDO = ['pendente', 'entregue', 'ok', 'erro'] as const;

export const FUSO = 'America/Sao_Paulo';
/** Pedido de vídeo (GET /cameras/:id/stream) mantém o agente publicando por este tempo. */
export const STREAM_PEDIDO_S = 90;
/** Câmera ou agente sem contato há mais que isto = offline (worker e heartbeat). */
export const SEM_CONTATO_S = 180;
/** Token de mídia (<img>/<video>/HLS). */
export const TOKEN_MIDIA_S = 2 * 60 * 60;
/** Token de publicação do agente no MediaMTX (vai no GET /cameras/agente/config). */
export const TOKEN_PUBLICAR_S = 30 * 60;
/** Intervalo sugerido ao agente para buscar config e comandos. */
export const POLL_S = 15;
export const AGENDA_INICIO_PADRAO = '18:00';
export const AGENDA_FIM_PADRAO = '06:30';
export const PREFIXO_TOKEN_AGENTE = 'nxcam_';
export const PREFIXO_TOKEN_PUBLICAR = 'pub_';

export const TITULO_EVENTO: Record<TipoEvento, string> = {
  pessoa: 'Pessoa detectada',
  veiculo: 'Veículo detectado',
  animal: 'Animal detectado',
  movimento: 'Movimento detectado',
  sem_sinal: 'Câmera sem sinal',
  sinal_restabelecido: 'Câmera voltou',
  foto: 'Foto',
};

export function tituloEvento(tipo: string): string {
  return TITULO_EVENTO[tipo as TipoEvento] ?? tipo;
}

// ---------------------------------------------------------------------------
// Análise (jsonb `cameras.analise`)
// ---------------------------------------------------------------------------

export interface Analise {
  ativa: boolean;
  sensibilidade: number;
  area_minima_pct: number;
  fps_analise: number;
  classificar: boolean;
  classes_alerta: string[];
  /** Segundos depois do início do evento no clipe. */
  clipe_s: number;
  /** Segundos antes do início (o agente guarda os últimos segundos da câmera). */
  pre_s: number;
  zonas: unknown[];
}

export const ANALISE_PADRAO: Analise = {
  ativa: true,
  sensibilidade: 50,
  area_minima_pct: 0.5,
  fps_analise: 4,
  classificar: true,
  classes_alerta: ['pessoa', 'veiculo'],
  clipe_s: 15,
  pre_s: 10,
  zonas: [],
};

/** Preenche o que faltar com o padrão; ignora chaves desconhecidas. */
export function normalizarAnalise(v: unknown): Analise {
  const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const num = (x: unknown, padrao: number) => (typeof x === 'number' && Number.isFinite(x) ? x : padrao);
  const bool = (x: unknown, padrao: boolean) => (typeof x === 'boolean' ? x : padrao);
  return {
    ativa: bool(o.ativa, ANALISE_PADRAO.ativa),
    sensibilidade: num(o.sensibilidade, ANALISE_PADRAO.sensibilidade),
    area_minima_pct: num(o.area_minima_pct, ANALISE_PADRAO.area_minima_pct),
    fps_analise: num(o.fps_analise, ANALISE_PADRAO.fps_analise),
    classificar: bool(o.classificar, ANALISE_PADRAO.classificar),
    classes_alerta: Array.isArray(o.classes_alerta)
      ? o.classes_alerta.filter((c): c is string => typeof c === 'string')
      : [...ANALISE_PADRAO.classes_alerta],
    clipe_s: num(o.clipe_s, ANALISE_PADRAO.clipe_s),
    pre_s: Math.min(30, Math.max(0, num(o.pre_s, ANALISE_PADRAO.pre_s))),
    zonas: Array.isArray(o.zonas) ? o.zonas : [],
  };
}

// ---------------------------------------------------------------------------
// Horário local (America/Sao_Paulo) sem biblioteca
// ---------------------------------------------------------------------------

export interface PartesLocais {
  ano: number;
  mes: number;
  dia: number;
  hora: number;
  minuto: number;
  segundo: number;
}

export function partesLocais(d: Date, fuso = FUSO): PartesLocais {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: fuso,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, number> = {};
  for (const parte of f.formatToParts(d)) {
    if (parte.type !== 'literal') p[parte.type] = Number(parte.value);
  }
  return { ano: p.year, mes: p.month, dia: p.day, hora: p.hour % 24, minuto: p.minute, segundo: p.second };
}

/** Deslocamento do fuso em minutos (UTC − local) no instante dado. */
function deslocamentoMin(d: Date, fuso: string): number {
  const p = partesLocais(d, fuso);
  const comoUtc = Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo);
  return Math.round((comoUtc - d.getTime()) / 60_000);
}

/** Instante UTC de uma hora de parede local (ano/mês/dia/hora/minuto) no fuso. */
export function instanteLocal(
  ano: number,
  mes: number,
  dia: number,
  hora = 0,
  minuto = 0,
  fuso = FUSO,
): Date {
  const chute = Date.UTC(ano, mes - 1, dia, hora, minuto, 0);
  let ms = chute - deslocamentoMin(new Date(chute), fuso) * 60_000;
  // Segunda passada cobre mudança de horário entre o chute e o resultado.
  ms = chute - deslocamentoMin(new Date(ms), fuso) * 60_000;
  return new Date(ms);
}

/** Dia local (AAAA-MM-DD) → [início, fim) em UTC. Inválido → null. */
export function intervaloDoDia(dia: string, fuso = FUSO): { inicio: Date; fim: Date } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dia?.trim() ?? '');
  if (!m) return null;
  const [ano, mes, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mes < 1 || mes > 12 || d < 1 || d > 31) return null;
  const inicio = instanteLocal(ano, mes, d, 0, 0, fuso);
  const proximo = new Date(Date.UTC(ano, mes - 1, d + 1));
  const fim = instanteLocal(proximo.getUTCFullYear(), proximo.getUTCMonth() + 1, proximo.getUTCDate(), 0, 0, fuso);
  return { inicio, fim };
}

/** Período máximo de uma consulta de eventos por datas (dias). */
export const PERIODO_MAX_DIAS = 92;

/**
 * Janelas de tempo do filtro de eventos (hora de Brasília): dias `de`..`ate` (inclusive) e, opcional, só a
 * faixa `hora_de`..`hora_ate` de cada dia. Faixa que passa da meia-noite (18:00 → 06:00) vai até a manhã
 * seguinte. Sem faixa: um intervalo só, do começo de `de` ao fim de `ate`. Inválido → null.
 */
export function janelasDoPeriodo(
  de: string,
  ate: string,
  horaDe?: string | null,
  horaAte?: string | null,
  fuso = FUSO,
): { inicio: Date; fim: Date }[] | null {
  const a = intervaloDoDia(de, fuso);
  const b = intervaloDoDia(ate, fuso);
  if (!a || !b || b.inicio < a.inicio) return null;
  const dias = Math.round((b.inicio.getTime() - a.inicio.getTime()) / 86_400_000) + 1;
  if (dias > PERIODO_MAX_DIAS) return null;
  const hDe = horaDe ? minutosDe(horaDe) : null;
  const hAte = horaAte ? minutosDe(horaAte) : null;
  if ((horaDe && hDe === null) || (horaAte && hAte === null)) return null;
  if (hDe === null && hAte === null) return [{ inicio: a.inicio, fim: b.fim }];
  const ini = hDe ?? 0;
  const fimMin = hAte ?? 24 * 60;
  const [ano, mes, d0] = de.split('-').map(Number);
  const janelas: { inicio: Date; fim: Date }[] = [];
  for (let i = 0; i < dias; i++) {
    const base = new Date(Date.UTC(ano, mes - 1, d0 + i));
    const [y, m, d] = [base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate()];
    const inicio = instanteLocal(y, m, d, Math.floor(ini / 60), ini % 60, fuso);
    // faixa até 24:00 ou que vira a noite: termina no dia seguinte
    const vira = fimMin <= ini;
    const prox = new Date(Date.UTC(y, m - 1, d + (vira || fimMin === 24 * 60 ? 1 : 0)));
    const minFim = fimMin === 24 * 60 ? 0 : fimMin;
    const fim = instanteLocal(prox.getUTCFullYear(), prox.getUTCMonth() + 1, prox.getUTCDate(), Math.floor(minFim / 60), minFim % 60, fuso);
    janelas.push({ inicio, fim });
  }
  return janelas;
}

/** "18:00" → minutos desde a meia-noite; inválido → null. */
export function minutosDe(hhmm: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec((hhmm ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/** Coluna `time` lida pelo Prisma (1970-01-01T18:00:00.000Z) → "18:00". Aceita também "18:00". */
export function hhmm(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  if (typeof v === 'string') return minutosDe(v) === null ? null : v.slice(0, 5);
  if (Number.isNaN(v.getTime())) return null;
  return v.toISOString().slice(11, 16);
}

/** "18:00" → Date que o Prisma grava numa coluna `time` (hora em UTC do dia 1970-01-01). */
export function timeDe(hhmmStr: string | null | undefined): Date | null {
  const min = minutosDe(hhmmStr);
  if (min === null) return null;
  return new Date(Date.UTC(1970, 0, 1, Math.floor(min / 60), min % 60, 0));
}

function minutosLocais(d: Date, fuso: string): number {
  const p = partesLocais(d, fuso);
  return p.hora * 60 + p.minuto;
}

/** Hoje (local) numa hora de parede; `deslocaDias` move o dia. */
function hojeAs(agora: Date, minutos: number, deslocaDias: number, fuso: string): Date {
  const p = partesLocais(agora, fuso);
  const dia = new Date(Date.UTC(p.ano, p.mes - 1, p.dia + deslocaDias));
  return instanteLocal(dia.getUTCFullYear(), dia.getUTCMonth() + 1, dia.getUTCDate(), Math.floor(minutos / 60), minutos % 60, fuso);
}

// ---------------------------------------------------------------------------
// Armamento
// ---------------------------------------------------------------------------

export interface ConfigArmamento {
  armamento_modo: string;
  armado_manual: boolean;
  armado_manual_ate: Date | null;
  agenda_inicio: Date | string | null;
  agenda_fim: Date | string | null;
}

function agendaMinutos(c: ConfigArmamento): { inicio: number; fim: number } {
  return {
    inicio: minutosDe(hhmm(c.agenda_inicio)) ?? minutosDe(AGENDA_INICIO_PADRAO)!,
    fim: minutosDe(hhmm(c.agenda_fim)) ?? minutosDe(AGENDA_FIM_PADRAO)!,
  };
}

/** Dentro de [inicio, fim) em minutos do dia, com virada de meia-noite. inicio == fim = sempre. */
export function dentroDaJanela(minutoAtual: number, inicio: number, fim: number): boolean {
  if (inicio === fim) return true;
  if (inicio < fim) return minutoAtual >= inicio && minutoAtual < fim;
  return minutoAtual >= inicio || minutoAtual < fim;
}

/** Armamento manual com prazo futuro vale por cima da agenda. */
export function overrideVigente(c: ConfigArmamento, agora: Date): boolean {
  return c.armamento_modo === 'agenda' && !!c.armado_manual_ate && c.armado_manual_ate.getTime() > agora.getTime();
}

export function estaArmado(c: ConfigArmamento | null | undefined, agora = new Date(), fuso = FUSO): boolean {
  if (!c) return dentroDaJanela(minutosLocais(agora, fuso), minutosDe(AGENDA_INICIO_PADRAO)!, minutosDe(AGENDA_FIM_PADRAO)!);
  switch (c.armamento_modo) {
    case 'desarmado':
      return false;
    case 'manual':
      return c.armado_manual && (!c.armado_manual_ate || c.armado_manual_ate.getTime() > agora.getTime());
    default: {
      if (overrideVigente(c, agora)) return c.armado_manual;
      const a = agendaMinutos(c);
      return dentroDaJanela(minutosLocais(agora, fuso), a.inicio, a.fim);
    }
  }
}

/** Próxima ocorrência (estritamente depois de `agora`) de uma hora de parede local. */
export function proximaOcorrencia(agora: Date, minutos: number, fuso = FUSO): Date {
  const hoje = hojeAs(agora, minutos, 0, fuso);
  return hoje.getTime() > agora.getTime() ? hoje : hojeAs(agora, minutos, 1, fuso);
}

/** Última ocorrência (até `agora`, inclusive) de uma hora de parede local. */
export function ultimaOcorrencia(agora: Date, minutos: number, fuso = FUSO): Date {
  const hoje = hojeAs(agora, minutos, 0, fuso);
  return hoje.getTime() <= agora.getTime() ? hoje : hojeAs(agora, minutos, -1, fuso);
}

/** manual → armado_manual_ate; agenda (ou override) → prazo do override ou próximo agenda_fim; senão null. */
export function armadoAte(c: ConfigArmamento | null | undefined, agora = new Date(), fuso = FUSO): Date | null {
  if (!c) return proximaOcorrencia(agora, minutosDe(AGENDA_FIM_PADRAO)!, fuso);
  switch (c.armamento_modo) {
    case 'desarmado':
      return null;
    case 'manual':
      return c.armado_manual ? c.armado_manual_ate : null;
    default:
      if (overrideVigente(c, agora)) return c.armado_manual_ate;
      return proximaOcorrencia(agora, agendaMinutos(c).fim, fuso);
  }
}

/** Modo mostrado no resumo: `manual` se há override vigente, senão o modo gravado. */
export function modoVigente(c: ConfigArmamento | null | undefined, agora = new Date()): ModoArmamento {
  if (!c) return 'agenda';
  if (overrideVigente(c, agora)) return 'manual';
  return (MODOS_ARMAMENTO as readonly string[]).includes(c.armamento_modo) ? (c.armamento_modo as ModoArmamento) : 'agenda';
}

export interface DecisaoArmar {
  armamento_modo: ModoArmamento;
  armado_manual: boolean;
  armado_manual_ate: Date | null;
}

function modoGravado(c: ConfigArmamento): ModoArmamento {
  return (MODOS_ARMAMENTO as readonly string[]).includes(c.armamento_modo) ? (c.armamento_modo as ModoArmamento) : 'agenda';
}

/**
 * POST /cameras/unidades/:id/armar. Com `ate`: sobrepõe até lá no modo atual (desarmado vira
 * manual). Sem `ate`: manual → liga/desliga sem prazo; desarmado → armar vira manual sem prazo e
 * desarmar não muda nada; agenda → sobrepõe até a próxima virada da agenda (armar fora da janela
 * vale até o próximo início, desarmar dentro da janela vale até o próximo fim) e um pedido que já
 * coincide com a agenda só limpa o override — a agenda nunca é desligada por aqui.
 */
export function decidirArmar(
  c: ConfigArmamento,
  armado: boolean,
  ate: Date | null,
  agora = new Date(),
  fuso = FUSO,
): DecisaoArmar {
  const modo = modoGravado(c);
  if (ate) {
    return { armamento_modo: modo === 'desarmado' ? 'manual' : modo, armado_manual: armado, armado_manual_ate: ate };
  }
  if (modo === 'manual') return { armamento_modo: 'manual', armado_manual: armado, armado_manual_ate: null };
  if (modo === 'desarmado') {
    return armado
      ? { armamento_modo: 'manual', armado_manual: true, armado_manual_ate: null }
      : { armamento_modo: 'desarmado', armado_manual: false, armado_manual_ate: null };
  }
  const a = agendaMinutos(c);
  const pelaAgenda = dentroDaJanela(minutosLocais(agora, fuso), a.inicio, a.fim);
  if (pelaAgenda === armado) return { armamento_modo: 'agenda', armado_manual: armado, armado_manual_ate: null };
  const limite = proximaOcorrencia(agora, armado ? a.inicio : a.fim, fuso);
  return { armamento_modo: 'agenda', armado_manual: armado, armado_manual_ate: limite };
}

/** Começo da "noite" do resumo: último agenda_inicio (ou 18:00) até agora. */
export function inicioDaNoite(c: ConfigArmamento | null | undefined, agora = new Date(), fuso = FUSO): Date {
  const inicio = c ? agendaMinutos(c).inicio : minutosDe(AGENDA_INICIO_PADRAO)!;
  return ultimaOcorrencia(agora, inicio, fuso);
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------

export interface DecisaoEvento {
  alerta: boolean;
  descartado: boolean;
  motivo_descarte: MotivoDescarte | null;
  enviar_clipe: boolean;
}

/**
 * Detecção fora do armamento → descartada (`desarmado`); classe fora de `classes_alerta` →
 * descartada (`classe_ignorada`); senão alerta. `sem_sinal` sempre alerta; `sinal_restabelecido`
 * e `foto` nunca. Clipe só para alerta de detecção com `clipe_s` > 0.
 */
export function decidirEvento(tipo: string, armado: boolean, analise: Partial<Analise> | null | undefined): DecisaoEvento {
  const a = normalizarAnalise(analise);
  let alerta = false;
  let descartado = false;
  let motivo: MotivoDescarte | null = null;

  // Detecção roda 24 h: classe escolhida sempre vira evento com foto e clipe. Armar só decide
  // o ALERTA (aviso, alarme, chamado, sirene); desarmado o evento fica na lista sem alerta.
  const deteccao = (TIPOS_DETECCAO as readonly string[]).includes(tipo);
  if (deteccao) {
    if (!a.classes_alerta.includes(tipo)) {
      descartado = true;
      motivo = 'classe_ignorada';
    } else {
      alerta = armado;
    }
  } else if (tipo === 'sem_sinal') {
    alerta = true;
  }

  const enviar_clipe = deteccao && !descartado && a.clipe_s > 0;
  return { alerta, descartado, motivo_descarte: motivo, enviar_clipe };
}

/** "pessoa,sistema" → ['pessoa','sem_sinal','sinal_restabelecido']; desconhecido → null. */
export function expandirTipos(filtro: string | null | undefined): TipoEvento[] | null {
  if (!filtro?.trim()) return null;
  const saida = new Set<TipoEvento>();
  for (const bruto of filtro.split(',')) {
    const t = bruto.trim().toLowerCase();
    if (!t) continue;
    if (t === 'sistema') TIPOS_SISTEMA.forEach((s) => saida.add(s));
    else if ((TIPOS_EVENTO as readonly string[]).includes(t)) saida.add(t as TipoEvento);
    else return null;
  }
  return saida.size ? [...saida] : null;
}

/** `dados` do multipart chega como texto JSON; objeto → objeto; inválido → null. */
export function interpretarDados(v: unknown): Record<string, unknown> | null {
  if (v == null || v === '') return {};
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v !== 'string') return null;
  try {
    const o = JSON.parse(v);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

/** Classes que o agente pode dar a um evento que nasceu como `movimento` (NEXON-108). */
export const TIPOS_CLASSE = ['pessoa', 'veiculo', 'animal'] as const;
export type TipoClasse = (typeof TIPOS_CLASSE)[number];
export const CAIXAS_MAX = 50;

/**
 * O agente às vezes só reconhece o objeto alguns quadros depois de abrir o evento (carro longe,
 * pessoa entrando no quadro). A reclassificação só sobe de `movimento` para uma classe: nunca
 * rebaixa, nunca troca uma classe por outra, nunca mexe em sem_sinal/foto. `null` = nada a fazer.
 */
export function tipoReclassificado(atual: string, novo: unknown): TipoClasse | null {
  if (atual !== 'movimento') return null;
  return typeof novo === 'string' && (TIPOS_CLASSE as readonly string[]).includes(novo) ? (novo as TipoClasse) : null;
}

/**
 * Decisão de alerta na reclassificação. Refaz decidirEvento com a classe nova e o armamento de
 * agora; `notificar` só quando passa a alertar e ainda não tinha alertado (alerta sai uma vez).
 */
export function decidirReclassificacao(
  tipo: TipoClasse,
  jaAlertou: boolean,
  armado: boolean,
  analise: Partial<Analise> | null | undefined,
): DecisaoEvento & { notificar: boolean } {
  const d = decidirEvento(tipo, armado, analise);
  // já alertou como movimento: segue alerta, sem novo aviso nem novo clipe
  if (jaAlertou) return { alerta: true, descartado: false, motivo_descarte: null, enviar_clipe: false, notificar: false };
  return { ...d, notificar: d.alerta };
}

/** Caixas normalizadas vindas do agente (objeto JSON ou texto JSON no multipart). Inválido → null. */
export function interpretarCaixas(v: unknown): Record<string, unknown>[] | null {
  let lista = v;
  if (typeof v === 'string') {
    try {
      lista = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(lista)) return null;
  return lista.slice(0, CAIXAS_MAX).filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && !Array.isArray(c));
}

// ---------------------------------------------------------------------------
// Agente / mídia
// ---------------------------------------------------------------------------

export interface CameraRtsp {
  fabricante: string | null;
  ip: string;
  porta_rtsp: number;
  usuario: string;
  canal: number;
}

/** Câmeras Wi-Fi do app Yoosee (Gwell): mesmo firmware sob várias marcas. */
const FABRICANTES_YOOSEE = new Set(['yoosee', 'gwell', 'yyp2p']);

/**
 * URL RTSP com usuário e senha codificados. subtype 0 = principal, 1 = secundário.
 * Caminho por fabricante: Intelbras/Dahua (padrão), Hikvision e Yoosee (`/onvif1` e `/onvif2`).
 */
export function montarRtsp(c: CameraRtsp, senha: string, subtype: 0 | 1): string {
  const cred = `${encodeURIComponent(c.usuario)}:${encodeURIComponent(senha)}`;
  const host = c.ip.includes(':') && !c.ip.startsWith('[') ? `[${c.ip}]` : c.ip;
  const canal = Math.max(1, c.canal || 1);
  const fabricante = (c.fabricante ?? '').trim().toLowerCase();
  if (FABRICANTES_YOOSEE.has(fabricante)) {
    return `rtsp://${cred}@${host}:${c.porta_rtsp}/onvif${subtype + 1}`;
  }
  if (fabricante === 'hikvision') {
    return `rtsp://${cred}@${host}:${c.porta_rtsp}/Streaming/Channels/${canal}0${subtype + 1}`;
  }
  return `rtsp://${cred}@${host}:${c.porta_rtsp}/cam/realmonitor?channel=${canal}&subtype=${subtype}`;
}

export function caminhoStream(cameraId: string): string {
  return `cam-${cameraId.trim()}`;
}

/** "cam-<id>" → id; qualquer outra coisa → null. */
export function cameraDoCaminho(path: string | null | undefined): string | null {
  const m = /^cam-([a-z0-9]{1,26})$/.exec((path ?? '').trim());
  return m ? m[1] : null;
}

export function agenteOnline(ultimoContatoEm: Date | null | undefined, agora = new Date()): boolean {
  return !!ultimoContatoEm && agora.getTime() - ultimoContatoEm.getTime() <= SEM_CONTATO_S * 1000;
}

export function streamAtivo(streamPedidoEm: Date | null | undefined, continuo: boolean, agora = new Date()): boolean {
  if (continuo) return true;
  return !!streamPedidoEm && agora.getTime() - streamPedidoEm.getTime() <= STREAM_PEDIDO_S * 1000;
}

/** `token=...` dentro da query string que o MediaMTX repassa. */
export function tokenDaQuery(query: string | null | undefined): string | null {
  if (!query) return null;
  try {
    const t = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query).get('token');
    return t?.trim() || null;
  } catch {
    return null;
  }
}

export function ehLoopback(ip: string | null | undefined): boolean {
  const v = (ip ?? '').trim().replace(/^::ffff:/, '');
  return v === '127.0.0.1' || v === '::1' || v.startsWith('127.');
}

// ---------------------------------------------------------------------------
// Arquivos
// ---------------------------------------------------------------------------

export function ehJpeg(buf: Buffer | null | undefined): boolean {
  return !!buf && buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

export function ehMp4(buf: Buffer | null | undefined): boolean {
  return !!buf && buf.length > 12 && buf.toString('latin1', 4, 8) === 'ftyp';
}

// ---------------------------------------------------------------------------
// E-mail de alerta
// ---------------------------------------------------------------------------

export interface AlertaParaEmail {
  tipo: string;
  inicio_em: Date;
  confianca: number | null;
  camera_nome: string;
  unidade_nome: string | null;
  planta_nome: string | null;
  link: string;
}

function escapar(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

export function horaLocal(d: Date, fuso = FUSO): string {
  const p = partesLocais(d, fuso);
  const dd = (n: number) => String(n).padStart(2, '0');
  return `${dd(p.dia)}/${dd(p.mes)}/${p.ano} ${dd(p.hora)}:${dd(p.minuto)}`;
}

export function emailDoAlerta(a: AlertaParaEmail): { assunto: string; html: string } {
  const titulo = tituloEvento(a.tipo);
  const local = [a.unidade_nome, a.planta_nome].filter(Boolean).join(' · ');
  const assunto = `[NexON] ${titulo} — ${a.camera_nome}${a.unidade_nome ? ` · ${a.unidade_nome}` : ''}`;
  const linhas = [
    `<p style="margin:0 0 8px"><strong>${escapar(titulo)}</strong></p>`,
    `<p style="margin:0">Câmera: <strong>${escapar(a.camera_nome)}</strong></p>`,
    local ? `<p style="margin:0">Local: ${escapar(local)}</p>` : '',
    `<p style="margin:0">Horário: ${horaLocal(a.inicio_em)} (Brasília)</p>`,
    a.confianca != null ? `<p style="margin:0">Confiança: ${Math.round(a.confianca * 100)}%</p>` : '',
    `<p style="margin:16px 0 0"><a href="${escapar(a.link)}">Abrir no NexON</a></p>`,
    `<p style="margin:16px 0 0;color:#6b7280;font-size:12px">Aviso automático das câmeras do NexON.</p>`,
  ].filter(Boolean);
  return { assunto, html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111827">${linhas.join('')}</div>` };
}

// ---------------------------------------------------------------------------
// Câmera nova (NEXON-108): análise simplificada, só movimento na tela
// ---------------------------------------------------------------------------

/** Câmera nova alerta em qualquer detecção quando armada e não roda classificação (IA). */
export const CLASSES_ALERTA_NOVA_CAMERA: readonly string[] = ['pessoa', 'veiculo', 'animal'];

/**
 * Análise da câmera criada agora: o front manda só `{ativa, sensibilidade}`; o que não vier usa
 * `classes_alerta` = pessoa, veículo e animal e `classificar = true` (movimento puro não avisa). Câmeras existentes não passam aqui.
 */
export function analiseNovaCamera(v: unknown): Analise {
  const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const enviado = Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined));
  return normalizarAnalise({ classificar: true, classes_alerta: [...CLASSES_ALERTA_NOVA_CAMERA], ...enviado });
}

// ---------------------------------------------------------------------------
// Pareamento do aparelho (NEXON-108)
// ---------------------------------------------------------------------------

/** Validade do pedido de pareamento (o código some depois disso). */
export const PAREAMENTO_VALIDADE_S = 30 * 60;
/** Limite por IP nas rotas públicas: criar pedido / consultar estado (o agente consulta a cada 5 s). */
export const PAREAMENTO_LIMITE_CRIAR_MIN = 10;
export const PAREAMENTO_LIMITE_ESTADO_MIN = 30;
export const MSG_CODIGO_INVALIDO = 'Código não encontrado ou expirado';
/** Tentativas erradas de vincular: por usuário e por unidade, numa janela de 10 min. */
export const VINCULAR_FALHAS_USUARIO = 5;
export const VINCULAR_FALHAS_UNIDADE = 20;
export const VINCULAR_JANELA_MS = 10 * 60_000;
export const MSG_MUITAS_TENTATIVAS_VINCULAR = 'Muitas tentativas; aguarde alguns minutos';
/** Teto global de pedidos aguardando (não vinculados, não expirados); passou disso → 503. */
export const PAREAMENTO_MAX_PENDENTES = 500;
/** Pedidos aguardando vínculo por IP público (uma usina tem poucos aparelhos). */
export const PAREAMENTO_MAX_PENDENTES_POR_IP = 10;
/** Teto de chaves em memória de cada limitador (IP, usuário, unidade). */
export const LIMITADOR_MAX_CHAVES = 10_000;

/** Código para a trilha sem revelá-lo: só os 2 últimos dígitos ("123456" → "****56"). */
export function mascararCodigo(v: string | null | undefined): string | null {
  const d = (v ?? '').replace(/\s/g, '');
  if (!d) return null;
  return d.length <= 2 ? '*'.repeat(d.length) : `${'*'.repeat(d.length - 2)}${d.slice(-2)}`;
}

/** IPv6 por extenso (8 grupos de 4 hex) ou null se não for IPv6 válido. IPv4 embutido no fim é aceito. */
export function expandirIpv6(v: string): string[] | null {
  let t = v.trim().toLowerCase().split('%')[0];
  if (!t.includes(':')) return null;
  const v4 = t.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const o = v4[1].split('.').map(Number);
    if (o.some((n) => n > 255)) return null;
    t = t.slice(0, -v4[1].length) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const partes = t.split('::');
  if (partes.length > 2) return null;
  const esq = partes[0] ? partes[0].split(':') : [];
  const dir = partes.length === 2 && partes[1] ? partes[1].split(':') : [];
  const faltam = 8 - esq.length - dir.length;
  if (partes.length === 1 ? faltam !== 0 : faltam < 1) return null;
  const grupos = [...esq, ...Array(partes.length === 2 ? faltam : 0).fill('0'), ...dir];
  if (grupos.length !== 8 || grupos.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return grupos.map((g) => g.padStart(4, '0'));
}

/**
 * Chave do limite por origem: IPv4 inteiro; IPv6 pelo prefixo /64 (um cliente IPv6 costuma ter
 * a /64 inteira e trocaria de endereço a cada pedido). IPv4 mapeado (::ffff:a.b.c.d) vira IPv4.
 */
export function chaveLimiteIp(ip: string | null | undefined): string {
  const t = normalizarIp(ip);
  if (!t) return 'sem-ip';
  const g = expandirIpv6(t);
  if (!g) return t;
  return `${g.slice(0, 4).join(':')}::/64`;
}

export type EstadoPareamento = 'aguardando' | 'vinculado' | 'expirado';

export interface PareamentoEstadoBase {
  expira_em: Date;
  agente_id: string | null;
  vinculado_em: Date | null;
}

/**
 * Vinculado (agente criado) vale mesmo depois do prazo, para o aparelho buscar o token que a pessoa
 * gerou no último minuto; sem vínculo, passou de expira_em = expirado.
 */
export function estadoPareamento(p: PareamentoEstadoBase, agora = new Date()): EstadoPareamento {
  if (p.agente_id && p.vinculado_em) return 'vinculado';
  return p.expira_em.getTime() > agora.getTime() ? 'aguardando' : 'expirado';
}

/** O token só sai uma vez: vinculado, ainda cifrado e nunca entregue. */
export function deveEntregarToken(
  p: PareamentoEstadoBase & { token_cifrado: string | null; entregue_em: Date | null },
  agora = new Date(),
): boolean {
  return estadoPareamento(p, agora) === 'vinculado' && !!p.token_cifrado && !p.entregue_em;
}

/** 6 dígitos (com zeros à esquerda) fora de `emUso`; `sorteio` devolve inteiro em [0, 1_000_000). */
export function gerarCodigoUnico(emUso: Iterable<string>, sorteio: () => number, tentativas = 50): string {
  const usados = new Set(emUso);
  for (let i = 0; i < tentativas; i++) {
    const c = String(Math.abs(Math.trunc(sorteio())) % 1_000_000).padStart(6, '0');
    if (!usados.has(c)) return c;
  }
  throw new Error('Não foi possível gerar um código de pareamento livre');
}

/** Código digitado pela pessoa: só os dígitos ("123 456" → "123456"); fora de 6 dígitos → null. */
export function normalizarCodigo(v: string | null | undefined): string | null {
  const d = (v ?? '').replace(/\D/g, '');
  return d.length === 6 ? d : null;
}

/** IP para comparação: sem `::ffff:`, minúsculo, sem espaços. */
export function normalizarIp(v: string | null | undefined): string | null {
  const t = (v ?? '').trim().toLowerCase().replace(/^::ffff:/, '');
  return t || null;
}

/** "Aparelho nesta rede": o IP público do pedido é o mesmo de quem está logado. */
export function mesmoIp(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizarIp(a);
  return !!x && x === normalizarIp(b);
}

/**
 * Limite em memória por chave numa janela deslizante (padrão 60 s). O mapa tem teto de chaves:
 * passou do teto, tira as chaves sem batida na janela e, se ainda faltar espaço, as mais antigas.
 */
export class LimitadorPorMinuto {
  private readonly batidas = new Map<string, number[]>();

  constructor(
    private readonly limite: number,
    private readonly janelaMs = 60_000,
    private readonly maxChaves = LIMITADOR_MAX_CHAVES,
  ) {}

  get tamanho(): number {
    return this.batidas.size;
  }

  private recentes(chave: string, agora: number): number[] {
    const desde = agora - this.janelaMs;
    return (this.batidas.get(chave) ?? []).filter((t) => t > desde);
  }

  /** Já atingiu o limite? Não conta batida. */
  excedido(chave: string, agora = Date.now()): boolean {
    return this.recentes(chave, agora).length >= this.limite;
  }

  /** Conta uma batida (ex.: uma falha). */
  registrar(chave: string, agora = Date.now()): void {
    const lista = this.recentes(chave, agora);
    lista.push(agora);
    this.batidas.delete(chave); // reinsere no fim: ordem do Map = mais antiga primeiro
    this.batidas.set(chave, lista);
    if (this.batidas.size > this.maxChaves) this.podar(agora);
  }

  /** Desfaz uma batida contada em `agora` (tentativa reservada que deu certo). */
  desfazer(chave: string, agora: number): void {
    const lista = this.batidas.get(chave);
    if (!lista) return;
    const i = lista.lastIndexOf(agora);
    if (i >= 0) lista.splice(i, 1);
    if (!lista.length) this.batidas.delete(chave);
  }

  /** true = pode seguir (e conta a batida); false = passou do limite. */
  permitir(chave: string, agora = Date.now()): boolean {
    if (this.excedido(chave, agora)) return false;
    this.registrar(chave, agora);
    return true;
  }

  private podar(agora: number) {
    const desde = agora - this.janelaMs;
    for (const [k, v] of this.batidas) if (!v.some((t) => t > desde)) this.batidas.delete(k);
    for (const k of this.batidas.keys()) {
      if (this.batidas.size <= this.maxChaves) break;
      this.batidas.delete(k);
    }
  }
}

// ---------------------------------------------------------------------------
// Câmeras encontradas na rede (heartbeat `descobertas`, NEXON-108)
// ---------------------------------------------------------------------------

export const DESCOBERTAS_MAX = 64;
/** Descoberta vale 24 h na tela; mais velha que isso é apagada. */
export const DESCOBERTA_VALIDADE_S = 24 * 60 * 60;

export interface Descoberta {
  ip: string;
  mac: string | null;
  fabricante: string | null;
  modelo: string | null;
  serial: string | null;
  porta_http: number | null;
  porta_rtsp: number | null;
  inicializada: boolean | null;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/**
 * Câmera descoberta só pode estar na rede local: IPv4 literal privado (10/8, 172.16/12, 192.168/16)
 * ou link-local (169.254/16). Qualquer outra coisa (IP público, loopback, nome, IPv6) é descartada.
 */
export function ipPrivadoOuLinkLocal(ip: string): boolean {
  if (!IPV4.test(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}
const MAC = /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/;

/**
 * Saneia o que o agente mandou: só IPv4 válido, um por IP (o último vence), fabricante em
 * minúsculas, mac normalizado com ":", portas 1–65535, textos cortados no tamanho da coluna,
 * no máximo DESCOBERTAS_MAX itens. Item inválido é ignorado (não derruba o heartbeat).
 */
export function normalizarDescobertas(lista: unknown): Descoberta[] {
  if (!Array.isArray(lista)) return [];
  const txt = (x: unknown, max: number) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, max) : null);
  const porta = (x: unknown) => (typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= 65535 ? x : null);
  const porIp = new Map<string, Descoberta>();
  for (const item of lista) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const ip = typeof o.ip === 'string' ? o.ip.trim() : '';
    if (!ipPrivadoOuLinkLocal(ip)) continue;
    const macBruto = typeof o.mac === 'string' ? o.mac.trim().toLowerCase() : '';
    porIp.set(ip, {
      ip,
      mac: MAC.test(macBruto) ? macBruto.replace(/-/g, ':') : null,
      fabricante: txt(o.fabricante, 40)?.toLowerCase() ?? null,
      modelo: txt(o.modelo, 80),
      serial: txt(o.serial, 80),
      porta_http: porta(o.porta_http),
      porta_rtsp: porta(o.porta_rtsp),
      inicializada: typeof o.inicializada === 'boolean' ? o.inicializada : null,
    });
  }
  return [...porIp.values()].slice(0, DESCOBERTAS_MAX);
}

/** Descobertas recentes (24 h) cujo IP ainda não é de câmera cadastrada na unidade. */
export function descobertasPendentes<T extends { ip: string; visto_em: Date }>(
  descobertas: T[],
  ipsCadastrados: Iterable<string>,
  agora = new Date(),
): T[] {
  const cadastrados = new Set([...ipsCadastrados].map((ip) => normalizarIp(ip)));
  const desde = agora.getTime() - DESCOBERTA_VALIDADE_S * 1000;
  return descobertas.filter((d) => d.visto_em.getTime() >= desde && !cadastrados.has(normalizarIp(d.ip)));
}

// ---------------------------------------------------------------------------
// NEXON-108 — Histórico gravado no aparelho (jsonb `cameras.gravacao`) e trechos
// ---------------------------------------------------------------------------

export const STREAMS_GRAVACAO = ['secundario', 'principal'] as const;
export type StreamGravacao = (typeof STREAMS_GRAVACAO)[number];

export interface GravacaoConfig {
  ativa: boolean;
  dias: number;
  stream: StreamGravacao;
}

export interface GravacaoStatus {
  ativa: boolean;
  de: string | null;
  ate: string | null;
  uso_gb: number | null;
  livre_gb: number | null;
  /** Quando o agente informou (heartbeat). */
  em: string | null;
}

export const GRAVACAO_CONFIG_PADRAO: GravacaoConfig = { ativa: true, dias: 7, stream: 'secundario' };
export const GRAVACAO_DIAS_MIN = 1;
export const GRAVACAO_DIAS_MAX = 30;

/** Trecho: duração aceita (s), pedidos abertos por câmera, prazo sem resposta, vida do arquivo. */
export const TRECHO_DURACAO_MIN_S = 10;
export const TRECHO_DURACAO_MAX_S = 300;
export const TRECHO_PENDENTES_MAX = 3;
export const TRECHO_EXPIRA_S = 180;
export const TRECHO_ARQUIVO_VIDA_S = 24 * 60 * 60;
/** nginx do servidor aceita 50M de corpo; 45 MB deixa folga para o multipart. */
export const TRECHO_ARQUIVO_MAX_MB = 45;
/** Marca gravada em `cameras_comandos.erro` quando o pedido expira (o CHECK de estado só tem pendente/entregue/ok/erro). */
export const ERRO_TRECHO_EXPIRADO = 'expirado';

const objeto = (v: unknown): Record<string, unknown> =>
  (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>;

export function normalizarGravacaoConfig(v: unknown): GravacaoConfig {
  const o = objeto(v);
  const dias = typeof o.dias === 'number' && Number.isFinite(o.dias) ? Math.round(o.dias) : GRAVACAO_CONFIG_PADRAO.dias;
  return {
    ativa: typeof o.ativa === 'boolean' ? o.ativa : GRAVACAO_CONFIG_PADRAO.ativa,
    dias: Math.min(GRAVACAO_DIAS_MAX, Math.max(GRAVACAO_DIAS_MIN, dias)),
    stream: (STREAMS_GRAVACAO as readonly unknown[]).includes(o.stream) ? (o.stream as StreamGravacao) : GRAVACAO_CONFIG_PADRAO.stream,
  };
}

/** Status vindo do heartbeat; data inválida vira null, número negativo/NaN vira null. */
export function normalizarGravacaoStatus(v: unknown, em?: Date | string | null): GravacaoStatus {
  const o = objeto(v);
  const data = (x: unknown) => {
    if (typeof x !== 'string' && !(x instanceof Date)) return null;
    const d = new Date(x);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  const gb = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.round(x * 10) / 10 : null);
  return {
    ativa: o.ativa === true,
    de: data(o.de),
    ate: data(o.ate),
    uso_gb: gb(o.uso_gb),
    livre_gb: gb(o.livre_gb),
    em: data(em !== undefined ? em : o.em),
  };
}

/** Lê a coluna inteira (`{ config, status }`). */
export function lerGravacao(v: unknown): { config: GravacaoConfig; status: GravacaoStatus | null } {
  const o = objeto(v);
  return {
    config: normalizarGravacaoConfig(o.config),
    status: o.status && typeof o.status === 'object' ? normalizarGravacaoStatus(o.status) : null,
  };
}

/**
 * Objeto `gravacao` das listas/detalhe: status do último heartbeat (ativa, de, ate, uso_gb,
 * livre_gb, em) + `config` (o que foi pedido ao agente).
 */
export function apresentarGravacao(v: unknown) {
  const { config, status } = lerGravacao(v);
  const s = status ?? { ativa: false, de: null, ate: null, uso_gb: null, livre_gb: null, em: null };
  return { ...s, config };
}

export type EstadoTrecho = 'pendente' | 'pronto' | 'erro' | 'expirado';

/**
 * Estado do pedido de trecho visto pelo usuário. Pendente (não entregue ou entregue sem resposta)
 * expira TRECHO_EXPIRA_S depois do último passo (criação ou entrega ao agente).
 * `ok` sem arquivo (já apagado pela limpeza de 24 h) também é expirado.
 */
export function estadoTrecho(
  c: { estado: string; erro: string | null; created_at: Date; entregue_em: Date | null },
  arquivoExiste: boolean,
  agora = new Date(),
): EstadoTrecho {
  if (c.estado === 'ok') return arquivoExiste ? 'pronto' : 'expirado';
  if (c.estado === 'erro') return c.erro === ERRO_TRECHO_EXPIRADO ? 'expirado' : 'erro';
  return trechoVencido(c, agora) ? 'expirado' : 'pendente';
}

export function trechoVencido(c: { created_at: Date; entregue_em: Date | null }, agora = new Date()): boolean {
  const base = (c.entregue_em ?? c.created_at).getTime();
  return agora.getTime() - base > TRECHO_EXPIRA_S * 1000;
}

/**
 * Nome do arquivo baixado: `portao_2026-11-16_14h32_pessoa.mp4` (hora de Brasília, sem acento nem espaço).
 */
export function nomeDownload(camera: string, quando: Date, sufixo: string, ext: 'mp4' | 'jpg'): string {
  const limpo = (v: string) =>
    v
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'camera';
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: FUSO,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(quando)
      .map((x) => [x.type, x.value]),
  );
  return `${limpo(camera)}_${p.year}-${p.month}-${p.day}_${p.hour}h${p.minute}_${limpo(sufixo)}.${ext}`;
}

/**
 * Senha forte para câmera cadastrada sozinha (regra Intelbras: 8–32, letras e números). 16 caracteres sem
 * símbolos que atrapalham URL RTSP; sempre com minúscula, maiúscula e número.
 */
export function gerarSenhaCamera(tamanho = 16): string {
  const grupos = ['abcdefghijkmnopqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789'];
  const todos = grupos.join('');
  const chars = grupos.map((g) => g[randomInt(g.length)]);
  while (chars.length < tamanho) chars.push(todos[randomInt(todos.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
