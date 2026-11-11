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
  c === 'pivo status' ? 'pivo_st 0 0 -1 -'
  : c.startsWith('pivo io') ? 'pivo_io_ok'
  : c.startsWith('pivo tempos') ? 'pivo_tempos_ok'
  : c.startsWith('pivo enc') ? 'pivo_enc_ok'
  : c.startsWith('pivo ligar') ? 'pivo_ligando'
  : c.startsWith('pivo desligar') ? 'pivo_desligando'
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

  it('montarLigar: tempo, sem parada (7 dias), voltas sem encoder vira tempo estimado, seco = 100 %', () => {
    const { svc } = montar(LAB, respostaPadrao);
    const id = '01KXYZABCDEFGH12345678ABCD';
    const t = svc.montarLigar(exec(id, 'girar_direita', IRR({ tipo: 'porTempo', minutos: 90 })).x as any, false);
    expect(t.cmd).toBe(`pivo ligar ${idCurto(id)} d 1 600 0 t 5400`);
    expect(t.cmd.length).toBeLessThan(60);   // cabe no pacote LoRa com o envelope
    expect(svc.montarLigar(exec(id, 'girar_esquerda', IRR({ tipo: 'semParar' })).x as any, false).cmd).toMatch(/ e 1 600 0 t 604800$/);
    // 1 volta a 60 %: 6 h × 100/60 = 10 h
    expect(svc.montarLigar(exec(id, 'girar_direita', IRR({ tipo: 'porVoltas', voltas: 1 })).x as any, false).cmd).toMatch(/ t 36000$/);
    expect(svc.montarLigar(exec(id, 'girar_direita', IRR({ tipo: 'porVoltas', voltas: 1 })).x as any, true).cmd).toMatch(/ v 1$/);
    expect(svc.montarLigar(exec(id, 'girar_direita', IRR({ tipo: 'porTempo', minutos: 5 }, { semAgua: true, canhao: true })).x as any, false).cmd).toMatch(/ d 0 1000 0 t 300$/);
  });

  it('ligar: manda a configuração uma vez, o plano, e conclui quando a TON reporta irrigando', async () => {
    const { svc, cmds } = montar(LAB, respostaPadrao);
    const alvo = (await svc.alvo('PIV'))!;
    const e = exec('SEQ00000000000000000000AAAA', 'girar_direita', IRR({ tipo: 'porTempo', minutos: 30 }));
    setTimeout(() => {
      svc.receberEvento('T', { t: 'passo', x: 'bomba_ligada', e: 'ligando', id: 'aaaaaaaa'.slice(0, 8) });
      svc.receberEvento('T', { t: 'passo', x: 'bomba_ligada', e: 'ligando', id: idCurto('SEQ00000000000000000000AAAA') });
      svc.receberStatus('T', { e: 2, p: 0, f: '', d: 'D', a: 1, pm: 600, an: null, pc: 0, al: -1, sg: -1, bi: 15, bo: 21, c: 1 });
    }, 300);
    await svc.executar(e.x as any, alvo);
    expect(cmds.filter((c) => /^pivo (io|tempos|enc)/.test(c))).toHaveLength(3);
    expect(cmds).toContain(`pivo ligar ${idCurto('SEQ00000000000000000000AAAA')} d 1 600 0 t 1800`);
    expect(e.passos.some((m) => /Bombeamento ON/.test(m))).toBe(true);
    expect(e.fins).toEqual([['concluida', undefined]]);
    // segunda partida: config igual → não reenvia
    const e2 = exec('SEQ00000000000000000000BBBB', 'girar_direita', IRR({ tipo: 'porTempo', minutos: 30 }));
    setTimeout(() => svc.receberStatus('T', { e: 2, p: 0, f: '', d: 'D', a: 1, pm: 600, an: null, pc: 0, al: -1, sg: -1, bi: 15, bo: 21, c: 1 }), 300);
    await svc.executar(e2.x as any, alvo);
    expect(cmds.filter((c) => /^pivo io/.test(c))).toHaveLength(1);
  });

  it('satélite (sem eventos): os passos saem do código de passo do status', async () => {
    const { svc } = montar(LAB, respostaPadrao);
    const alvo = (await svc.alvo('PIV'))!;
    const e = exec('SEQ00000000000000000000GGGG', 'girar_esquerda', IRR({ tipo: 'porTempo', minutos: 30 }));
    const st = (e_: number, p: number) => ({ e: e_, p, f: '', d: 'E', a: 1, pm: -1, an: null, pc: 0, al: -1, sg: -1, bi: 0, bo: 0, c: 1 });
    setTimeout(() => svc.receberStatus('T', st(1, 2)), 200);
    setTimeout(() => svc.receberStatus('T', st(1, 3)), 1000);
    setTimeout(() => svc.receberStatus('T', st(2, 0)), 1800);
    await svc.executar(e.x as any, alvo);
    expect(e.passos.filter((m) => /Bombeamento ON|girar esquerda ON/.test(m))).toHaveLength(2);
    expect(e.fins).toEqual([['concluida', undefined]]);
  });

  it('ligar: recusa da TON vira mensagem clara', async () => {
    const { svc } = montar(LAB, (c) => (c.startsWith('pivo ligar') ? 'pivo_pivo_girando' : respostaPadrao(c)));
    const alvo = (await svc.alvo('PIV'))!;
    const e = exec('SEQ00000000000000000000CCCC', 'girar_direita', IRR({ tipo: 'porTempo', minutos: 30 }));
    await svc.executar(e.x as any, alvo);
    expect(e.fins).toEqual([['falhou', 'A TON não ligou: O pivô já está girando pelo painel']]);
  });

  it('ligar: falha na TON (sem pressão) encerra a sequência com o motivo', async () => {
    const { svc } = montar(LAB, respostaPadrao);
    const alvo = (await svc.alvo('PIV'))!;
    const e = exec('SEQ00000000000000000000DDDD', 'girar_direita', IRR({ tipo: 'porTempo', minutos: 30 }));
    setTimeout(() => svc.receberEvento('T', { t: 'falha', x: 'sem_pressao', e: 'desligando', id: idCurto('SEQ00000000000000000000DDDD') }), 300);
    await svc.executar(e.x as any, alvo);
    expect(e.fins).toEqual([['falhou', 'Falha na TON: Sem pressão (BI01) no tempo de pressurização']]);
  });

  it('desligar: espera a TON parar; com a sequência local já parada, as saídas caem na hora', async () => {
    const { svc } = montar(LAB, respostaPadrao);
    const alvo = (await svc.alvo('PIV'))!;
    const e = exec('SEQ00000000000000000000EEEE', 'desligar');
    setTimeout(() => {
      svc.receberEvento('T', { t: 'passo', x: 'bomba_desligada', e: 'desligando', id: 'x' });
      svc.receberStatus('T', { e: 0, p: 0, f: '', d: 'D', a: 1, pm: -1, an: null, pc: 0, al: -1, sg: -1, bi: 0, bo: 0, c: 1 });
    }, 300);
    await svc.executar(e.x as any, alvo);
    expect(e.fins).toEqual([['concluida', undefined]]);
    expect(e.passos.some((m) => /Bombeamento OFF/.test(m))).toBe(true);

    const { svc: s2, cmds } = montar(LAB, (c) => (c.startsWith('pivo desligar') ? 'pivo_ja_parado' : respostaPadrao(c)));
    const e2 = exec('SEQ00000000000000000000FFFF', 'desligar');
    await s2.executar(e2.x as any, (await s2.alvo('PIV'))!);
    expect(cmds).toContain('pivo desligar comando');
    expect(e2.fins).toEqual([['concluida', undefined]]);
  });

  it('parada sozinha da TON (sem sequência acompanhando) avisa quem registra na trilha', () => {
    const { svc } = montar(LAB, respostaPadrao);
    const visto: any[] = [];
    svc.aoPararSozinho = (t, m, f) => visto.push([t, m, f]);
    svc.receberEvento('T', { t: 'parado', x: 'concluido', e: 'parado', id: 'abc' });
    svc.receberEvento('T', { t: 'parado', x: 'concluido', e: 'parado', id: 'abc' });   // repetido: avisa 1x
    svc.receberEvento('T2', { t: 'falha', x: 'seguranca', e: 'desligando', id: 'abc' });
    expect(visto).toEqual([['T', 'concluido', false], ['T2', 'seguranca', true]]);
  });

  it('satélite: a ida a PARADO pelo status (sem evento) também avisa, com o motivo da falha', () => {
    const { svc } = montar(LAB, respostaPadrao);
    const visto: any[] = [];
    svc.aoPararSozinho = (t, m, f) => visto.push([t, m, f]);
    const st = (e: number, f = '') => ({ e, p: 0, f, d: 'D', a: 1, pm: 600, an: null, pc: 0, al: -1, sg: -1, bi: 0, bo: 0, c: 1 });
    svc.receberStatus('T', st(2));
    svc.receberStatus('T', st(0, 'sem_pressao'));
    svc.receberStatus('T', st(0, 'sem_pressao'));
    expect(visto).toEqual([['T', 'sem_pressao', true]]);
  });
});
