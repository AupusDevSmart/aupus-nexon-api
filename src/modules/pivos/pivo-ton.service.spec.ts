import { BadGatewayException } from '@nestjs/common';
import { PivoTonService, idCurto } from './pivo-ton.service';

/** Sequência na TON (Fase 3, docs/IOT-PIVO-TON-LOCAL.md): mapa de I/O, plano e acompanhamento. */

const LAB = [
  { tipo: 'comando', nome: 'Bombeamento', bo_ton: 'T', bo: 1 },
  { tipo: 'comando', nome: 'Valvula', bo_ton: 'T', bo: 2 },
  { tipo: 'comando', nome: 'Girar_direita', bo_ton: 'T', bo: 3 },
  { tipo: 'comando', nome: 'Girar_esquerda', bo_ton: 'T', bo: 4 },
  { tipo: 'comando', nome: 'Percentimetro', bo_ton: 'T', bo: 5 },
  { tipo: 'comando', nome: 'Canhao', bo_ton: 'T', bo: 6 },
  { tipo: 'status', nome: 'Pressao_ok', bi_ton: 'T', bi: 1, inv: false },
  { tipo: 'status', nome: 'Tensao_ok', bi_ton: 'T', bi: 2, inv: false },
  { tipo: 'status', nome: 'Girando_direita', bi_ton: 'T', bi: 3, inv: false },
  { tipo: 'status', nome: 'Girando_esquerda', bi_ton: 'T', bi: 4, inv: false },
  { tipo: 'status', nome: 'Seguranca', bi_ton: 'T', bi: 5, inv: true },
  { tipo: 'status', nome: 'Canhao_ligado', bi_ton: 'T', bi: 6, inv: false },
];

function montar(pontos: any[], resposta: (cmd: string) => string | Error) {
  const cmds: string[] = [];
  const prisma = {
    $queryRaw: jest.fn(async (s: TemplateStringsArray) => {
      const sql = s.join('?');
      if (sql.includes('FROM equipamento_pontos')) return pontos.map((p) => ({ bo_ton: null, bo: null, bi_ton: null, bi: null, inv: null, ...p }));
      return [];
    }),
    $executeRaw: jest.fn(async () => 1),
  };
  const mqtt = { setPivoHooks: jest.fn() };
  const cmd = {
    comandoTon: jest.fn(async (p: { cmd: string; ackOk?: RegExp }) => {
      cmds.push(p.cmd);
      const r = resposta(p.cmd);
      if (r instanceof Error) throw r;
      if (p.ackOk && !p.ackOk.test(r)) throw new BadGatewayException({ message: `TON não aplicou "${p.cmd}": ${r} (firmware sem suporte? regrave a TON)` });
      return { status: 'ok', msg: r, latency_ms: 10 };
    }),
  };
  const svc = new PivoTonService(prisma as any, mqtt as any, cmd as any);
  return { svc, cmds };
}

const respostaPadrao = (c: string) =>
  c === 'pivo status' ? 'pivo_st 0 0 -1 nenhuma a0 r00 i0 x0 o00'
  : c.startsWith('pivo cfg') ? 'pivo_cfg_ok k0000'
  : c.startsWith('pivo ligar') ? 'pivo_ligando'
  : c.startsWith('pivo desligar') ? 'pivo_parada_executada'
  : 'unknown_cmd';

function exec(seqId: string, acao: 'girar_direita' | 'girar_esquerda' | 'desligar', irr: any = null) {
  const passos: string[] = [];
  const fins: Array<[string, string | undefined]> = [];
  return {
    passos, fins,
    x: {
      pivoId: 'PIV', seqId, acao, irr, ctl: { cancelar: false }, reiniciar: false,
      sequencia: { pressurizacao_s: 10, confirma_giro_s: 30, confirma_bomba_s: 30 }, cicloPercS: 60, tempoVolta100h: 6, anguloAtual: null,
      passo: async (_e: string, m: string) => { passos.push(m); },
      fim: async (s: any, e?: string) => { fins.push([s, e]); },
    },
  };
}

/** Status da TON no formato de 12/11 (spec 7.3, compacto). */
const ST = (et: number, p = 0, mo = 0, extra: any = {}) => ({ o: 'x', i: 18, et, p, an: null, gp: 0, al: 360, pm: 600, mo, at: 0, d: 'D', a: 1, bo: 0, ...extra });
const ENC = { resolucao: 360, invertido: false, zero: 0 };
const IRR = (parada: any, extra: any = {}) => ({ modo: 'simples', config: { direcao: 'Avanço', percentual: 60, semAgua: false, canhao: false, ...extra }, parada });

describe('PivoTonService', () => {
  it('alvo: mapa por papel dos pontos do padrão (com polaridade) na TON das BOs', async () => {
    const { svc } = montar(LAB, respostaPadrao);
    expect(await svc.alvo('PIV')).toEqual({ tonId: 'T', bo: [1, 2, 3, 4, 5, 6], bi: [1, 2, 3, 4, 5, 6], inv: '000010' });
  });

  it('alvo: BOs em duas TONs ou firmware antigo (sem "pivo status") → null (segue no servidor)', async () => {
    const duas = LAB.map((p) => (p.nome === 'Canhao' ? { ...p, bo_ton: 'OUTRA' } : p));
    expect(await montar(duas, respostaPadrao).svc.alvo('PIV')).toBeNull();
    const { svc, cmds } = montar(LAB, (c) => (c === 'pivo status' ? 'unknown_cmd' : 'x'));
    expect(await svc.alvo('PIV')).toBeNull();
    expect(await svc.alvo('PIV')).toBeNull();
    expect(cmds.filter((c) => c === 'pivo status')).toHaveLength(1);   // cache: não pergunta de novo
  });

  it('montarLigar com encoder: só GRAUS (voltas × 360; ângulo final → graus no sentido); sem parada e tempo não existem', () => {
    const { svc } = montar(LAB, respostaPadrao);
    const id = '01KXYZABCDEFGH12345678ABCD';
    const m = (acao: any, parada: any, extra: any = {}, ang: number | null = null) => {
      const e = exec(id, acao, IRR(parada, extra)); (e.x as any).anguloAtual = ang;
      return svc.montarLigar(e.x as any, ENC).cmd;
    };
    expect(m('girar_direita', { tipo: 'porVoltas', voltas: 1 })).toBe(`pivo ligar ${idCurto(id)} d 1 600 0 g 360`);
    expect(m('girar_direita', { tipo: 'porVoltas', voltas: 2.5 })).toMatch(/ g 900$/);
    expect(m('girar_direita', { tipo: 'porAngulo', angulo: 100 }, {}, 10)).toMatch(/ g 90$/);
    expect(m('girar_esquerda', { tipo: 'porAngulo', angulo: 350 }, {}, 20)).toMatch(/ e .* g 30$/);
    expect(() => m('girar_direita', { tipo: 'semParar' })).toThrow(/sem parada/);
    expect(() => m('girar_direita', { tipo: 'porTempo', minutos: 30 })).toThrow(/tempo não existe/);
    // canhão com faixa (liga 200 → desliga 100 na calibração): OFF dentro de [100, 200]
    const f = m('girar_direita', { tipo: 'porVoltas', voltas: 1 }, { canhao: true, faixasCanhao: [{ liga: 200, desliga: 100 }] });
    expect(f).toMatch(/ d 1 600 1 g 360 f 100 200$/);
    expect(f.length).toBeLessThan(60);   // cabe no pacote LoRa com o envelope
  });

  it('montarLigar sem encoder (provisório): tempo estimado; sem parada recusado', () => {
    const { svc } = montar(LAB, respostaPadrao);
    const id = '01KXYZABCDEFGH12345678ABCD';
    const m = (parada: any, extra: any = {}) => svc.montarLigar(exec(id, 'girar_direita', IRR(parada, extra)).x as any, null).cmd;
    expect(m({ tipo: 'porTempo', minutos: 90 })).toMatch(/ d 1 600 0 t 5400$/);
    expect(m({ tipo: 'porVoltas', voltas: 1 })).toMatch(/ t 36000$/);   // 6 h × 100/60
    expect(m({ tipo: 'porTempo', minutos: 5 }, { semAgua: true, canhao: true })).toMatch(/ d 0 1000 0 t 300$/);
    expect(() => m({ tipo: 'semParar' })).toThrow(/sem parada/);
  });

  it('ligar: manda a configuração uma vez (tempos novos, encoder bruto), o plano, e conclui com a TON girando', async () => {
    const { svc, cmds } = montar(LAB, respostaPadrao);
    const alvo = (await svc.alvo('PIV'))!;
    const e = exec('SEQ00000000000000000000AAAA', 'girar_direita', IRR({ tipo: 'porTempo', minutos: 30 }));
    setTimeout(() => {
      svc.receberEvento('T', { t: 'passo', x: 'bomba_ligada', e: 'aguardando_pressao', id: 'outraaaa' });
      svc.receberEvento('T', { t: 'passo', x: 'bomba_ligada', e: 'aguardando_pressao', id: idCurto('SEQ00000000000000000000AAAA') });
      svc.receberStatus('T', ST(2));
    }, 300);
    await svc.executar(e.x as any, alvo);
    expect(cmds).toContain('pivo cfg 123456 123456 000010 10 30 5 0 0 0 30 600 60 0');   // um comando só
    expect(cmds).toContain(`pivo ligar ${idCurto('SEQ00000000000000000000AAAA')} d 1 600 0 t 1800`);
    expect(e.passos.filter((m) => /Bombeamento ON/.test(m))).toHaveLength(1);
    expect(e.fins).toEqual([['concluida', undefined]]);
    const e2 = exec('SEQ00000000000000000000BBBB', 'girar_direita', IRR({ tipo: 'porTempo', minutos: 30 }));
    setTimeout(() => svc.receberStatus('T', ST(2)), 300);
    await svc.executar(e2.x as any, alvo);
    expect(cmds.filter((c) => /^pivo cfg/.test(c))).toHaveLength(1);   // config igual: não reenvia
  });

  it('CRC16 igual ao da TON (glue pivo.cpp, conferido no simulador do firmware)', () => {
    const { crc16 } = require('./pivo-ton.service');
    expect(crc16('123456 123456 000000 60 30 5 0 0 0 30 600 60 0')).toBe('FAED');
  });

  it('config: a TON já tem a mesma (CRC no ack do status) → nada é enviado', async () => {
    const args = '123456 123456 000010 10 30 5 0 0 0 30 600 60 0';
    const { crc16 } = require('./pivo-ton.service');
    const { svc, cmds } = montar(LAB, (c) => (c === 'pivo status' ? `pivo_st 0 0 -1 nenhuma a0 k${crc16(args)} r00 i0 x0 o00` : respostaPadrao(c)));
    const alvo = (await svc.alvo('PIV'))!;   // o alvo() pergunta o status e guarda o CRC
    const e = exec('SEQ00000000000000000000HHHH', 'girar_direita', IRR({ tipo: 'porTempo', minutos: 30 }));
    setTimeout(() => svc.receberStatus('T', ST(2)), 300);
    await svc.executar(e.x as any, alvo);
    expect(cmds.filter((c) => /^pivo cfg/.test(c))).toHaveLength(0);
    expect(cmds.filter((c) => /^pivo ligar/.test(c))).toHaveLength(1);
  });

  it('satélite (sem eventos): os passos saem do código de passo do status', async () => {
    const { svc } = montar(LAB, respostaPadrao);
    const alvo = (await svc.alvo('PIV'))!;
    const e = exec('SEQ00000000000000000000GGGG', 'girar_esquerda', IRR({ tipo: 'porTempo', minutos: 30 }));
    setTimeout(() => svc.receberStatus('T', ST(1, 1)), 200);
    setTimeout(() => svc.receberStatus('T', ST(1, 2)), 1000);
    setTimeout(() => svc.receberStatus('T', ST(2, 0)), 1800);
    await svc.executar(e.x as any, alvo);
    expect(e.passos.filter((m) => /Bombeamento ON|girar esquerda ON/i.test(m))).toHaveLength(2);
    expect(e.fins).toEqual([['concluida', undefined]]);
  });

  it('ligar: recusa da TON vira mensagem clara (condição de partida)', async () => {
    const { svc } = montar(LAB, (c) => (c.startsWith('pivo ligar') ? 'pivo_condicao_partida' : respostaPadrao(c)));
    const alvo = (await svc.alvo('PIV'))!;
    const e = exec('SEQ00000000000000000000CCCC', 'girar_direita', IRR({ tipo: 'porTempo', minutos: 30 }));
    await svc.executar(e.x as any, alvo);
    expect(e.fins).toEqual([['falhou', 'A TON não ligou: Condição de partida não OK: tensão (BI02) ou segurança (BI05) em 0']]);
  });

  it('ligar: a TON parou na partida (pressão não subiu) encerra com o motivo', async () => {
    const { svc } = montar(LAB, respostaPadrao);
    const alvo = (await svc.alvo('PIV'))!;
    const e = exec('SEQ00000000000000000000DDDD', 'girar_direita', IRR({ tipo: 'porTempo', minutos: 30 }));
    setTimeout(() => svc.receberStatus('T', ST(1, 1)), 200);
    setTimeout(() => svc.receberStatus('T', ST(0, 0, 4)), 3500);
    await svc.executar(e.x as any, alvo);
    expect(e.fins).toEqual([['falhou', 'Falha na TON: A pressão não subiu no tempo de espera (BI01)']]);
  });

  it('desligar: a TON desliga tudo na hora e confirma no ack', async () => {
    const { svc, cmds } = montar(LAB, respostaPadrao);
    const e = exec('SEQ00000000000000000000EEEE', 'desligar');
    await svc.executar(e.x as any, (await svc.alvo('PIV'))!);
    expect(cmds).toContain('pivo desligar');
    expect(e.passos.some((m) => /Parada executada/.test(m))).toBe(true);
    expect(e.fins).toEqual([['concluida', undefined]]);
  });

  it('parada sozinha da TON (sem sequência acompanhando) avisa quem registra na trilha', () => {
    const { svc } = montar(LAB, respostaPadrao);
    const visto: any[] = [];
    svc.aoPararSozinho = (t, m, f) => visto.push([t, m, f]);
    svc.receberEvento('T', { t: 'parado', x: 'concluida', e: 'parado', id: 'abc' });
    svc.receberEvento('T', { t: 'parado', x: 'concluida', e: 'parado', id: 'abc' });   // repetido: avisa 1x
    svc.receberEvento('T2', { t: 'parado', x: 'seguranca', e: 'parado', id: 'abc' });
    expect(visto).toEqual([['T', 'concluida', false], ['T2', 'seguranca', true]]);
  });

  it('satélite: a ida a PARADO pelo status também avisa, com o motivo; status traz alertas decodificados', () => {
    const { svc } = montar(LAB, respostaPadrao);
    const visto: any[] = [];
    svc.aoPararSozinho = (t, m, f) => visto.push([t, m, f]);
    svc.receberStatus('T', ST(2, 0, 0, { at: 3 }));
    expect(svc.statusDaTon('T')!.alertas).toEqual({ erro_posicao: true, falha_canhao: true, reinicios_repetidos: false });
    svc.receberStatus('T', ST(0, 0, 3));
    svc.receberStatus('T', ST(0, 0, 3));
    expect(visto).toEqual([['T', 'queda_pressao', true]]);
    expect(svc.statusDaTon('T')!.motivo_texto).toBe('Queda de pressão (BI01)');
  });

  it('normalizar: formato posicional do LoRa (s = et,p,i,bo,an,gp,al,pm,mo,at,d,a,o) = mesmo que o JSON com chaves', () => {
    const a = PivoTonService.normalizar({ s: '2,0,63,127,359,90,360,500,7,2,E,1,z5dfmnz1' })!;
    expect(a).toEqual(PivoTonService.normalizar({ o: 'z5dfmnz1', i: 63, et: 2, p: 0, an: 359, gp: 90, al: 360, pm: 500, mo: 7, at: 2, d: 'E', a: 1, bo: 127 }));
    const b = PivoTonService.normalizar({ s: '0,0,16,0,,0,0,-1,11,0,D,1,' })!;
    expect(b).toMatchObject({ e: 0, an: null, pm: -1, f: 'falha_reles', o: '', bi: 16 });
    expect(PivoTonService.normalizar({ s: 'lixo' })).toBeNull();
  });
});
