import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService, ClienteInfo, ScopedUser } from '@/core';
import { EquipamentosCmdService } from '../equipamentos-cmd/equipamentos-cmd.service';
import { MqttService } from '../../shared/mqtt/mqtt.service';
import { Irrigacao, duracaoParadaMs } from './pivo-automacao.util';
import { parametrosEncoder } from './pivo-posicao.util';
import { calibracaoVigente } from './pivo-calibracao.repo';

/**
 * Pivô com a SEQUÊNCIA NA TON (docs/IOT-PIVO-TON-LOCAL.md, Fase 3).
 *
 * O NexON não comanda mais passo a passo: manda a configuração (`pivo io/tempos/enc`, só quando
 * muda) e o plano (`pivo ligar …` / `pivo desligar`), e acompanha a TON pelo status
 * (`<base>/pivo`), pelos eventos (`<base>/pivo/evento`) e pelo ack do `pivo status`.
 * A TON liga, confere cada BI, irriga, para e desliga sozinha — sem internet.
 *
 * Vale quando: as BOs de giro, percentímetro (e bomba, se houver) estão numa TON só, e essa TON
 * tem o firmware novo (responde `pivo status`). Senão a sequência antiga do servidor segue.
 */

type Autor = ScopedUser & { nome?: string };
type Passo = (etapa: string, msg: string, ok: boolean | null) => Promise<void>;
type Fim = (status: 'concluida' | 'falhou' | 'interrompida' | 'cancelada', erro?: string) => Promise<void>;

export interface AlvoTon {
  tonId: string;
  /** BO por papel: bomba, valvula, dir, esq, perc, canhao (0 = sem). */
  bo: number[];
  /** BI por papel: pressao, tensao, gir_dir, gir_esq, seguranca, canhao (0 = sem). */
  bi: number[];
  /** 6 dígitos 0/1: BI ativa em baixo (ton_bi.invertido). */
  inv: string;
}

/**
 * Status da TON (glue pivo.cpp, spec 7.3), normalizado:
 * e = etapa (0 parado, 1 aguardando pressão/giro, 2 girando) · p = passo da partida (1 pressão, 2 giro)
 * f = motivo da última parada ('' = nenhuma) · at = alertas (bit0 erro de posição, 1 falha no canhão,
 * 2 reinícios repetidos) · an = ângulo BRUTO do encoder · pc = graus percorridos · al = graus da parada
 * bi = entradas (bit4 = segurança OK) · bo = saídas (bit6 = girando) · o = id da ordem.
 */
export interface StatusTon {
  e: number; p: number; f: string; d: string; a: number; pm: number;
  an: number | null; pc: number; al: number; bi: number; bo: number; at: number; o: string;
}

/** Motivo da última parada (código da TON, spec 8.6 + extras) → nome. */
export const MOTIVOS = ['', 'concluida', 'comando_operador', 'queda_pressao', 'pressao_nao_subiu', 'tensao', 'seguranca',
  'reinicio_slave', 'condicao_partida', 'nao_girou', 'lado_caiu', 'falha_reles'] as const;
const motivoDe = (v: unknown): string => {
  if (typeof v === 'number') return MOTIVOS[v] ?? String(v);
  const s = String(v ?? '');
  return s === 'nenhuma' || s === '-' ? '' : s;
};
/** Paradas que NÃO são falha (situação final "Concluída"/"Interrompida"). */
export const PARADA_NORMAL = new Set(['', 'concluida', 'comando_operador']);

export interface ExecutarNaTon {
  pivoId: string;
  seqId: string;
  acao: 'girar_direita' | 'girar_esquerda' | 'desligar';
  irr: Irrigacao | null;
  ctl: { cancelar: boolean };
  reiniciar: boolean;
  restanteParadaMs?: number | null;
  sequencia: { pressurizacao_s: number; confirma_giro_s: number; confirma_bomba_s: number; tol_pressao_s?: number; tol_tensao_s?: number };
  cicloPercS: number;
  tempoVolta100h: number;
  anguloAtual: number | null;
  passo: Passo;
  fim: Fim;
  user?: Autor;
  cliente?: ClienteInfo;
}

const ESTADO = ['parado', 'aguardando_pressao', 'girando'] as const;

/** Textos da trilha para os eventos da TON (t:x). */
const TXT_PASSO: Record<string, string> = {
  bomba_ligada: 'Bombeamento ON (BO01) e válvula ON — aguardando pressão (BI01)',
  girar_direita: 'Pressão OK — girar direita ON (BO03), aguardando o giro (BI03)',
  girar_esquerda: 'Pressão OK — girar esquerda ON (BO04), aguardando o giro (BI04)',
  girando: 'Giro confirmado',
  percentimetro: 'Percentímetro aplicado (BO05)',
  canhao_ligar: 'Canhão ON (BO06)',
  canhao_desligar: 'Canhão OFF (BO06)',
  canhao_ligado: 'Canhão confirmado ligado (BI06)',
  canhao_desligado: 'Canhão confirmado desligado (BI06)',
};
export const TXT_FALHA: Record<string, string> = {
  concluida: 'Parada programada atingida (graus percorridos)',
  comando_operador: 'Desligado pelo operador',
  queda_pressao: 'Queda de pressão (BI01)',
  pressao_nao_subiu: 'A pressão não subiu no tempo de espera (BI01)',
  tensao: 'Sem tensão (BI02)',
  seguranca: 'Segurança atuou (BI05)',
  reinicio_slave: 'A TON reiniciou com o pivô ligado (queda de energia ou reset)',
  condicao_partida: 'Condição de partida não OK (tensão BI02 ou segurança BI05)',
  nao_girou: 'O pivô não confirmou o sentido (BI03/BI04)',
  lado_caiu: 'O pivô parou sem comando (retorno do sentido caiu)',
  falha_reles: 'Relés da TON sem controle (expansor I2C): a TON desligou o pivô',
};
/** Passo da partida no status (pivo::Passo) — o satélite LoRa não manda eventos, só o status/ack. */
const TXT_PASSO_N: Record<number, (dir: string) => string> = {
  1: () => 'Bombeamento ON (BO01) e válvula ON — aguardando pressão (BI01)',
  2: (d) => `Girar ${d === 'E' ? 'esquerda ON (BO04), aguardando o giro (BI04)' : 'direita ON (BO03), aguardando o giro (BI03)'}`,
};
const TXT_AVISO: Record<string, string> = {};
const TXT_RECUSA: Record<string, string> = {
  pivo_ja_ligado: 'A TON já está com uma irrigação em curso',
  pivo_pivo_girando: 'O pivô já está girando pelo painel',
  pivo_condicao_partida: 'Condição de partida não OK: tensão (BI02) ou segurança (BI05) em 0',
  pivo_sem_config: 'A TON ainda não recebeu a configuração do pivô',
  pivo_io_incompleto: 'Falta BO de giro, percentímetro ou bombeamento ligada nesta TON',
  pivo_sem_encoder: 'Parada em graus precisa do encoder na mesma TON',
  pivo_falha_reles: 'Os relés da TON estão sem controle (expansor I2C) — confira a placa antes de ligar',
};

/**
 * `pivo enc <resolução> 0 0` — a TON usa só o valor BRUTO do encoder (spec 5.3 e decisão 12/11): sem
 * zero nem sentido. A calibração (NEXON-103) fica no NexON/app, que converte bruto ↔ ângulo.
 */
export function comandoEnc(enc: { resolucao: number | null; invertido?: boolean; zero?: number }): string {
  return `pivo enc ${enc.resolucao} 0 0`;
}

/** CRC16 Modbus de um texto — o mesmo que a TON calcula sobre os argumentos do `pivo cfg`. */
export function crc16(txt: string): string {
  let c = 0xffff;
  for (const b of Buffer.from(txt, 'utf8')) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
  }
  return c.toString(16).toUpperCase().padStart(4, '0');
}

/** Ângulo calibrado (azimute) → contagem bruta do encoder (inverso de anguloDoEncoder). */
export function brutoDoAngulo(angulo: number, enc: { resolucao: number | null; invertido: boolean; zero: number }): number {
  const res = enc.resolucao || 360;
  let g = (((angulo - enc.zero) % 360) + 360) % 360;
  if (enc.invertido) g = (360 - g) % 360;
  return Math.round((g * res) / 360) % res;
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, Math.round(n)));
/** id curto da irrigação no comando/eventos (o comando tem de caber no pacote LoRa). */
export const idCurto = (seqId: string) => seqId.trim().slice(-8).toLowerCase();

@Injectable()
export class PivoTonService implements OnModuleInit {
  private readonly logger = new Logger('PivoTon');
  private readonly status = new Map<string, { s: StatusTon; em: number; n: number }>();
  private readonly eventos = new Map<string, Array<{ t: string; x: string; e: string; id: string; em: number; n: number }>>();
  /** Contador de mensagens recebidas: "depois do comando" é n > n0 (horário em ms empata). */
  private n = 0;
  private readonly suporte = new Map<string, { ok: boolean; em: number }>();
  /** Por que a TON foi dada como "sem sequência local" da última vez (para dizer a quem perguntou). */
  private readonly semSuportePorque = new Map<string, string>();
  motivoSemSuporte(tonId: string): string | null {
    return this.semSuportePorque.get(tonId.trim()) ?? null;
  }
  private readonly cfgEnviada = new Map<string, string>();
  /** CRC da configuração que a TON informou ter (ack do `pivo status`: "k<crc>"). */
  private readonly cfgNaTon = new Map<string, string>();
  /** A TON parou sozinha (parada programada, falha, segurança): quem registra na trilha do pivô. */
  aoPararSozinho?: (tonId: string, motivo: string, falha: boolean, id: string) => void;
  /** Sequência acompanhada agora por TON (o evento de parada dela não é "sozinho"). */
  private readonly acompanhando = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly mqtt: MqttService,
    private readonly cmd: EquipamentosCmdService,
  ) {}

  onModuleInit() {
    this.mqtt.setPivoHooks({
      status: (tonId, d) => this.receberStatus(tonId, d),
      evento: (tonId, d) => this.receberEvento(tonId, d),
    });
  }

  // ------------------------------------------------------------------ entrada (MQTT)

  /** Status da TON no formato de 12/11 (o, i, et, p, an, gp, al, pm, mo, at, d, a, bo) → StatusTon. */
  static normalizar(d: any): StatusTon | null {
    // Formato posicional (firmware de 12/11, cabe no MTU do LoRa): {"s":"et,p,i,bo,an,gp,al,pm,mo,at,d,a,o"}
    if (d && typeof d === 'object' && typeof d.s === 'string') {
      const v = d.s.split(',');
      if (v.length < 13 || v[0] === '' || isNaN(Number(v[0]))) return null;
      const n = (i: number) => Number(v[i]) || 0;
      d = { et: n(0), p: n(1), i: n(2), bo: n(3), an: v[4] === '' ? null : Number(v[4]), gp: n(5), al: n(6),
        pm: v[7] === '' ? -1 : Number(v[7]), mo: n(8), at: n(9), d: v[10] || 'D', a: v[11] === '' ? 1 : Number(v[11]), o: v.slice(12).join(',') };
    }
    if (!d || typeof d !== 'object' || typeof d.et !== 'number') return null;
    return {
      e: d.et, p: Number(d.p) || 0, f: motivoDe(d.mo), d: String(d.d ?? 'D'), a: Number(d.a ?? 1), pm: Number(d.pm ?? -1),
      an: typeof d.an === 'number' ? d.an : null, pc: Number(d.gp) || 0, al: Number(d.al) || 0,
      bi: Number(d.i) || 0, bo: Number(d.bo) || 0, at: Number(d.at) || 0, o: String(d.o ?? ''),
    };
  }

  receberStatus(tonId: string, dados: any) {
    const d = PivoTonService.normalizar(dados);
    if (!d) return;
    const t = tonId.trim();
    const ant = this.status.get(t)?.s;
    this.status.set(t, { s: d, em: Date.now(), n: ++this.n });
    this.suporte.set(t, { ok: true, em: Date.now() });
    // A TON foi a PARADO sozinha (falta de pressão, segurança, parada programada…) sem uma
    // sequência do NexON acompanhando: o NexON encerra a irrigação na hora (sem esperar as BIs).
    if (ant && ant.e !== 0 && d.e === 0 && !this.acompanhando.has(t)) this.avisarParada(t, String(d.f ?? ''), '');
  }

  /** Uma parada sozinha só é avisada uma vez (evento + status podem chegar os dois). */
  private readonly paradaAvisada = new Map<string, number>();
  private avisarParada(t: string, motivo: string, id: string) {
    const ult = this.paradaAvisada.get(t) ?? 0;
    if (Date.now() - ult < 30_000) return;
    this.paradaAvisada.set(t, Date.now());
    const m = motivo || 'concluida';
    try { this.aoPararSozinho?.(t, m, !PARADA_NORMAL.has(m), id); } catch { /* melhor esforço */ }
  }

  receberEvento(tonId: string, d: any) {
    if (!d || typeof d !== 'object' || typeof d.t !== 'string') return;
    const t = tonId.trim();
    const arr = this.eventos.get(t) ?? [];
    arr.push({ t: d.t, x: String(d.x ?? ''), e: String(d.e ?? ''), id: String(d.id ?? ''), em: Date.now(), n: ++this.n });
    while (arr.length > 60) arr.shift();
    this.eventos.set(t, arr);
    this.suporte.set(t, { ok: true, em: Date.now() });
    if ((d.t === 'parado' || d.t === 'falha') && !this.acompanhando.has(t)) this.avisarParada(t, String(d.x ?? ''), String(d.id ?? ''));
  }

  /** Último status da TON (até 15 min). */
  statusDaTon(tonId: string): (StatusTon & { estado: string; em: Date; motivo_ultima_parada: string; motivo_texto: string | null;
    alertas: { erro_posicao: boolean; falha_canhao: boolean; reinicios_repetidos: boolean } }) | null {
    const r = this.status.get(tonId.trim());
    if (!r || Date.now() - r.em > 15 * 60_000) return null;
    const at = r.s.at || 0;
    return {
      ...r.s, estado: ESTADO[r.s.e] ?? '?', em: new Date(r.em),
      motivo_ultima_parada: r.s.f || 'nenhuma', motivo_texto: r.s.f ? (TXT_FALHA[r.s.f] ?? r.s.f) : null,
      alertas: { erro_posicao: !!(at & 1), falha_canhao: !!(at & 2), reinicios_repetidos: !!(at & 4) },
    };
  }

  /** Canhão comandado com sucesso: atualiza o bit da BO06 no status em memória até o próximo status da TON. */
  marcarCanhao(tonId: string, ligado: boolean) {
    const r = this.status.get(tonId.trim());
    if (!r) return;
    r.s = { ...r.s, bo: ligado ? (r.s.bo | 32) : (r.s.bo & ~32) };
  }

  /** A TON está com a sequência local ligada (partindo ou girando)? */
  ligadaNaTon(tonId: string): boolean {
    const s = this.statusDaTon(tonId);
    return !!s && s.e !== 0;
  }

  // ------------------------------------------------------------------ alvo / config

  /**
   * TON que executa a sequência deste pivô, com o mapa de I/O por papel — ou null (fica no servidor):
   * giro (dir/esq) e percentímetro obrigatórios; todas as BOs do pivô numa TON só; firmware novo.
   */
  async alvo(pivoId: string, user?: Autor, cliente?: ClienteInfo): Promise<AlvoTon | null> {
    const rows = await this.prisma.$queryRaw<Array<{ tipo: string; nome: string; bo_ton: string | null; bo: number | null; bi_ton: string | null; bi: number | null; inv: boolean | null }>>`
      SELECT p.tipo, p.nome, TRIM(b.ton_id) AS bo_ton, b.bo_numero AS bo, TRIM(i.ton_id) AS bi_ton, i.bi_numero AS bi, i.invertido AS inv
      FROM equipamento_pontos p
      LEFT JOIN ton_bo b ON b.equipamento_ponto_id = p.id AND b.deleted_at IS NULL AND b.ativo
      LEFT JOIN ton_bi i ON i.equipamento_ponto_id = p.id AND i.deleted_at IS NULL AND i.ativo
      WHERE p.equipamento_id = ${pivoId}::bpchar AND p.deleted_at IS NULL AND p.ativo`;
    const BO: Array<[number, RegExp]> = [[5, /canha/], [1, /valvul|solenoid/], [4, /percent/], [3, /esquerd|anti.?horario/], [2, /direit|horario/], [0, /^(?!.*deslig).*(bomb|ligar)/]];
    const BI: Array<[number, RegExp]> = [[5, /canha/], [0, /press/], [1, /tens/], [4, /segur|desalin/], [3, /esquerd/], [2, /direit/]];
    const bo = [0, 0, 0, 0, 0, 0], bi = [0, 0, 0, 0, 0, 0], inv = ['0', '0', '0', '0', '0', '0'];
    const tonsBo = new Set<string>();
    let tonGiro: string | null = null;
    for (const r of rows) {
      const n = norm(r.nome);
      if (r.tipo === 'comando' && r.bo_ton && r.bo) {
        const papel = BO.find(([, re]) => re.test(n))?.[0];
        if (papel === undefined || bo[papel]) continue;
        bo[papel] = r.bo;
        tonsBo.add(r.bo_ton);
        if (papel === 2 || papel === 3) tonGiro = r.bo_ton;
      }
    }
    if (!tonGiro || tonsBo.size !== 1 || !bo[2] || !bo[3] || !bo[4]) return null;
    for (const r of rows) {
      const n = norm(r.nome);
      if (r.tipo === 'status' && r.bi_ton === tonGiro && r.bi) {
        const papel = BI.find(([, re]) => re.test(n))?.[0];
        if (papel === undefined || bi[papel]) continue;
        bi[papel] = r.bi;
        inv[papel] = r.inv ? '1' : '0';
      }
    }
    if (!(await this.temFirmware(pivoId, tonGiro, user, cliente))) return null;
    return { tonId: tonGiro, bo, bi, inv: inv.join('') };
  }

  /** Firmware com a sequência local? (já publicou status/evento, ou responde "pivo status"). Cache 30 min / 10 min. */
  private async temFirmware(pivoId: string, tonId: string, user?: Autor, cliente?: ClienteInfo): Promise<boolean> {
    const c = this.suporte.get(tonId);
    if (c && Date.now() - c.em < (c.ok ? 30 : 10) * 60_000) return c.ok;
    try {
      await this.lerEstadoPeloAck(pivoId, tonId, user, cliente);
      return true;
    } catch (e) {
      this.suporte.set(tonId, { ok: false, em: Date.now() });
      this.semSuportePorque.set(tonId, e instanceof Error ? e.message : String(e));
      this.logger.log(`[pivo-ton] TON ${tonId} sem sequência local (${e instanceof Error ? e.message : e}) — segue no servidor`);
      return false;
    }
  }

  /** `pivo status` → ack "pivo_st <etapa> <passo> <permil> <motivo> a<alertas> …" (chega mesmo pelo LoRa). */
  async lerEstadoPeloAck(pivoId: string, tonId: string, user?: Autor, cliente?: ClienteInfo): Promise<{ e: number; p: number; pm: number; f: string; at: number }> {
    const r = await this.cmd.comandoTon({ equipamentoId: pivoId, tonId, cmd: 'pivo status', rotulo: 'Estado do pivô na TON', ackOk: /^pivo_st /, silencioso: true }, user, cliente);
    const m = /^pivo_st (\d) (\d) (-?\d+) (\S+)(?: a(\d+))?(?: k([0-9A-F]{4}))?/.exec(r.msg);
    if (!m) throw new Error(`resposta inesperada: ${r.msg}`);
    const est = { e: Number(m[1]), p: Number(m[2]), pm: Number(m[3]), f: motivoDe(m[4]), at: Number(m[5] ?? 0) };
    this.suporte.set(tonId, { ok: true, em: Date.now() });
    if (m[6]) this.cfgNaTon.set(tonId.trim(), m[6]);
    const ant = this.status.get(tonId)?.s;
    const base: StatusTon = ant ?? { e: 0, p: 0, f: '', d: 'D', a: 1, pm: -1, an: null, pc: 0, al: 0, bi: 0, bo: 0, at: 0, o: '' };
    this.status.set(tonId, { s: { ...base, e: est.e, p: est.p, pm: est.pm, f: est.f, at: est.at }, em: Date.now(), n: ++this.n });
    return est;
  }

  /** Configuração da TON (io/tempos/enc) — só manda o que mudou desde o último envio aceito. */
  private async garantirConfig(x: ExecutarNaTon, alvo: AlvoTon) {
    const s = x.sequencia;
    // pivo tempos <espera_pressao> <confirma_giro> <confirma_canhao> <tol_pressao> <tol_tensao> <tol_lado> <sem_posicao> <janela_giro> <ciclo_perc>
    const tempos = [
      clamp(s.pressurizacao_s > 0 ? s.pressurizacao_s : 60, 5, 1800),   // espera da pressão (spec: 60 s)
      clamp(s.confirma_giro_s || 30, 5, 600),
      5,                                                                // canhão sem BI06 por 5 s -> alerta
      clamp(s.tol_pressao_s ?? 0, 0, 60),                               // tolerâncias: 0 = desliga na hora
      clamp(s.tol_tensao_s ?? 0, 0, 60),
      0,
      30,                                                               // encoder sem leitura 30 s -> alerta
      600,
      clamp(x.cicloPercS || 60, 5, 600),
    ];
    const enc = await this.encoderNaTon(x.pivoId, alvo.tonId, false);
    // Um comando só (cabe no LoRa): BOs e BIs em 6 dígitos, polaridade, 9 tempos e a resolução do encoder.
    const args = `${alvo.bo.join('')} ${alvo.bi.join('')} ${alvo.inv} ${tempos.join(' ')} ${enc?.resolucao ?? 0}`;
    const t = alvo.tonId.trim();
    if (this.cfgEnviada.get(t) === args) return;
    // A TON já tem esta config (CRC do ack do "pivo status", feito no alvo()): nada a mandar.
    if (this.cfgNaTon.get(t) === crc16(args)) { this.cfgEnviada.set(t, args); return; }
    await x.passo('ton', 'Enviando a configuração do pivô para a TON', null);
    try {
      const r = await this.cmd.comandoTon({ equipamentoId: x.pivoId, tonId: t, cmd: `pivo cfg ${args}`, rotulo: 'Configuração do pivô na TON', ackOk: /^pivo_cfg_ok/ }, x.user, x.cliente);
      const k = /k([0-9A-F]{4})/.exec(r.msg)?.[1];
      if (k) this.cfgNaTon.set(t, k);
    } catch (e) {
      const m = String((e as any)?.response?.message ?? (e as any)?.message ?? e);
      if (/pivo_cmd_desconhecido|pivo_cfg_invalido|pivo_tempos/.test(m)) throw new Error('O firmware desta TON é anterior a 12/11/2026: regrave a TON para usar a sequência nova do pivô.');
      throw e;
    }
    this.cfgEnviada.set(t, args);
    await x.passo('ton', 'Configuração aplicada na TON', true);
  }

  /**
   * A calibração do ângulo (NEXON-103) acabou de gravar `pivo enc` nesta TON: o que estava
   * guardado como "já enviado" deixa de valer e a próxima partida confere a configuração inteira.
   */
  esquecerConfig(tonId: string) {
    this.cfgEnviada.delete(tonId.trim());
    this.cfgNaTon.delete(tonId.trim());
  }

  /**
   * Encoder do pivô lido NA MESMA TON (tópico do encoder debaixo do tópico da TON) — senão null.
   * `exigirCalibracao` (padrão): sem calibração ativa a contagem não vira ângulo, e a TON fica
   * sem encoder (`pivo enc 0 0 0`) até calibrar — parada por ângulo não pode usar posição sem norte.
   */
  async encoderNaTon(pivoId: string, tonId: string, exigirCalibracao = true) {
    const r = await this.prisma.$queryRaw<Array<{ parametros: any }>>`SELECT parametros FROM pivo_config WHERE equipamento_id = ${pivoId}::bpchar LIMIT 1`.catch(() => []);
    const enc = parametrosEncoder(r[0]?.parametros);
    if (!enc.equipamentoId || !enc.resolucao) return null;
    if (exigirCalibracao && !(await calibracaoVigente(this.prisma, pivoId).catch(() => null))) return null;
    const t = await this.prisma.$queryRaw<Array<{ ton: string | null; enc: string | null }>>`
      SELECT (SELECT TRIM(topico_mqtt) FROM equipamentos WHERE id = ${tonId}::bpchar) AS ton,
             (SELECT TRIM(topico_mqtt) FROM equipamentos WHERE id = ${enc.equipamentoId}::bpchar) AS enc`.catch(() => []);
    const ton = t[0]?.ton, et = t[0]?.enc;
    return ton && et && et.startsWith(`${ton}/`) ? enc : null;
  }

  // ------------------------------------------------------------------ plano

  /**
   * `pivo ligar <id8> <d|e> <agua> <permil> <canhao> <g|t> <valor> [f <desliga_em> <liga_em>]`.
   * A TON só enxerga GRAUS (decisão 12/11): voltas = 360 × n; ângulo final = graus até lá no sentido.
   * Sem encoder (provisório, até termos um para teste): tempo estimado. "Sem parada" não existe.
   * Lança Error com a mensagem para o operador quando o plano não vale.
   */
  montarLigar(x: ExecutarNaTon, enc: { resolucao: number | null; invertido: boolean; zero: number } | null): { cmd: string; pararEm: Date | null; parada: string } {
    const irr = x.irr;
    const dir = x.acao === 'girar_direita' ? 'd' : 'e';
    const agua = irr ? !irr.config.semAgua : true;
    const pm = !agua ? 1000 : clamp((irr?.config.percentual ?? 100) * 10, 0, 1000);
    const canhao = agua && irr?.config.canhao ? 1 : 0;
    const p = irr?.parada ?? { tipo: 'semParar' as const };
    let tipo: 'g' | 't', valor: number, pararEm: Date | null = null, parada: string;
    if (p.tipo === 'semParar') throw new Error('Escolha a parada (graus ou voltas): "sem parada" não existe com a sequência na TON.');
    if (enc) {
      if (p.tipo === 'porVoltas') { tipo = 'g'; valor = Math.round(p.voltas * 360); parada = `${p.voltas} volta(s) = ${valor}°`; }
      else if (p.tipo === 'porAngulo') {
        if (x.anguloAtual == null) throw new Error('Sem a posição atual do pivô: não dá para calcular os graus até o ângulo final.');
        // Avanço (direita) = ângulo crescente na calibração; Reverso (esquerda) = decrescente.
        let d = dir === 'd' ? ((p.angulo - x.anguloAtual) % 360 + 360) % 360 : ((x.anguloAtual - p.angulo) % 360 + 360) % 360;
        if (d < 1) d = 360;
        tipo = 'g'; valor = Math.round(d); parada = `até ${p.angulo}° (${valor}° a percorrer)`;
      } else throw new Error('Parada por tempo não existe com a sequência na TON: use graus ou voltas.');
      if (typeof x.restanteParadaMs === 'number') throw new Error('Reinício com parada herdada não existe: desligue e envie uma nova ordem.');
    } else {
      // PROVISÓRIO (sem encoder na TON): a TON para pelo TEMPO estimado.
      let s: number | null = null;
      if (typeof x.restanteParadaMs === 'number') s = Math.round(x.restanteParadaMs / 1000);
      else if (p.tipo === 'porTempo') s = p.minutos * 60;
      else if (irr) { const ms = duracaoParadaMs(irr, x.tempoVolta100h, x.anguloAtual); s = ms ? ms / 1000 : null; }
      if (!s) throw new Error('Sem encoder na TON e sem como estimar o tempo da parada (0 % ou ângulo sem posição).');
      tipo = 't'; valor = clamp(s, 60, 7 * 86400); pararEm = new Date(Date.now() + valor * 1000);
      parada = `${p.tipo === 'porVoltas' ? `${p.voltas} volta(s)` : p.tipo === 'porAngulo' ? `ângulo ${p.angulo}°` : `${p.minutos} min`} por tempo (${Math.round(valor / 60)} min, sem encoder na TON)`;
    }
    // Faixa do canhão (spec 6.4): a da Irrigação (liga → desliga, em graus calibrados) vira bruto do encoder.
    // Canhão LIGADO de "liga" até "desliga" ⇒ DESLIGADO dentro de [desliga, liga].
    let faixa = '';
    const f = canhao && enc ? irr?.config.faixasCanhao?.[0] : undefined;
    if (f) faixa = ` f ${brutoDoAngulo(f.desliga, enc!) % 360} ${brutoDoAngulo(f.liga, enc!) % 360}`;
    return { cmd: `pivo ligar ${idCurto(x.seqId)} ${dir} ${agua ? 1 : 0} ${pm} ${canhao} ${tipo} ${valor}${faixa}`, pararEm, parada };
  }

  // ------------------------------------------------------------------ execução

  /** Executa Ligar / Desligar / Reiniciar pela TON. Nunca lança: termina a linha com fim(). */
  async executar(x: ExecutarNaTon, alvo: AlvoTon): Promise<void> {
    const t = alvo.tonId;
    this.acompanhando.add(t);
    const msgErro = (e: any) => e?.response?.message || e?.message || String(e);
    try {
      if (x.acao === 'desligar' || x.reiniciar) {
        await this.desligar(x, alvo);
        if (x.acao === 'desligar') { await x.fim('concluida'); return; }
        if (x.ctl.cancelar) { await x.fim('interrompida', 'Interrompida pelo Desligar'); return; }
        await x.passo('reinicio', 'Pivô parado — religando com as novas opções', true);
      }
      await this.garantirConfig(x, alvo);
      const plano = this.montarLigar(x, await this.encoderNaTon(x.pivoId, t, false));
      const t0 = Date.now();
      const n0 = this.n;
      try {
        await this.cmd.comandoTon({ equipamentoId: x.pivoId, tonId: t, cmd: plano.cmd, rotulo: 'Ligar (sequência na TON)', ackOk: /^pivo_ligando$/ }, x.user, x.cliente);
      } catch (e) {
        // Recusa da TON vem como 502 "TON não aplicou "<cmd>": <motivo> (…)" — traduz o motivo.
        const m = /não aplicou "[^"]*": (pivo_\w+)/.exec(msgErro(e));
        if (m) { await x.fim('falhou', `A TON não ligou: ${TXT_RECUSA[m[1]] ?? m[1]}`); return; }
        throw e;
      }
      await this.prisma.$executeRaw`
        UPDATE pivo_sequencias SET parar_em = ${plano.pararEm},
          irrigacao = CASE WHEN irrigacao IS NULL THEN NULL ELSE irrigacao || '{"naTon": true}'::jsonb END
        WHERE id = ${x.seqId}`;
      await x.passo('ton', `Plano enviado à TON — parada: ${plano.parada}. A TON executa a sequência sozinha`, true);
      const limiteS = Math.max(5, x.sequencia.pressurizacao_s || 60) + Math.max(5, x.sequencia.confirma_giro_s || 30) + 90;
      const fimLigar = await this.acompanhar(x, alvo, t0, n0, limiteS, (e) => e === 2);
      if (fimLigar === 'cancelado') { await x.fim('interrompida', 'Interrompida pelo Desligar'); return; }
      if (fimLigar === 'ok') { await x.passo('pivo', 'Pivô irrigando — a TON acompanha as paradas e a segurança', true); await x.fim('concluida'); return; }
      await x.fim('falhou', fimLigar);
    } catch (e) {
      await x.fim('falhou', msgErro(e)).catch(() => undefined);
      this.logger.warn(`[pivo-ton] ${x.pivoId} ${x.acao} falhou: ${msgErro(e)}`);
    } finally {
      this.acompanhando.delete(t);
    }
  }

  /** `pivo desligar`: a TON desliga TUDO na hora (spec 6.6) e confirma no ack ("parada executada"). */
  private async desligar(x: ExecutarNaTon, alvo: AlvoTon): Promise<void> {
    const r = await this.cmd.comandoTon({ equipamentoId: x.pivoId, tonId: alvo.tonId, cmd: 'pivo desligar', rotulo: 'Parar (sequência na TON)', ackOk: /^pivo_(parada_executada|ja_parado)$|^already_seen$/ }, x.user, x.cliente);
    await x.passo('ton', r.msg === 'pivo_ja_parado' ? 'TON: pivô já estava parado — saídas do pivô em LOW' : 'Parada executada pela TON: todas as saídas em LOW', true);
    const st = this.status.get(alvo.tonId.trim());
    if (st) st.s = { ...st.s, e: 0, p: 0, f: 'comando_operador', bo: 0, o: '' };   // até o próximo status da TON
  }

  /**
   * Acompanha a TON até `chegou(estado)`: eventos e o passo do status viram passos; falha → texto; sem notícia há 20 s pergunta
   * o estado pelo ack (o status espontâneo do satélite só sai no POLL). 'ok' | 'cancelado' | erro.
   */
  private async acompanhar(x: ExecutarNaTon, alvo: AlvoTon, t0: number, n0: number, limiteS: number, chegou: (e: number) => boolean, desligando = false): Promise<string> {
    const t = alvo.tonId;
    const id8 = idCurto(x.seqId);
    const vistos = new Set<object>();
    const passosVistos = new Set<string>();
    const dir = x.acao === 'girar_esquerda' ? 'E' : 'D';
    /** Passo novo (por evento OU pelo código do status): grava uma vez só. */
    const passoUmaVez = async (txt: string, ok: boolean | null = true) => {
      if (passosVistos.has(txt)) return;
      passosVistos.add(txt);
      await x.passo('ton', txt, ok);
    };
    let ultimaPergunta = Date.now();
    let saiuDoParado = false;
    while (Date.now() - t0 < limiteS * 1000) {
      if (x.ctl.cancelar && !desligando) return 'cancelado';
      for (const ev of (this.eventos.get(t) ?? []).filter((v) => v.n > n0)) {
        if (vistos.has(ev)) continue;
        vistos.add(ev);
        if (!desligando && ev.id && ev.id !== id8 && ev.t !== 'parado') continue;
        if (ev.t === 'passo' && TXT_PASSO[ev.x]) await passoUmaVez(TXT_PASSO[ev.x]);
        else if (ev.t === 'alerta') await x.passo('ton', TXT_AVISO[ev.x] ?? `Alerta da TON: ${ev.x}`, false);
        else if (ev.t === 'parado' && !desligando && !PARADA_NORMAL.has(ev.x)) return `Falha na TON: ${TXT_FALHA[ev.x] ?? ev.x}`;
      }
      const st = this.status.get(t);
      if (st && st.n > n0) {
        if (st.s.e !== 0) saiuDoParado = true;
        const txtN = TXT_PASSO_N[st.s.p]?.(dir);
        if (txtN) await passoUmaVez(txtN);
        if (chegou(st.s.e) && (desligando || st.s.e !== 0)) {
          return 'ok';
        }
        if (!desligando && st.s.e === 0 && saiuDoParado && st.s.f) return `Falha na TON: ${TXT_FALHA[st.s.f] ?? st.s.f}`;
        if (!desligando && st.s.e === 0 && st.s.f && Date.now() - t0 > 3000) return `Falha na TON: ${TXT_FALHA[st.s.f] ?? st.s.f}`;
      }
      // Reserva: o gateway já faz um POLL de confirmação ~3 s depois de cada comando (traz o status
      // do pivô). Perguntar mais vezes satura o LoRa (ack → POLL → ~3 s de resposta) e o próximo
      // comando — o Desligar — colide. Só pergunta se nada chegou há 20 s.
      const ultimaNoticia = Math.max(this.status.get(t)?.em ?? 0, ultimaPergunta);
      if (Date.now() - ultimaNoticia >= 20000) {
        ultimaPergunta = Date.now();
        await this.lerEstadoPeloAck(x.pivoId, t, x.user, x.cliente).catch(() => undefined);
        continue;
      }
      await sleep(700);
    }
    return desligando ? 'A TON não confirmou a parada no tempo' : 'A TON não confirmou o pivô irrigando no tempo';
  }
}
