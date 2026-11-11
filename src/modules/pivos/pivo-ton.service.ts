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

/** Status compacto publicado pela TON (glue pivo.cpp). */
export interface StatusTon {
  e: number; p: number; f: string; d: string; a: number; pm: number;
  an: number | null; pc: number; al: number; sg: number; bi: number; bo: number; c: number;
}

export interface ExecutarNaTon {
  pivoId: string;
  seqId: string;
  acao: 'girar_direita' | 'girar_esquerda' | 'desligar';
  irr: Irrigacao | null;
  ctl: { cancelar: boolean };
  reiniciar: boolean;
  restanteParadaMs?: number | null;
  sequencia: { pressurizacao_s: number; confirma_giro_s: number; confirma_bomba_s: number };
  cicloPercS: number;
  tempoVolta100h: number;
  anguloAtual: number | null;
  passo: Passo;
  fim: Fim;
  user?: Autor;
  cliente?: ClienteInfo;
}

const ESTADO = ['parado', 'ligando', 'irrigando', 'desligando'] as const;

/** Textos da trilha para os eventos da TON (t:x). */
const TXT_PASSO: Record<string, string> = {
  tensao: 'Conferindo a tensão (BI02)',
  bomba_ligada: 'Bombeamento ON (BO01) e válvula ON — aguardando pressão (BI01)',
  girar_direita: 'Pressão OK — girar direita ON (BO03), aguardando o giro (BI03)',
  girar_esquerda: 'Pressão OK — girar esquerda ON (BO04), aguardando o giro (BI04)',
  girando: 'Giro confirmado',
  percentimetro: 'Percentímetro aplicado (BO05)',
  canhao_ligar: 'Canhão ON (BO06)',
  canhao_desligar: 'Canhão OFF (BO06)',
  canhao_ligado: 'Canhão confirmado ligado (BI06)',
  canhao_desligado: 'Canhão confirmado desligado (BI06)',
  bomba_desligada: 'Bombeamento OFF (BO01) e válvula OFF — aguardando a pressão cair',
  lados_desligados: 'Percentímetro 0 % e lados OFF — aguardando o pivô parar',
};
export const TXT_FALHA: Record<string, string> = {
  sem_tensao: 'Sem tensão (BI02)',
  sem_pressao: 'Sem pressão (BI01) no tempo de pressurização',
  nao_girou: 'O pivô não confirmou o giro (BI03/BI04)',
  seguranca: 'Segurança atuou (desalinhado, BI05)',
  lado_caiu: 'O pivô parou sem comando (girando caiu)',
  sem_posicao: 'Sem leitura do encoder',
  nao_parou: 'O pivô não confirmou a parada (BI03/BI04)',
  reinicio: 'A TON reiniciou com o pivô ligado (queda de energia ou reset)',
  concluido: 'Parada programada atingida',
  comando: 'Desligado por comando',
};
/** Passo em curso no status (pivo::Passo) — o satélite LoRa não manda eventos, só o status/ack. */
const TXT_PASSO_N: Record<number, (dir: string) => string> = {
  1: () => 'Conferindo a tensão (BI02)',
  2: () => 'Bombeamento ON (BO01) e válvula ON — aguardando pressão (BI01)',
  3: (d) => `Pressão OK — girar ${d === 'E' ? 'esquerda ON (BO04), aguardando o giro (BI04)' : 'direita ON (BO03), aguardando o giro (BI03)'}`,
  4: () => 'Bombeamento OFF (BO01) e válvula OFF — aguardando a pressão cair',
  5: () => 'Percentímetro 0 % e lados OFF — aguardando o pivô parar',
};
const TXT_AVISO: Record<string, string> = {
  canhao_nao_ligou: 'O canhão não confirmou ligado (BI06) — segue irrigando',
  canhao_nao_desligou: 'O canhão não confirmou desligado (BI06)',
  pressao_nao_caiu: 'A pressão não caiu depois de desligar a bomba (BI01)',
  salto_posicao: 'Leitura do encoder pulou (ignorada)',
};
const TXT_RECUSA: Record<string, string> = {
  pivo_ja_ligado: 'A TON já está com uma irrigação em curso',
  pivo_pivo_girando: 'O pivô já está girando pelo painel',
  pivo_desalinhado: 'Segurança atuada (desalinhado): a TON não liga',
  pivo_sem_config: 'A TON ainda não recebeu a configuração do pivô',
  pivo_io_incompleto: 'Falta BO de giro, percentímetro ou bombeamento ligada nesta TON',
  pivo_sem_encoder: 'Parada por voltas/ângulo precisa do encoder na mesma TON',
};

/** `pivo enc <resolução> <inv 0/1> <zero°>` — o encoder como a TON guarda (zero com duas casas). */
export function comandoEnc(enc: { resolucao: number | null; invertido: boolean; zero: number }): string {
  return `pivo enc ${enc.resolucao} ${enc.invertido ? 1 : 0} ${Math.round(enc.zero * 100) / 100}`;
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
  private readonly cfgEnviada = new Map<string, string>();
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

  receberStatus(tonId: string, d: any) {
    if (!d || typeof d !== 'object' || typeof d.e !== 'number') return;
    const t = tonId.trim();
    const ant = this.status.get(t)?.s;
    this.status.set(t, { s: d as StatusTon, em: Date.now(), n: ++this.n });
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
    const m = motivo || 'concluido';
    try { this.aoPararSozinho?.(t, m, !['concluido', 'comando', ''].includes(m), id); } catch { /* melhor esforço */ }
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
  statusDaTon(tonId: string): (StatusTon & { estado: string; em: Date }) | null {
    const r = this.status.get(tonId.trim());
    if (!r || Date.now() - r.em > 15 * 60_000) return null;
    return { ...r.s, estado: ESTADO[r.s.e] ?? '?', em: new Date(r.em) };
  }

  /** A TON está com a sequência local ligada (ligando/irrigando/desligando)? */
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
      this.logger.log(`[pivo-ton] TON ${tonId} sem sequência local (${e instanceof Error ? e.message : e}) — segue no servidor`);
      return false;
    }
  }

  /** `pivo status` → ack "pivo_st <e> <p> <permil> <falha|->" (chega mesmo pelo LoRa). */
  async lerEstadoPeloAck(pivoId: string, tonId: string, user?: Autor, cliente?: ClienteInfo): Promise<{ e: number; p: number; pm: number; f: string }> {
    const r = await this.cmd.comandoTon({ equipamentoId: pivoId, tonId, cmd: 'pivo status', rotulo: 'Estado do pivô na TON', ackOk: /^pivo_st /, silencioso: true }, user, cliente);
    const m = /^pivo_st (\d) (\d) (-?\d+) (\S+)/.exec(r.msg);
    if (!m) throw new Error(`resposta inesperada: ${r.msg}`);
    const est = { e: Number(m[1]), p: Number(m[2]), pm: Number(m[3]), f: m[4] === '-' ? '' : m[4] };
    this.suporte.set(tonId, { ok: true, em: Date.now() });
    const ant = this.status.get(tonId)?.s;
    this.status.set(tonId, { s: { ...(ant ?? { d: 'D', a: 1, an: null, pc: 0, al: -1, sg: -1, bi: 0, bo: 0, c: 1 }), e: est.e, p: est.p, pm: est.pm, f: est.f } as StatusTon, em: Date.now(), n: ++this.n });
    return est;
  }

  /** Configuração da TON (io/tempos/enc) — só manda o que mudou desde o último envio aceito. */
  private async garantirConfig(x: ExecutarNaTon, alvo: AlvoTon) {
    const s = x.sequencia;
    const tempos = [
      2,
      clamp(s.pressurizacao_s > 0 ? s.pressurizacao_s : 120, 5, 1800),
      clamp(s.confirma_giro_s || 30, 5, 600),
      clamp(s.confirma_giro_s || 30, 5, 600),
      clamp(s.confirma_bomba_s || 30, 5, 600),
      60,
      0,   // tolerância de queda (pressão/tensão/lado): 0 = desliga na hora (decidido 11/11)
      300, 600,
      clamp(x.cicloPercS || 60, 5, 600),
    ];
    const enc = await this.encoderNaTon(x.pivoId, alvo.tonId);
    const cmds = [
      { cmd: `pivo io ${alvo.bo.join(' ')} ${alvo.bi.join(' ')} ${alvo.inv}`, ok: /^pivo_io_ok$/, rotulo: 'Configuração de I/O do pivô na TON' },
      { cmd: `pivo tempos ${tempos.join(' ')}`, ok: /^pivo_tempos_ok$/, rotulo: 'Tempos de confirmação do pivô na TON' },
      { cmd: enc ? comandoEnc(enc) : 'pivo enc 0 0 0', ok: /^pivo_enc_ok$/, rotulo: 'Encoder do pivô na TON' },
    ];
    const hash = cmds.map((c) => c.cmd).join('|');
    const st = this.statusDaTon(alvo.tonId);
    if (this.cfgEnviada.get(alvo.tonId) === hash && (!st || st.c === 1)) return;
    // (se a TON só aceitar a tolerância de 1 s, o hash não bate e na próxima partida tenta 0 de novo — após regravar, vale 0)
    await x.passo('ton', 'Enviando a configuração do pivô para a TON', null);
    for (const c of cmds) {
      try {
        await this.cmd.comandoTon({ equipamentoId: x.pivoId, tonId: alvo.tonId, cmd: c.cmd, rotulo: c.rotulo, ackOk: c.ok }, x.user, x.cliente);
      } catch (e) {
        // Firmware anterior a 11/11 só aceita tolerância de 1 s pra cima: manda 1 s (o mínimo dele) até regravar.
        const m = e instanceof Error ? e.message : String((e as any)?.response?.message ?? e);
        if (!c.cmd.startsWith('pivo tempos') || !/pivo_tempos_faixa/.test(m + JSON.stringify((e as any)?.response ?? ''))) throw e;
        const t1 = tempos.map((v, i) => (i === 6 ? 1 : v));
        const c1 = `pivo tempos ${t1.join(' ')}`;
        await this.cmd.comandoTon({ equipamentoId: x.pivoId, tonId: alvo.tonId, cmd: c1, rotulo: `${c.rotulo} (firmware antigo: tolerância 1 s)`, ackOk: c.ok }, x.user, x.cliente);
        cmds[1].cmd = c1;
      }
    }
    this.cfgEnviada.set(alvo.tonId, cmds.map((c) => c.cmd).join('|'));   // o que a TON aceitou de fato
    await x.passo('ton', 'Configuração aplicada na TON', true);
  }

  /**
   * A calibração do ângulo (NEXON-103) acabou de gravar `pivo enc` nesta TON: o que estava
   * guardado como "já enviado" deixa de valer e a próxima partida confere a configuração inteira.
   */
  esquecerConfig(tonId: string) {
    this.cfgEnviada.delete(tonId.trim());
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

  /** `pivo ligar <id8> <d|e> <agua> <permil> <canhao> <v|a|t> <valor>` (sem segmentos: não cabe no LoRa). */
  montarLigar(x: ExecutarNaTon, comEncoder: boolean): { cmd: string; pararEm: Date | null; parada: string } {
    const irr = x.irr;
    const dir = x.acao === 'girar_direita' ? 'd' : 'e';
    const agua = irr ? !irr.config.semAgua : true;
    const pm = !agua ? 1000 : clamp((irr?.config.percentual ?? 100) * 10, 0, 1000);
    const canhao = agua && irr?.config.canhao ? 1 : 0;
    const p = irr?.parada ?? { tipo: 'semParar' as const };
    let tipo = 't', valor = '604800', pararEm: Date | null = null, parada = 'sem parada (7 dias no máximo)';
    if (typeof x.restanteParadaMs === 'number') {
      const s = Math.max(60, Math.round(x.restanteParadaMs / 1000));
      tipo = 't'; valor = String(s); pararEm = new Date(Date.now() + s * 1000); parada = `o que faltava (${Math.round(s / 60)} min)`;
    } else if (p.tipo === 'porTempo') {
      const s = clamp(p.minutos * 60, 60, 7 * 86400);
      tipo = 't'; valor = String(s); pararEm = new Date(Date.now() + s * 1000); parada = `${p.minutos} min`;
    } else if ((p.tipo === 'porVoltas' || p.tipo === 'porAngulo') && comEncoder) {
      tipo = p.tipo === 'porVoltas' ? 'v' : 'a';
      valor = String(p.tipo === 'porVoltas' ? Math.round(p.voltas * 100) / 100 : Math.round(p.angulo * 10) / 10);
      parada = p.tipo === 'porVoltas' ? `${p.voltas} volta(s) pelo encoder` : `ângulo ${p.angulo}° pelo encoder`;
    } else if ((p.tipo === 'porVoltas' || p.tipo === 'porAngulo') && irr) {
      // Sem encoder na TON: a TON para pelo TEMPO estimado (tempo de volta a 100 % ÷ percentímetro).
      const ms = duracaoParadaMs(irr, x.tempoVolta100h, x.anguloAtual);
      if (ms) {
        const s = clamp(ms / 1000, 60, 7 * 86400);
        tipo = 't'; valor = String(s); pararEm = new Date(Date.now() + s * 1000);
        parada = `${p.tipo === 'porVoltas' ? `${p.voltas} volta(s)` : `ângulo ${p.angulo}°`} por tempo estimado (${Math.round(s / 60)} min, sem encoder na TON)`;
      }
    }
    return { cmd: `pivo ligar ${idCurto(x.seqId)} ${dir} ${agua ? 1 : 0} ${pm} ${canhao} ${tipo} ${valor}`, pararEm, parada };
  }

  // ------------------------------------------------------------------ execução

  /** Executa Ligar / Desligar / Reiniciar pela TON. Nunca lança: termina a linha com fim(). */
  async executar(x: ExecutarNaTon, alvo: AlvoTon): Promise<void> {
    const t = alvo.tonId;
    this.acompanhando.add(t);
    const msgErro = (e: any) => e?.response?.message || e?.message || String(e);
    try {
      if (x.acao === 'desligar' || x.reiniciar) {
        const ok = await this.desligar(x, alvo);
        if (x.acao === 'desligar') {
          await x.fim(ok === false ? 'falhou' : 'concluida', ok === false ? TXT_FALHA.nao_parou : undefined);
          return;
        }
        if (ok === false) { await x.fim('falhou', `Reinício: ${TXT_FALHA.nao_parou} — não religou`); return; }
        if (x.ctl.cancelar) { await x.fim('interrompida', 'Interrompida pelo Desligar'); return; }
        await x.passo('reinicio', 'Pivô parado — religando com as novas opções', true);
      }
      await this.garantirConfig(x, alvo);
      const comEncoder = !!(await this.encoderNaTon(x.pivoId, t));
      const plano = this.montarLigar(x, comEncoder);
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
      const limiteS = 2 + Math.max(5, x.sequencia.pressurizacao_s || 120) + Math.max(5, x.sequencia.confirma_giro_s || 30) + 90;
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

  /** `pivo desligar` e espera a TON parar. true = parado; false = não confirmou; null = sem retorno. */
  private async desligar(x: ExecutarNaTon, alvo: AlvoTon): Promise<boolean | null> {
    const t0 = Date.now();
    const n0 = this.n;
    const r = await this.cmd.comandoTon({ equipamentoId: x.pivoId, tonId: alvo.tonId, cmd: 'pivo desligar comando', rotulo: 'Desligar (sequência na TON)', ackOk: /^pivo_(desligando|ja_parado|ja_desligando)$/ }, x.user, x.cliente);
    if (r.msg === 'pivo_ja_parado') {
      await x.passo('ton', 'TON: todas as saídas do pivô desligadas', true);
      return true;
    }
    await x.passo('ton', 'Desligar enviado à TON — ela executa a sequência de desligar', true);
    const limiteS = Math.max(5, x.sequencia.confirma_bomba_s || 30) + 60 + 60;
    const res = await this.acompanhar(x, alvo, t0, n0, limiteS, (e) => e === 0, true);
    if (res === 'ok') { await x.passo('pivo', 'Pivô parado (confirmado pela TON)', true); return true; }
    if (res === 'cancelado') return null;
    await x.passo('pivo', res, false);
    return /parada/.test(res) ? false : null;
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
        if (!desligando && ev.id && ev.id !== id8 && ev.t !== 'falha') continue;
        if (ev.t === 'passo' && TXT_PASSO[ev.x]) await passoUmaVez(TXT_PASSO[ev.x]);
        else if (ev.t === 'aviso') await x.passo('ton', TXT_AVISO[ev.x] ?? `Aviso da TON: ${ev.x}`, false);
        else if (ev.t === 'falha' && ev.x !== 'nao_parou' && !desligando) return `Falha na TON: ${TXT_FALHA[ev.x] ?? ev.x}`;
        else if (ev.t === 'falha' && ev.x === 'nao_parou') return TXT_FALHA.nao_parou;
      }
      const st = this.status.get(t);
      if (st && st.n > n0) {
        if (st.s.e !== 0) saiuDoParado = true;
        const txtN = TXT_PASSO_N[st.s.p]?.(dir);
        if (txtN) await passoUmaVez(txtN);
        if (chegou(st.s.e) && (desligando || st.s.e !== 0)) {
          if (desligando && st.s.f === 'nao_parou') return TXT_FALHA.nao_parou;
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
