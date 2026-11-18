import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { SUBPROTOCOLO } from './ocpp-protocolo';

/**
 * Entrada do carregador na central: quem pode abrir o WebSocket `/ocpp/...`.
 * Lógica PURA (testada em ocpp-conexao.spec.ts); o OcppService só aplica a decisão.
 *
 * Duas formas de apresentar a chave (o manual do Chint não diz qual o firmware aceita):
 *  - na URL: `/ocpp/<chave>/<identidade>` — funciona com qualquer carregador que aceite uma URL
 *    (e `/ocpp/<chave>` sozinho, para o carregador que não acrescenta a identidade: a chave já diz qual é);
 *  - HTTP Basic (perfil de segurança do OCPP 1.6): `/ocpp/<identidade>` + `Authorization: Basic`,
 *    usuário = identidade e senha = chave.
 * Sem chave, com chave errada ou identidade não cadastrada: recusado.
 */
export interface EstacaoOcpp {
  id: string;
  /** Identidade OCPP (Charge Point ID), como o carregador a envia. */
  chargePointId: string;
  equipamentoId: string | null;
  plantaId: string | null;
  /** Conector do carregador que é este equipamento (1 no Wallbox de um conector). */
  conector: number;
  chaveHash: string | null;
}

/** Chave nova: 16 bytes em hexadecimal (tamanho mínimo da AuthorizationKey do OCPP 1.6). */
export const gerarChave = (): string => randomBytes(16).toString('hex');

/** Só o hash vai para o banco. A chave é hexadecimal: maiúscula ou minúscula dá no mesmo. */
export const hashChave = (chave: string): string =>
  createHash('sha256').update(String(chave).trim().toLowerCase()).digest('hex');

const hashIgual = (a: string, b: string): boolean => {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
};

export const normalizarIdentidade = (v: string): string => String(v ?? '').trim().toLowerCase();

/** Identidade aceitável no cadastro: 1 a 64 caracteres de URL, sem barra nem espaço. */
export function identidadeValida(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return /^[A-Za-z0-9._:\-*=+|@]{1,64}$/.test(s) ? s : null;
}

export interface PedidoConexao {
  /** `req.url` do upgrade. */
  url: string;
  authorization?: string | string[];
  /** Cabeçalho `Sec-WebSocket-Protocol`. */
  protocolos?: string | string[];
}

export type DecisaoConexao =
  | { ok: true; estacao: EstacaoOcpp; via: 'url' | 'basic' }
  | { ok: false; http: 400 | 401 | 403 | 404; motivo: string; identidade: string };

const umSo = (v?: string | string[]): string => (Array.isArray(v) ? v[0] ?? '' : v ?? '');

function segmentos(url: string): string[] | null {
  const caminho = url.split('?')[0].replace(/^\/ocpp\//, '').replace(/\/+$/, '');
  if (!caminho) return [];
  try {
    return caminho.split('/').map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
}

/** Senhas candidatas do Basic: o texto digitado, ou os bytes que ele representa em hexadecimal. */
function chavesDoBasic(authorization: string): string[] {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(authorization);
  if (!m) return [];
  const bruto = Buffer.from(m[1], 'base64');
  const sep = bruto.indexOf(0x3a);
  if (sep < 0) return [];
  const senha = bruto.subarray(sep + 1);
  if (!senha.length) return [];
  return [senha.toString('utf8'), senha.toString('hex')];
}

/**
 * O que vai para o log e para a lista de recusas no lugar da identidade enviada: só
 * caracteres visíveis, até 64, e nunca algo com cara de chave (um instalador pode trocar a
 * ordem ou errar um dígito, e a chave não pode parar em log).
 */
export function identidadeParaLog(v: string): string {
  const limpo = String(v ?? '').replace(/[^\x20-\x7e]/g, '?').slice(0, 64);
  return /^[0-9a-f]{16,}$/i.test(limpo) ? '(parece uma chave)' : limpo;
}

/**
 * Decide o pedido de conexão contra o cadastro em memória (`estacoes`, sem ir ao banco:
 * o upgrade tem de responder na hora).
 */
export function decidirConexao(pedido: PedidoConexao, estacoes: Iterable<EstacaoOcpp>): DecisaoConexao {
  const segs = segmentos(pedido.url);
  if (!segs || segs.length < 1 || segs.length > 2 || segs.some((s) => !s)) {
    return { ok: false, http: 400, motivo: 'Endereço inválido', identidade: '' };
  }
  const lista = [...estacoes];
  const donaDe = (chave: string): EstacaoOcpp | undefined => {
    const h = hashChave(chave);
    return lista.find((e) => e.chaveHash && hashIgual(h, e.chaveHash));
  };
  // A chave é o segmento que casa com uma chave cadastrada, em qualquer posição (a ordem
  // pode vir trocada). O outro segmento é a identidade; sem ele, vale a da dona da chave.
  const iChave = segs.findIndex((x) => !!donaDe(x));
  const donaUrl = iChave >= 0 ? donaDe(segs[iChave]) : undefined;
  const enviada = donaUrl ? segs.find((_, i) => i !== iChave) ?? donaUrl.chargePointId : segs[segs.length - 1];
  const identidade = identidadeParaLog(enviada);
  const oferecidos = umSo(pedido.protocolos).split(',').map((x) => x.trim().toLowerCase());
  if (!oferecidos.includes(SUBPROTOCOLO)) {
    return { ok: false, http: 400, motivo: `Subprotocolo ${SUBPROTOCOLO} não oferecido`, identidade };
  }
  const outraIdentidade = (dona: EstacaoOcpp): DecisaoConexao => ({
    ok: false, http: 403, identidade,
    motivo: `Chave correta, mas a identidade enviada é diferente da cadastrada (${dona.chargePointId})`,
  });
  if (donaUrl) {
    return normalizarIdentidade(enviada) === normalizarIdentidade(donaUrl.chargePointId)
      ? { ok: true, estacao: donaUrl, via: 'url' }
      : outraIdentidade(donaUrl);
  }
  const alvo = lista.find((e) => normalizarIdentidade(e.chargePointId) === normalizarIdentidade(enviada));
  const naoEntra = (motivo: string): DecisaoConexao =>
    alvo ? { ok: false, http: 401, motivo, identidade } : { ok: false, http: 404, motivo: 'Carregador não cadastrado', identidade };
  const noBasic = chavesDoBasic(umSo(pedido.authorization));
  if (noBasic.length) {
    const dona = noBasic.map(donaDe).find((e) => !!e);
    if (dona && alvo && dona.id === alvo.id) return { ok: true, estacao: alvo, via: 'basic' };
    return dona ? outraIdentidade(dona) : naoEntra('Chave de conexão incorreta');
  }
  return naoEntra(segs.length === 2 ? 'Chave de conexão incorreta' : 'Sem chave de conexão');
}

/** Resposta HTTP de recusa do upgrade (o socket é fechado em seguida). */
export function respostaRecusa(http: number): string {
  const texto: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 503: 'Service Unavailable' };
  const linhas = [`HTTP/1.1 ${http} ${texto[http] ?? 'Error'}`, 'Connection: close', 'Content-Length: 0'];
  if (http === 401) linhas.push('WWW-Authenticate: Basic realm="ocpp"');
  return `${linhas.join('\r\n')}\r\n\r\n`;
}

/** URLs que o instalador configura no carregador. */
export function urlsDeConexao(base: string, chave: string, identidade: string): { url: string; url_completa: string } {
  const b = base.replace(/\/+$/, '');
  return { url: `${b}/${chave}`, url_completa: `${b}/${chave}/${encodeURIComponent(identidade)}` };
}

/** Base pública `wss://host/ocpp` a partir da URL pública da API (http → ws, https → wss). */
export function baseOcpp(publica: string | undefined | null): string {
  const u = String(publica ?? '').trim().replace(/\/+$/, '').replace(/\/api\/v\d+$/, '');
  if (!u) return 'wss://aupus-nexon-api.aupusenergia.com.br/ocpp';
  return `${u.replace(/^http/i, 'ws')}/ocpp`;
}
