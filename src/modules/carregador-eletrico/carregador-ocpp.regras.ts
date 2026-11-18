import { randomBytes } from 'crypto';
import { CORRENTE_MIN_A, ID_TAG_MAX } from '../ocpp/ocpp-protocolo';
import type { PapelCarregador } from './carregador.util';

/**
 * Regras do carregador ligado por OCPP — lógica PURA, testada em carregador-ocpp.regras.spec.ts.
 * O que vem do equipamento está em NexON/docs/carregador/LEVANTAMENTO-CHINT-WALLBOX.md
 * (manual "Chint Type 2 7-22kW Wallbox", ed. 06, e datasheet Wallbox AC PRO).
 */

// ---- estado -----------------------------------------------------------------
export type EstadoCarregador =
  | 'disponivel' | 'conectado' | 'carregando' | 'pausado' | 'finalizando' | 'reservado'
  | 'indisponivel' | 'falha' | 'sem_comunicacao' | 'desconhecido';

/** ChargePointStatus do OCPP 1.6 → estado da tela (cabe em `ultimo_estado varchar(16)`). */
export function estadoDoStatus(status: string | null | undefined): EstadoCarregador {
  switch (status) {
    case 'Available': return 'disponivel';
    case 'Preparing': return 'conectado';
    case 'Charging': return 'carregando';
    case 'SuspendedEV':
    case 'SuspendedEVSE': return 'pausado';
    case 'Finishing': return 'finalizando';
    case 'Reserved': return 'reservado';
    case 'Unavailable': return 'indisponivel';
    case 'Faulted': return 'falha';
    default: return 'desconhecido';
  }
}

// ---- falhas -----------------------------------------------------------------
export interface Falha {
  /** Código do manual do fabricante (E01...), quando o carregador o informa. */
  codigo: string | null;
  /** errorCode do OCPP. */
  ocpp: string;
  titulo: string;
  solucao: string | null;
  severidade: 'BAIXA' | 'ALTA' | 'CRITICA';
}

const POS_VENDA = 'Entrar em contato com o pós-venda da CHINT.';
const INSTALACAO = 'Verificar se a instalação está dentro do padrão, com os dispositivos de proteção adequados.';
const CONECTOR = 'Verificar a conexão com o carro e se há água, sujeira ou oxidação nos conectores; conferir danos em cabos e conectores.';
const TENSAO = 'Verificar se a tensão da rede está dentro dos parâmetros do carregador e se as conexões estão bem fixas.';
const SURTO = 'Verificar a instalação e se houve descarga atmosférica ou variação brusca de energia; persistindo, pós-venda da CHINT.';

/** Tabela "Código de erro" do manual do Chint Wallbox (seção 8, p. 25–26). */
export const ALARMES_CHINT: Record<string, { titulo: string; solucao: string; critica?: boolean }> = {
  E01: { titulo: 'Falha de aterramento', solucao: INSTALACAO, critica: true },
  E02: { titulo: 'Proteção contra corrente de fuga', solucao: CONECTOR, critica: true },
  E03: { titulo: 'Sobretensão de entrada', solucao: TENSAO },
  E04: { titulo: 'Subtensão de entrada', solucao: TENSAO },
  E05: { titulo: 'Proteção contra sobrecorrente', solucao: TENSAO, critica: true },
  E06: { titulo: 'Acoplador de carga (CP) anormal', solucao: CONECTOR },
  E07: { titulo: 'Botão de parada de emergência pressionado', solucao: 'Girar o botão de emergência no sentido indicado para liberar.', critica: true },
  E08: { titulo: 'Mecanismo de travamento do acoplador anormal', solucao: CONECTOR },
  E09: { titulo: 'Conexão invertida da polaridade linha-neutro', solucao: INSTALACAO },
  E10: { titulo: 'Falha no sensor de temperatura 1', solucao: POS_VENDA },
  E11: { titulo: 'Falha no sensor de temperatura 2', solucao: POS_VENDA },
  E12: { titulo: 'Falha no sensor de temperatura 3', solucao: POS_VENDA },
  E13: { titulo: 'Temperatura do carregador muito alta', solucao: 'Verificar a instalação e se a temperatura ambiente está dentro dos parâmetros do carregador.' },
  E14: { titulo: 'Falha na calibração do protetor de vazamento', solucao: CONECTOR },
  E20: { titulo: 'Circuito aberto do relé', solucao: SURTO },
  E21: { titulo: 'Aderência do relé (relé colado)', solucao: SURTO, critica: true },
  E22: { titulo: 'Temperatura excessiva do relé', solucao: SURTO },
  E30: { titulo: 'Falha de memória (EEPROM)', solucao: POS_VENDA },
  E31: { titulo: 'Falha de comunicação do MCB (disjuntor miniatura)', solucao: POS_VENDA },
};

/** ChargePointErrorCode do OCPP 1.6 em português (o que todo carregador OCPP informa). */
const ERROS_OCPP: Record<string, { titulo: string; critica?: boolean; baixa?: boolean }> = {
  ConnectorLockFailure: { titulo: 'Falha na trava do conector' },
  EVCommunicationError: { titulo: 'Falha de comunicação com o veículo' },
  GroundFailure: { titulo: 'Falha de aterramento', critica: true },
  HighTemperature: { titulo: 'Temperatura alta no carregador' },
  InternalError: { titulo: 'Erro interno do carregador' },
  LocalListConflict: { titulo: 'Conflito na lista local de cartões', baixa: true },
  OtherError: { titulo: 'Falha no carregador' },
  OverCurrentFailure: { titulo: 'Sobrecorrente', critica: true },
  OverVoltage: { titulo: 'Sobretensão' },
  PowerMeterFailure: { titulo: 'Falha no medidor de energia' },
  PowerSwitchFailure: { titulo: 'Falha no contator' },
  ReaderFailure: { titulo: 'Falha no leitor de cartão', baixa: true },
  ResetFailure: { titulo: 'Falha ao reiniciar', baixa: true },
  UnderVoltage: { titulo: 'Subtensão' },
  WeakSignal: { titulo: 'Sinal fraco da rede', baixa: true },
};

/** Código do manual dentro de `vendorErrorCode` ou `info` ("E07", "e7", "Error E07"). */
export function codigoDoFabricante(...textos: Array<string | null | undefined>): string | null {
  for (const t of textos) {
    const m = /(?:^|[^A-Za-z0-9])E\s?(\d{1,2})(?![0-9])/i.exec(` ${t ?? ''}`);
    if (!m) continue;
    const cod = `E${m[1].padStart(2, '0')}`;
    if (ALARMES_CHINT[cod]) return cod;
  }
  return null;
}

/**
 * StatusNotification → falha para a tela, ou null. Há falha quando o conector está
 * `Faulted` ou quando `errorCode` não é `NoError`. O texto vem do manual quando o
 * carregador manda o código dele; senão, do errorCode padrão.
 */
export function descreverFalha(p: { status?: string | null; errorCode?: string | null; vendorErrorCode?: string | null; info?: string | null }): Falha | null {
  const ocpp = p.errorCode && p.errorCode !== 'NoError' ? p.errorCode : null;
  if (!ocpp && p.status !== 'Faulted') return null;
  const codigo = codigoDoFabricante(p.vendorErrorCode, p.info);
  const doManual = codigo ? ALARMES_CHINT[codigo] : null;
  const padrao = ocpp ? ERROS_OCPP[ocpp] : null;
  return {
    codigo,
    ocpp: ocpp ?? 'OtherError',
    titulo: doManual?.titulo ?? padrao?.titulo ?? 'Falha no carregador',
    solucao: doManual?.solucao ?? null,
    severidade: doManual?.critica || padrao?.critica ? 'CRITICA' : !doManual && padrao?.baixa ? 'BAIXA' : 'ALTA',
  };
}

/** Identifica a falha para saber se mudou (abre/normaliza o alarme só na troca). */
export const chaveDaFalha = (f: Falha | null): string | null => (f ? `${f.ocpp}|${f.codigo ?? ''}` : null);

// ---- fim da recarga ---------------------------------------------------------
export type MotivoFim =
  | 'limite_tempo' | 'limite_energia' | 'parado_no_nexon' | 'desconectado' | 'parado_no_carregador' | 'emergencia'
  | 'queda_energia' | 'reinicio' | 'cartao_recusado' | 'destravado' | 'sem_confirmacao' | 'outro';

const TEXTO_MOTIVO: Record<string, string> = {
  limite_tempo: 'Limite de tempo',
  limite_energia: 'Limite de energia',
  parado_no_nexon: 'Parada pelo NexON',
  desconectado: 'Carro desconectado',
  parado_no_carregador: 'Parada no carregador',
  emergencia: 'Botão de emergência',
  queda_energia: 'Queda de energia',
  reinicio: 'Carregador reiniciou',
  cartao_recusado: 'Cartão recusado',
  destravado: 'Conector destravado',
  sem_confirmacao: 'Sem confirmação do carregador',
  outro: 'Outro motivo',
};

export const textoMotivoFim = (motivo: string | null | undefined): string | null =>
  motivo ? TEXTO_MOTIVO[motivo] ?? null : null;

/** `reason` do StopTransaction (OCPP 1.6) → motivo da recarga. */
export function motivoDoOcpp(reason: string | null | undefined): MotivoFim {
  switch (reason) {
    case 'EmergencyStop': return 'emergencia';
    case 'EVDisconnected': return 'desconectado';
    case 'HardReset':
    case 'SoftReset':
    case 'Reboot': return 'reinicio';
    case 'PowerLoss': return 'queda_energia';
    case 'Remote': return 'parado_no_nexon';
    case 'UnlockCommand': return 'destravado';
    case 'DeAuthorized': return 'cartao_recusado';
    case 'Local':
    case undefined:
    case null:
    case '': return 'parado_no_carregador';
    default: return 'outro';
  }
}

/**
 * Motivo que fica na recarga. O que o NexON pediu (limite, parar na tela) só vale quando o
 * carregador confirma que parou por comando remoto; se parou por outra razão, vale a dele.
 */
export function motivoFinal(pedidoNexon: string | null | undefined, reason: string | null | undefined): MotivoFim {
  const doCarregador = motivoDoOcpp(reason);
  return pedidoNexon && doCarregador === 'parado_no_nexon' ? (pedidoNexon as MotivoFim) : doCarregador;
}

// ---- limites ----------------------------------------------------------------
export const LIMITE_TEMPO_MIN = 5;
export const LIMITE_TEMPO_MAX = 1440;
export const LIMITE_ENERGIA_MIN = 1;
export const LIMITE_ENERGIA_MAX = 200;
/** Corrente nominal do Wallbox (etiqueta e manual, p. 23): teto quando o cadastro não diz outro. */
export const CORRENTE_MAX_PADRAO_A = 32;

const vazio = (v: unknown) => v === null || v === undefined || v === '';
const numero = (v: unknown) => Number(String(v).replace(',', '.'));

/** Limite de tempo em minutos: null = sem limite; inválido → undefined. */
export function limiteTempoDe(v: unknown): number | null | undefined {
  if (vazio(v)) return null;
  const n = numero(v);
  return Number.isInteger(n) && n >= LIMITE_TEMPO_MIN && n <= LIMITE_TEMPO_MAX ? n : undefined;
}

/** Limite de energia em kWh (2 casas): null = sem limite; inválido → undefined. */
export function limiteEnergiaDe(v: unknown): number | null | undefined {
  if (vazio(v)) return null;
  const n = numero(v);
  if (!Number.isFinite(n) || n < LIMITE_ENERGIA_MIN || n > LIMITE_ENERGIA_MAX) return undefined;
  return Math.round(n * 100) / 100;
}

/** Corrente máxima em ampères inteiros, de 6 A (mínimo da IEC 61851) ao nominal: null = sem limite. */
export function correnteDe(v: unknown, maxA: number = CORRENTE_MAX_PADRAO_A): number | null | undefined {
  if (vazio(v)) return null;
  const n = numero(v);
  return Number.isInteger(n) && n >= CORRENTE_MIN_A && n <= maxA ? n : undefined;
}

/** Limite que vale para a recarga: o pedido ao iniciar, nunca acima do padrão do carregador. */
export function limiteDaRecarga(pedido: number | null, padrao: number | null): number | null {
  if (pedido === null) return padrao;
  return padrao === null ? pedido : Math.min(pedido, padrao);
}

/** A recarga passou de algum limite? Tempo conta do início; energia, do registrador. */
export function limiteAtingido(
  s: { inicio: Date; kwhTotal: number | null; limiteTempoMin: number | null; limiteEnergiaKwh: number | null },
  agora: Date,
): 'limite_tempo' | 'limite_energia' | null {
  if (s.limiteEnergiaKwh !== null && s.kwhTotal !== null && s.kwhTotal >= s.limiteEnergiaKwh) return 'limite_energia';
  if (s.limiteTempoMin !== null && agora.getTime() - s.inicio.getTime() >= s.limiteTempoMin * 60_000) return 'limite_tempo';
  return null;
}

export const duracaoMin = (inicio: Date, fim: Date): number => Math.max(Math.floor((fim.getTime() - inicio.getTime()) / 60_000), 0);

/**
 * Potência média entre duas leituras do registrador de energia, para carregador que não
 * manda Power.Active.Import. Só entre leituras próximas (até 30 min) e crescentes.
 */
export function potenciaMediaW(anterior: { ts: number; energiaWh: number } | undefined, atual: { ts: number; energiaWh: number }): number | null {
  if (!anterior) return null;
  const dtH = (atual.ts - anterior.ts) / 3_600_000;
  const dWh = atual.energiaWh - anterior.energiaWh;
  if (dtH <= 0 || dtH > 0.5 || dWh < 0) return null;
  return Math.round((dWh / dtH) * 10) / 10;
}

// ---- tag e permissões -------------------------------------------------------
/** Tag da recarga liberada no NexON para morador sem cartão: `NX` + 18 hexadecimais (idTag de 20). */
export const gerarIdTag = (): string => `NX${randomBytes(9).toString('hex').toUpperCase()}`;

/**
 * Grupo (parentIdTag) do morador: o mesmo para a tag da recarga liberada no NexON e para o
 * cartão dele. É o que o OCPP usa para deixar o cartão parar essa recarga no carregador.
 */
export const grupoDoMorador = (moradorId: string): string =>
  `M${String(moradorId).trim().toUpperCase().replace(/[^A-Z0-9]/g, '')}`.slice(0, ID_TAG_MAX);

/**
 * Tira de um texto o que pode ser segredo antes de ir para a trilha ou o audit log: sequência
 * hexadecimal longa (a chave de conexão dentro de uma URL, por exemplo).
 */
export const semSegredo = (texto: string): string => String(texto ?? '').replace(/[0-9a-f]{16,}/gi, '•••');

/** Parâmetro cujo valor é segredo pelo nome (senha, chave, token). */
export const parametroSecreto = (chave: string): boolean => /key|senha|password|secret|token/i.test(chave);

export interface PodeNoCarregador {
  /** Iniciar e parar (o morador, só a própria). */
  comandar: boolean;
  /** Limites padrão de tempo e energia e o início automático. */
  limites: boolean;
  /** Bloquear, liberar, destravar e atualizar a leitura. */
  bloquear: boolean;
  /** Corrente máxima, reiniciar, conexão OCPP e parâmetros (configuração técnica, PER-33a). */
  tecnico: boolean;
}

export function podeNoCarregador(papel: PapelCarregador): PodeNoCarregador {
  return {
    comandar: true,
    limites: papel === 'analista' || papel === 'proprietario',
    bloquear: papel !== 'morador',
    tecnico: papel === 'analista',
  };
}

/** Origem da recarga para a tela, a partir de `liberado_por`. */
export function origemDaRecarga(liberadoPor: string | null | undefined): 'nexon' | 'cartao' | 'automatico' {
  if (liberadoPor === 'tag') return 'cartao';
  if (liberadoPor === 'automatico') return 'automatico';
  return 'nexon';
}
