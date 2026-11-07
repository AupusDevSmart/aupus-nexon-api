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
  clipe_s: number;
  zonas: unknown[];
}

export const ANALISE_PADRAO: Analise = {
  ativa: true,
  sensibilidade: 50,
  area_minima_pct: 0.5,
  fps_analise: 4,
  classificar: true,
  classes_alerta: ['pessoa', 'veiculo'],
  clipe_s: 12,
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

  if ((TIPOS_DETECCAO as readonly string[]).includes(tipo)) {
    if (!armado) {
      descartado = true;
      motivo = 'desarmado';
    } else if (!a.classes_alerta.includes(tipo)) {
      descartado = true;
      motivo = 'classe_ignorada';
    } else {
      alerta = true;
    }
  } else if (tipo === 'sem_sinal') {
    alerta = true;
  }

  const enviar_clipe = alerta && (TIPOS_DETECCAO as readonly string[]).includes(tipo) && a.clipe_s > 0;
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

/** URL RTSP com usuário e senha codificados. subtype 0 = principal, 1 = secundário (Intelbras/Dahua). */
export function montarRtsp(c: CameraRtsp, senha: string, subtype: 0 | 1): string {
  const cred = `${encodeURIComponent(c.usuario)}:${encodeURIComponent(senha)}`;
  const host = c.ip.includes(':') && !c.ip.startsWith('[') ? `[${c.ip}]` : c.ip;
  const canal = Math.max(1, c.canal || 1);
  if ((c.fabricante ?? '').toLowerCase() === 'hikvision') {
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
