/**
 * Controle pelo MED — conversa com a TON da UFV (Fase B, lib firmware-libs/controle_ufv).
 * Núcleo PURO: monta o cadastro ("ctl geral"/"ctl cfg"), o hash que a TON devolve, o setpoint
 * com validade ("ctl <seq> <ttl> <i> <p> <q>...") e lê a resposta curta do ack.
 * docs/IOT-CONTROLE-MED-CONCESSIONARIA-IMPLEMENTACAO.md §5.
 */
import { Inversor, Params, Ufv } from './controle-med.calc';

/** Como o firmware escreve um setpoint daquele inversor (catálogo + diagrama IoT). */
export interface FaixaSp { escala: number; min: number | null; max: number | null }
export interface AlvoSp {
  dev: string;          // props.name do device no diagrama (o firmware casa por nome + endereço)
  addr: number;         // 0 = só nome
  tonId: string; tonNome: string;
  p: FaixaSp | null;    // sp_limite_pct
  q: FaixaSp | null;    // sp_q_pct
}
export interface ItemTon { ufv: Ufv; inv: Inversor; alvo: AlvoSp }

export const MAX_INV_TON = 8;
export const TRINCAS_POR_MSG = 3;   // "ctl <seq> <ttl>" + 3 trincas ≈ 60 caracteres (LoRa)
export const DEV_MAX = 31;

/** % → bruto do registrador (escala do catálogo), dentro da faixa do bo_map. */
export function bruto(f: FaixaSp | null, pct: number): number {
  if (!f) return 0;
  let v = Math.round(pct * (f.escala || 1));
  if (f.min != null && Number.isFinite(f.min)) v = Math.max(f.min, v);
  if (f.max != null && Number.isFinite(f.max)) v = Math.min(f.max, v);
  return v;
}

/** FNV-1a 32 → 24 bits em hex (6 dígitos), como a TON (ctl.cpp _hash). */
export function hashCadastro(linhas: string[]): string {
  let h = 0x811c9dc5;
  const s = Buffer.from(linhas.join('\n'), 'utf8');
  for (const b of s) { h ^= b; h = Math.imul(h, 16777619) >>> 0; }
  return (h & 0xffffff).toString(16).padStart(6, '0');
}

/**
 * Cadastro de UMA TON (inversores na ordem da lista = índice 1..n):
 *   ctl geral <n> <t2_s> <bi> <bi_inv>
 *   ctl cfg <i> <addr> <p1> <p2> <pman> <rampa> <device>
 * p1 = P estático da UFV dividido pela Pn (mesmo % em todos os inversores dela); p2 = 0 se a UFV
 * "zera no estágio 2"; pman = 100 % (manual e controle desligado); rampa = % de Pn por minuto.
 */
export function montarCadastro(itens: ItemTon[], p: Params): { linhas: string[]; hash: string; avisos: string[] } {
  const avisos: string[] = [];
  const lista = itens.slice(0, MAX_INV_TON);
  if (itens.length > MAX_INV_TON) avisos.push(`TON ${itens[0]?.alvo.tonNome}: só os ${MAX_INV_TON} primeiros inversores entram no controle local.`);
  const comBi = lista.find((x) => (x.ufv.bi_manual ?? 0) > 0)?.ufv;
  const linhas = [`ctl geral ${lista.length} ${Math.round(p.t_estagio2_s)} ${comBi?.bi_manual ?? 0} ${comBi?.bi_invertida ? 1 : 0}`];
  lista.forEach((x, k) => {
    const pnUfv = x.ufv.inversores.reduce((a, i) => a + (i.pn_kw || 0), 0);
    const pctEst = pnUfv > 0 ? Math.min(100, (x.ufv.p_estatico_kw / pnUfv) * 100) : 100;
    const p1 = bruto(x.alvo.p, pctEst);
    const p2 = x.ufv.zera_estagio2 ? bruto(x.alvo.p, 0) : p1;
    const pman = bruto(x.alvo.p, 100);
    const rampa = Math.max(0, Math.round((p.rampa_pct_min ?? 10) * (x.alvo.p?.escala || 1)));
    let dev = x.alvo.dev.replace(/\s+/g, ' ').trim();
    if (dev.length > DEV_MAX) { avisos.push(`${dev}: nome do device com mais de ${DEV_MAX} caracteres — encurte no diagrama IoT.`); dev = dev.slice(0, DEV_MAX); }
    linhas.push(`ctl cfg ${k + 1} ${x.alvo.addr || 0} ${p1} ${p2} ${pman} ${rampa} ${dev}`);
  });
  return { linhas, hash: hashCadastro(linhas), avisos };
}

/** "ctl <seq> <ttl> <i> <p> <q> ..." em pedaços de até TRINCAS_POR_MSG (mesmo seq: a TON aceita seq ≥ último). */
export function montarCtl(seq: number, ttl: number, trincas: Array<[number, number, number]>): string[] {
  const out: string[] = [];
  if (!trincas.length) return [`ctl ${seq} ${ttl}`];
  for (let k = 0; k < trincas.length; k += TRINCAS_POR_MSG) {
    out.push(`ctl ${seq} ${ttl} ${trincas.slice(k, k + TRINCAS_POR_MSG).map((t) => t.join(' ')).join(' ')}`);
  }
  return out;
}

export interface RespostaCtl {
  ok: boolean;
  erro: string | null;             // sem_cfg | seq_velho | ttl_invalido | idx_invalido | ctl_formato | unknown_cmd | ...
  modo: 'D' | 'A' | 'S1' | 'S2' | 'M' | null;
  hash: string | null;
  seg_seguro: number; seg_manual: number;
  pior: 'S1' | 'S2' | null;
  porIdx: Record<number, string>;  // "ok" | "w" | "=" | "f" | "rb<n>" | "rq<n>" (+ "r" = limitado pela rampa)
}

/** Lê a resposta da TON: "A c=1a2b3c s=600 p=S2 1:ok 2:=" ou "sem_cfg c=1a2b3c". */
export function lerRespostaCtl(status: string, msg: string): RespostaCtl {
  const r: RespostaCtl = { ok: status !== 'error', erro: null, modo: null, hash: null, seg_seguro: 0, seg_manual: 0, pior: null, porIdx: {} };
  const tk = String(msg ?? '').trim().split(/\s+/).filter(Boolean);
  if (!tk.length) { r.ok = false; r.erro = 'sem_resposta'; return r; }
  if (['D', 'A', 'S1', 'S2', 'M'].includes(tk[0])) r.modo = tk[0] as RespostaCtl['modo'];
  else r.erro = tk[0];
  for (const t of tk.slice(1)) {
    let m: RegExpMatchArray | null;
    if ((m = t.match(/^c=([0-9a-f]{1,6})$/i))) r.hash = m[1].toLowerCase().padStart(6, '0');
    else if ((m = t.match(/^s=(\d+)$/))) r.seg_seguro = Number(m[1]);
    else if ((m = t.match(/^m=(\d+)$/))) r.seg_manual = Number(m[1]);
    else if ((m = t.match(/^p=(S[12])$/))) r.pior = m[1] as 'S1' | 'S2';
    else if ((m = t.match(/^(\d+):(.+)$/))) r.porIdx[Number(m[1])] = m[2];
  }
  if (r.erro) r.ok = false;
  return r;
}

/** Token do inversor → resultado para o card ("ok" = valeu; o resto explica a falha). */
export function resultadoDoToken(t: string | undefined): { ok: boolean; texto: string } {
  if (t == null) return { ok: false, texto: 'sem resposta da TON para este inversor' };
  const rampa = t.endsWith('r') && t !== 'r';
  const base = rampa ? t.slice(0, -1) : t;
  if (base === 'ok' || base === '=') return { ok: true, texto: rampa ? 'ok (subindo pela rampa)' : 'ok' };
  if (base === 'w') return { ok: true, texto: rampa ? 'ok, sem read-back (rampa)' : 'ok, sem read-back' };
  if (base === 'f') return { ok: false, texto: 'escrita falhou — a TON tenta de novo a cada 15 s' };
  const rb = base.match(/^r([bq])(-?\d+)$/);
  if (rb) return { ok: false, texto: `read-back leu ${rb[2]} no ${rb[1] === 'b' ? 'limite de P' : 'Q'} — inversor não aceitou` };
  return { ok: false, texto: base };
}

export const MODO_TON_TEXTO: Record<string, string> = {
  D: 'controle desligado', A: 'automático', S1: 'modo seguro (estágio 1)', S2: 'modo seguro (estágio 2)', M: 'chave em MANUAL',
};
