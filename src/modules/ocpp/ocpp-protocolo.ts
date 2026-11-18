/**
 * OCPP 1.6-J — camada PURA de protocolo (sem rede, sem banco), testada em
 * ocpp-protocolo.spec.ts.
 *
 * Fonte: especificação OCPP 1.6 e OCPP-J 1.6 (Open Charge Alliance). É o protocolo que o
 * manual do Chint Wallbox declara (p. 14, seção 5.2; p. 23, "OCPP 1.6"); o manual não lista
 * mensagens nem chaves, então nada aqui é específico do fabricante.
 *
 * Quadro OCPP-J: array JSON `[tipo, id, ...]`
 *   CALL       [2, id, ação, payload]
 *   CALLRESULT [3, id, payload]
 *   CALLERROR  [4, id, código, descrição, detalhes]
 */
export const SUBPROTOCOLO = 'ocpp1.6';
export const TIPO_CALL = 2;
export const TIPO_RESULTADO = 3;
export const TIPO_ERRO = 4;

export type CodigoErroOcpp =
  | 'NotImplemented'
  | 'NotSupported'
  | 'InternalError'
  | 'ProtocolError'
  | 'SecurityError'
  | 'FormationViolation'
  | 'PropertyConstraintViolation'
  | 'OccurenceConstraintViolation' // grafia da especificação
  | 'TypeConstraintViolation'
  | 'GenericError';

export const STATUS_CONECTOR = [
  'Available', 'Preparing', 'Charging', 'SuspendedEVSE', 'SuspendedEV', 'Finishing', 'Reserved', 'Unavailable', 'Faulted',
] as const;
export type StatusConector = (typeof STATUS_CONECTOR)[number];

export const ERROS_CONECTOR = [
  'ConnectorLockFailure', 'EVCommunicationError', 'GroundFailure', 'HighTemperature', 'InternalError', 'LocalListConflict',
  'NoError', 'OtherError', 'OverCurrentFailure', 'OverVoltage', 'PowerMeterFailure', 'PowerSwitchFailure', 'ReaderFailure',
  'ResetFailure', 'UnderVoltage', 'WeakSignal',
] as const;

export const MOTIVOS_PARADA = [
  'EmergencyStop', 'EVDisconnected', 'HardReset', 'Local', 'Other', 'PowerLoss', 'Reboot', 'Remote', 'SoftReset',
  'UnlockCommand', 'DeAuthorized',
] as const;

export type StatusAutorizacao = 'Accepted' | 'Blocked' | 'Expired' | 'Invalid' | 'ConcurrentTx';
export interface IdTagInfo { status: StatusAutorizacao; expiryDate?: string; parentIdTag?: string }

/** idTag é CiString20: mais que isso o carregador nem consegue mandar de volta. */
export const ID_TAG_MAX = 20;

// ---------------------------------------------------------------------------
// Quadros
// ---------------------------------------------------------------------------
export type Quadro =
  | { tipo: 'call'; id: string; acao: string; payload: Record<string, unknown> }
  | { tipo: 'resultado'; id: string; payload: Record<string, unknown> }
  | { tipo: 'erro'; id: string; codigo: string; descricao: string; detalhes: Record<string, unknown> }
  | { tipo: 'invalido'; id: string | null; codigo: CodigoErroOcpp; descricao: string };

const ehObjeto = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function idDoQuadro(v: unknown): string | null {
  if (typeof v === 'string' && v.length > 0 && v.length <= 64) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** Interpreta um quadro recebido. Nunca lança: o que não dá para ler vira `invalido`. */
export function lerQuadro(bruto: string): Quadro {
  let f: unknown;
  try {
    f = JSON.parse(bruto);
  } catch {
    return { tipo: 'invalido', id: null, codigo: 'FormationViolation', descricao: 'Quadro não é JSON' };
  }
  if (!Array.isArray(f) || f.length < 2) {
    return { tipo: 'invalido', id: null, codigo: 'FormationViolation', descricao: 'Quadro não é um array OCPP-J' };
  }
  const id = idDoQuadro(f[1]);
  if (id === null) return { tipo: 'invalido', id: null, codigo: 'FormationViolation', descricao: 'Identificador do quadro inválido' };
  const tipo = f[0];
  if (tipo === TIPO_CALL) {
    if (typeof f[2] !== 'string' || !f[2]) return { tipo: 'invalido', id, codigo: 'FormationViolation', descricao: 'CALL sem ação' };
    const payload = f[3] === undefined || f[3] === null ? {} : f[3];
    if (!ehObjeto(payload)) return { tipo: 'invalido', id, codigo: 'FormationViolation', descricao: 'Payload não é um objeto' };
    return { tipo: 'call', id, acao: f[2], payload };
  }
  if (tipo === TIPO_RESULTADO) {
    return { tipo: 'resultado', id, payload: ehObjeto(f[2]) ? f[2] : {} };
  }
  if (tipo === TIPO_ERRO) {
    return {
      tipo: 'erro', id,
      codigo: typeof f[2] === 'string' ? f[2] : 'GenericError',
      descricao: typeof f[3] === 'string' ? f[3] : '',
      detalhes: ehObjeto(f[4]) ? f[4] : {},
    };
  }
  return { tipo: 'invalido', id, codigo: 'ProtocolError', descricao: `Tipo de mensagem desconhecido: ${String(tipo)}` };
}

export const montarCall = (id: string, acao: string, payload: Record<string, unknown>): string =>
  JSON.stringify([TIPO_CALL, id, acao, payload]);
export const montarResultado = (id: string, payload: Record<string, unknown>): string =>
  JSON.stringify([TIPO_RESULTADO, id, payload]);
export const montarErro = (id: string, codigo: CodigoErroOcpp, descricao: string, detalhes: Record<string, unknown> = {}): string =>
  JSON.stringify([TIPO_ERRO, id, codigo, descricao.slice(0, 255), detalhes]);

// ---------------------------------------------------------------------------
// Mensagens do carregador → central (validação e normalização)
// ---------------------------------------------------------------------------
export class ErroPayload extends Error {
  constructor(readonly codigo: CodigoErroOcpp, mensagem: string) {
    super(mensagem);
  }
}

type TipoCampo = 'texto' | 'inteiro' | 'data' | 'lista';
interface Campo {
  nome: string;
  tipo: TipoCampo;
  obrigatorio?: boolean;
  /** Tamanho máximo (texto). `corta` = descritivo: trunca em vez de recusar. */
  max?: number;
  corta?: boolean;
  /**
   * Registrador de energia (Wh): aceita fração e valor fora do inteiro de 32 bits,
   * arredondando e limitando. Recusar faria o carregador reenviar a transação para sempre.
   */
  registrador?: boolean;
}

const INT32_MAX = 2_147_483_647;

/**
 * Campos que a central usa de cada mensagem (esquemas JSON do OCPP 1.6). Obrigatório
 * ausente ou de tipo errado → CALLERROR; texto descritivo longo é truncado; data inválida
 * vira `null` (quem usa põe a hora do servidor: recusar a transação por causa do relógio
 * do carregador deixaria a recarga sem registro).
 */
const ENTRADA: Record<string, Campo[]> = {
  BootNotification: [
    { nome: 'chargePointVendor', tipo: 'texto', obrigatorio: true, max: 80, corta: true },
    { nome: 'chargePointModel', tipo: 'texto', obrigatorio: true, max: 80, corta: true },
    { nome: 'chargePointSerialNumber', tipo: 'texto', max: 80, corta: true },
    { nome: 'chargeBoxSerialNumber', tipo: 'texto', max: 80, corta: true },
    { nome: 'firmwareVersion', tipo: 'texto', max: 80, corta: true },
    { nome: 'iccid', tipo: 'texto', max: 40, corta: true },
    { nome: 'imsi', tipo: 'texto', max: 40, corta: true },
    { nome: 'meterType', tipo: 'texto', max: 40, corta: true },
    { nome: 'meterSerialNumber', tipo: 'texto', max: 40, corta: true },
  ],
  Heartbeat: [],
  StatusNotification: [
    { nome: 'connectorId', tipo: 'inteiro', obrigatorio: true },
    { nome: 'errorCode', tipo: 'texto', obrigatorio: true, max: 40, corta: true },
    { nome: 'status', tipo: 'texto', obrigatorio: true, max: 24, corta: true },
    { nome: 'info', tipo: 'texto', max: 120, corta: true },
    { nome: 'timestamp', tipo: 'data' },
    { nome: 'vendorId', tipo: 'texto', max: 255, corta: true },
    { nome: 'vendorErrorCode', tipo: 'texto', max: 60, corta: true },
  ],
  Authorize: [{ nome: 'idTag', tipo: 'texto', obrigatorio: true, max: ID_TAG_MAX }],
  StartTransaction: [
    { nome: 'connectorId', tipo: 'inteiro', obrigatorio: true },
    { nome: 'idTag', tipo: 'texto', obrigatorio: true, max: ID_TAG_MAX },
    { nome: 'meterStart', tipo: 'inteiro', obrigatorio: true, registrador: true },
    { nome: 'timestamp', tipo: 'data' },
    { nome: 'reservationId', tipo: 'inteiro' },
  ],
  StopTransaction: [
    { nome: 'transactionId', tipo: 'inteiro', obrigatorio: true },
    { nome: 'meterStop', tipo: 'inteiro', obrigatorio: true, registrador: true },
    { nome: 'timestamp', tipo: 'data' },
    { nome: 'idTag', tipo: 'texto', max: ID_TAG_MAX, corta: true },
    { nome: 'reason', tipo: 'texto', max: 32, corta: true },
    { nome: 'transactionData', tipo: 'lista' },
  ],
  MeterValues: [
    { nome: 'connectorId', tipo: 'inteiro', obrigatorio: true },
    { nome: 'transactionId', tipo: 'inteiro' },
    { nome: 'meterValue', tipo: 'lista', obrigatorio: true },
  ],
  DataTransfer: [
    { nome: 'vendorId', tipo: 'texto', obrigatorio: true, max: 255, corta: true },
    { nome: 'messageId', tipo: 'texto', max: 50, corta: true },
  ],
  FirmwareStatusNotification: [{ nome: 'status', tipo: 'texto', obrigatorio: true, max: 40, corta: true }],
  DiagnosticsStatusNotification: [{ nome: 'status', tipo: 'texto', obrigatorio: true, max: 40, corta: true }],
};

export const ACOES_ENTRADA = Object.keys(ENTRADA);

/** Data ISO 8601 do carregador; inválida ou ausente → null. */
export function lerData(v: unknown): Date | null {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Valida e normaliza o payload de uma mensagem do carregador. Lança `ErroPayload` com o
 * código OCPP certo (NotImplemented, OccurenceConstraintViolation, TypeConstraintViolation,
 * PropertyConstraintViolation). Campo fora do esquema é ignorado.
 */
export function validarEntrada(acao: string, payload: unknown): Record<string, any> {
  const campos = ENTRADA[acao];
  if (!campos) throw new ErroPayload('NotImplemented', `Ação não tratada: ${acao}`);
  if (!ehObjeto(payload)) throw new ErroPayload('FormationViolation', 'Payload não é um objeto');
  const out: Record<string, any> = {};
  for (const c of campos) {
    const v = payload[c.nome];
    const ausente = v === undefined || v === null || v === '';
    if (ausente) {
      if (c.obrigatorio) throw new ErroPayload('OccurenceConstraintViolation', `Campo obrigatório ausente: ${c.nome}`);
      if (c.tipo === 'data') out[c.nome] = null;
      continue;
    }
    if (c.tipo === 'texto') {
      if (typeof v !== 'string' && typeof v !== 'number') throw new ErroPayload('TypeConstraintViolation', `Campo ${c.nome} não é texto`);
      let s = String(v).trim();
      if (!s && c.obrigatorio) throw new ErroPayload('OccurenceConstraintViolation', `Campo obrigatório vazio: ${c.nome}`);
      if (c.max && s.length > c.max) {
        if (!c.corta) throw new ErroPayload('PropertyConstraintViolation', `Campo ${c.nome} passa de ${c.max} caracteres`);
        s = s.slice(0, c.max);
      }
      out[c.nome] = s;
    } else if (c.tipo === 'inteiro') {
      if (c.registrador) {
        const r = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
        if (!Number.isFinite(r)) throw new ErroPayload('TypeConstraintViolation', `Campo ${c.nome} não é número`);
        out[c.nome] = Math.min(Math.max(Math.round(r), 0), INT32_MAX);
        continue;
      }
      const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : NaN;
      if (!Number.isInteger(n)) throw new ErroPayload('TypeConstraintViolation', `Campo ${c.nome} não é inteiro`);
      out[c.nome] = n;
    } else if (c.tipo === 'data') {
      out[c.nome] = lerData(v);
    } else {
      if (!Array.isArray(v)) throw new ErroPayload('TypeConstraintViolation', `Campo ${c.nome} não é lista`);
      out[c.nome] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// MeterValues
// ---------------------------------------------------------------------------
export interface Medicao {
  /** Hora da amostra no relógio do carregador; null = não veio ou inválida. */
  ts: Date | null;
  /** readingContext (Sample.Periodic, Transaction.Begin, Trigger...). */
  contexto: string;
  /** Energy.Active.Import.Register em Wh (registrador acumulado). */
  energiaWh: number | null;
  /** Power.Active.Import em W (soma das fases quando vem por fase). */
  potenciaW: number | null;
  /** Current.Import em A (a maior entre as fases quando vem por fase). */
  correnteA: number | null;
  /** Voltage em V (média das fases informadas). */
  tensaoV: number | null;
  temperaturaC: number | null;
  /** SoC em % (só carregador que conversa com o carro; CA Modo 3 em geral não manda). */
  soc: number | null;
  /** Current.Offered em A (o que o carregador está oferecendo ao carro). */
  correnteOfertadaA: number | null;
  fases: { corrente: Record<string, number>; tensao: Record<string, number>; potencia: Record<string, number> };
}

const emWh = (v: number, unidade?: string) => (unidade === 'kWh' ? v * 1000 : v);
const emW = (v: number, unidade?: string) => (unidade === 'kW' ? v * 1000 : v);
function emCelsius(v: number, unidade?: string): number {
  if (unidade === 'Fahrenheit') return ((v - 32) * 5) / 9;
  if (unidade === 'K') return v - 273.15;
  return v;
}
const arred = (v: number, casas: number) => Math.round(v * 10 ** casas) / 10 ** casas;

interface Amostra { total: number | null; fases: Record<string, number>; outlet: Set<string> }
const amostraVazia = (): Amostra => ({ total: null, fases: {}, outlet: new Set() });

/**
 * Lê `meterValue[]` de MeterValues (ou `transactionData[]` do StopTransaction).
 * Regras da especificação: `measurand` ausente = Energy.Active.Import.Register; unidade
 * ausente = Wh / W / A / V / Celsius; `format: SignedData` não é número e fica de fora;
 * quando a mesma grandeza vem de dois pontos de medição, vale a do `Outlet` (padrão).
 */
export function lerMedicoes(meterValue: unknown): Medicao[] {
  if (!Array.isArray(meterValue)) return [];
  const out: Medicao[] = [];
  for (const mv of meterValue) {
    if (!ehObjeto(mv) || !Array.isArray(mv.sampledValue)) continue;
    const grandezas = new Map<string, Amostra>();
    let contexto = 'Sample.Periodic';
    for (const sv of mv.sampledValue) {
      if (!ehObjeto(sv) || sv.format === 'SignedData') continue;
      const valor = Number(sv.value);
      if (sv.value === '' || sv.value === null || !Number.isFinite(valor)) continue;
      const measurand = typeof sv.measurand === 'string' && sv.measurand ? sv.measurand : 'Energy.Active.Import.Register';
      const unidade = typeof sv.unit === 'string' ? sv.unit : undefined;
      const fase = typeof sv.phase === 'string' && sv.phase ? sv.phase : null;
      const noOutlet = sv.location === undefined || sv.location === null || sv.location === 'Outlet';
      if (typeof sv.context === 'string' && sv.context) contexto = sv.context;
      let v = valor;
      if (measurand.startsWith('Energy.')) v = emWh(valor, unidade);
      else if (measurand.startsWith('Power.') && measurand !== 'Power.Factor') v = emW(valor, unidade);
      else if (measurand === 'Temperature') v = emCelsius(valor, unidade);
      const a = grandezas.get(measurand) ?? amostraVazia();
      const chave = fase ?? '';
      // Mesma grandeza e fase de dois pontos: a do Outlet não é sobrescrita por outra.
      if (a.outlet.has(chave) && !noOutlet) continue;
      if (noOutlet) a.outlet.add(chave);
      if (fase) a.fases[fase] = v;
      else a.total = v;
      grandezas.set(measurand, a);
    }
    const soma = (a?: Amostra) => {
      if (!a) return null;
      if (a.total !== null) return a.total;
      const vs = Object.values(a.fases);
      return vs.length ? vs.reduce((s, x) => s + x, 0) : null;
    };
    const maior = (a?: Amostra) => {
      if (!a) return null;
      if (a.total !== null) return a.total;
      const vs = Object.values(a.fases);
      return vs.length ? Math.max(...vs) : null;
    };
    const media = (a?: Amostra) => {
      if (!a) return null;
      if (a.total !== null) return a.total;
      // Fase-neutro quando houver; senão o que veio (fase-fase).
      const fn = Object.entries(a.fases).filter(([f]) => /^L\d(-N)?$/.test(f)).map(([, x]) => x);
      const vs = fn.length ? fn : Object.values(a.fases);
      return vs.length ? vs.reduce((s, x) => s + x, 0) / vs.length : null;
    };
    const energia = soma(grandezas.get('Energy.Active.Import.Register'));
    const potencia = soma(grandezas.get('Power.Active.Import'));
    const corrente = maior(grandezas.get('Current.Import'));
    const tensao = media(grandezas.get('Voltage'));
    const temperatura = maior(grandezas.get('Temperature'));
    const soc = grandezas.get('SoC')?.total ?? null;
    const ofertada = maior(grandezas.get('Current.Offered'));
    out.push({
      ts: lerData(mv.timestamp),
      contexto,
      energiaWh: energia === null ? null : arred(energia, 1),
      potenciaW: potencia === null ? null : arred(potencia, 1),
      correnteA: corrente === null ? null : arred(corrente, 2),
      tensaoV: tensao === null ? null : arred(tensao, 1),
      temperaturaC: temperatura === null ? null : arred(temperatura, 1),
      soc: soc !== null && soc >= 0 && soc <= 100 ? arred(soc, 1) : null,
      correnteOfertadaA: ofertada === null ? null : arred(ofertada, 2),
      fases: {
        corrente: { ...(grandezas.get('Current.Import')?.fases ?? {}) },
        tensao: { ...(grandezas.get('Voltage')?.fases ?? {}) },
        potencia: { ...(grandezas.get('Power.Active.Import')?.fases ?? {}) },
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mensagens da central → carregador (montagem)
// ---------------------------------------------------------------------------
export interface Chamada { acao: string; payload: Record<string, unknown> }

const inteiroPositivo = (v: unknown, nome: string): number => {
  if (!Number.isInteger(v) || (v as number) < 0) throw new Error(`${nome} inválido`);
  return v as number;
};

export function iniciarRemoto(idTag: string, connectorId?: number): Chamada {
  const tag = String(idTag ?? '').trim();
  if (!tag || tag.length > ID_TAG_MAX) throw new Error(`idTag deve ter de 1 a ${ID_TAG_MAX} caracteres`);
  return {
    acao: 'RemoteStartTransaction',
    payload: { idTag: tag, ...(connectorId ? { connectorId: inteiroPositivo(connectorId, 'connectorId') } : {}) },
  };
}

export function pararRemoto(transactionId: number): Chamada {
  return { acao: 'RemoteStopTransaction', payload: { transactionId: inteiroPositivo(transactionId, 'transactionId') } };
}

export function reiniciar(tipo: 'Soft' | 'Hard' = 'Soft'): Chamada {
  return { acao: 'Reset', payload: { type: tipo === 'Hard' ? 'Hard' : 'Soft' } };
}

export function mudarDisponibilidade(connectorId: number, tipo: 'Operative' | 'Inoperative'): Chamada {
  return { acao: 'ChangeAvailability', payload: { connectorId: inteiroPositivo(connectorId, 'connectorId'), type: tipo } };
}

export function destravarConector(connectorId: number): Chamada {
  const c = inteiroPositivo(connectorId, 'connectorId');
  if (c < 1) throw new Error('connectorId deve ser 1 ou maior');
  return { acao: 'UnlockConnector', payload: { connectorId: c } };
}

export function lerConfiguracao(chaves?: string[]): Chamada {
  return { acao: 'GetConfiguration', payload: chaves?.length ? { key: chaves.map((k) => String(k).slice(0, 50)) } : {} };
}

export function mudarConfiguracao(chave: string, valor: string): Chamada {
  const k = String(chave ?? '').trim();
  if (!k || k.length > 50) throw new Error('Chave de configuração deve ter de 1 a 50 caracteres');
  const v = String(valor ?? '');
  if (v.length > 500) throw new Error('Valor de configuração passa de 500 caracteres');
  return { acao: 'ChangeConfiguration', payload: { key: k, value: v } };
}

export type MensagemPedida = 'BootNotification' | 'Heartbeat' | 'MeterValues' | 'StatusNotification';
export function pedirMensagem(mensagem: MensagemPedida, connectorId?: number): Chamada {
  return {
    acao: 'TriggerMessage',
    payload: { requestedMessage: mensagem, ...(connectorId ? { connectorId: inteiroPositivo(connectorId, 'connectorId') } : {}) },
  };
}

/** Faixa de corrente de um ponto CA Modo 3 (IEC 61851-1): abaixo de 6 A o carro não carrega. */
export const CORRENTE_MIN_A = 6;
/** Identificador fixo do perfil que o NexON instala: gravar de novo substitui o anterior. */
export const PERFIL_CORRENTE_ID = 130;

export type PropositoPerfil = 'TxDefaultProfile' | 'ChargePointMaxProfile';

/**
 * SetChargingProfile com um único período, sem fim: corrente máxima em ampères.
 * `TxDefaultProfile` vale para toda recarga do conector; `ChargePointMaxProfile` limita a
 * estação inteira (conector 0) e é a segunda tentativa quando o carregador recusa a primeira.
 */
export function perfilCorrenteMaxima(p: { conector: number; limiteA: number; proposito?: PropositoPerfil; inicio?: Date }): Chamada {
  const limite = Number(p.limiteA);
  if (!Number.isFinite(limite) || limite < CORRENTE_MIN_A) throw new Error(`Corrente deve ser de ${CORRENTE_MIN_A} A ou mais`);
  const proposito = p.proposito ?? 'TxDefaultProfile';
  return {
    acao: 'SetChargingProfile',
    payload: {
      connectorId: proposito === 'ChargePointMaxProfile' ? 0 : inteiroPositivo(p.conector, 'connectorId'),
      csChargingProfiles: {
        chargingProfileId: PERFIL_CORRENTE_ID,
        stackLevel: 0,
        chargingProfilePurpose: proposito,
        chargingProfileKind: 'Absolute',
        chargingSchedule: {
          startSchedule: (p.inicio ?? new Date()).toISOString(),
          chargingRateUnit: 'A',
          chargingSchedulePeriod: [{ startPeriod: 0, limit: arred(limite, 1) }],
        },
      },
    },
  };
}

export function limparPerfilCorrente(): Chamada {
  return { acao: 'ClearChargingProfile', payload: { id: PERFIL_CORRENTE_ID } };
}

// ---------------------------------------------------------------------------
// Respostas do carregador
// ---------------------------------------------------------------------------
/** `status` de uma resposta (Accepted, Rejected, NotSupported...). Ausente → ''. */
export const statusDa = (resposta: unknown): string =>
  ehObjeto(resposta) && typeof resposta.status === 'string' ? resposta.status : '';

export interface ParametroOcpp { chave: string; valor: string | null; somente_leitura: boolean }

/** GetConfiguration.conf → lista ordenada + chaves que o carregador não conhece. */
export function lerParametros(resposta: unknown): { parametros: ParametroOcpp[]; desconhecidas: string[] } {
  const r = ehObjeto(resposta) ? resposta : {};
  const parametros: ParametroOcpp[] = [];
  for (const k of Array.isArray(r.configurationKey) ? r.configurationKey : []) {
    if (!ehObjeto(k) || typeof k.key !== 'string') continue;
    parametros.push({
      chave: k.key,
      valor: k.value === undefined || k.value === null ? null : String(k.value),
      somente_leitura: k.readonly === true,
    });
  }
  parametros.sort((a, b) => a.chave.localeCompare(b.chave));
  const desconhecidas = (Array.isArray(r.unknownKey) ? r.unknownKey : []).filter((x): x is string => typeof x === 'string');
  return { parametros, desconhecidas };
}

/** `SupportedFeatureProfiles` ("Core,SmartCharging,RemoteTrigger") → lista. */
export function lerPerfis(parametros: ParametroOcpp[]): string[] {
  const p = parametros.find((x) => x.chave.toLowerCase() === 'supportedfeatureprofiles');
  return (p?.valor ?? '').split(',').map((x) => x.trim()).filter(Boolean);
}
