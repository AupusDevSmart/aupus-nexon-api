import { PivoSequenciaService } from './pivo-sequencia.service';

/**
 * Ligar (bomba), canhão e permissivo como pontos do pivô (docs/IOT-PIVO-LIGAR-BOMBA-CANHAO.md):
 * papéis pelo nome, bomba pelo Ligar/Ligado da Topologia e o canhão que alterna.
 */
type Ponto = { id: string; tipo: 'comando' | 'status'; nome: string; ton_id?: string; bi?: number; inv?: boolean };

function montar(pontos: Ponto[], bos: Record<string, { ton_id: string; bo: number; pulso_ms: number }>, entradas: Record<string, number | null>) {
  const prisma = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('FROM equipamento_pontos')) {
        return pontos.map((p) => ({ id: p.id, tipo: p.tipo, nome: p.nome, ton_id: p.ton_id ?? null, bi: p.bi ?? null, inv: p.inv ?? false }));
      }
      if (sql.includes('FROM ton_bo')) {
        const m = bos[String(vals[0])];
        return m ? [m] : [];
      }
      return [];
    }),
  };
  const acionados: string[] = [];
  const cmd = {
    lerEntradaTon: jest.fn(async (ton: string, bi: number) => ({ valor: entradas[`${ton}:${bi}`] ?? null, updated_at: null })),
    // o botão do canhão alterna o estado lido no Canhao_ligado (TON-B, BI5)
    acionarPonto: jest.fn(async (_eq: string, pid: string) => {
      acionados.push(pid);
      if (pid === 'p-canhao') entradas['TON-B:5'] = entradas['TON-B:5'] === 1 ? 0 : 1;
    }),
  };
  const svc = new PivoSequenciaService(prisma as any, {} as any, cmd as any);
  (svc as any).sleep = async () => undefined;
  return { svc: svc as any, acionados, entradas };
}

const PONTOS: Ponto[] = [
  { id: 'p-desl', tipo: 'comando', nome: 'Desligar' },
  { id: 'p-ligar', tipo: 'comando', nome: 'Ligar' },
  { id: 'p-canhao', tipo: 'comando', nome: 'Canhao' },
  { id: 'p-perc', tipo: 'comando', nome: 'Percentimetro' },
  { id: 'p-dir', tipo: 'comando', nome: 'Girar_direita' },
  { id: 's-ligado', tipo: 'status', nome: 'Ligado', ton_id: 'TON-A', bi: 1, inv: true },
  { id: 's-canhao', tipo: 'status', nome: 'Canhao_ligado', ton_id: 'TON-B', bi: 5 },
  { id: 's-desligado', tipo: 'status', nome: 'Desligado', ton_id: 'TON-B', bi: 3 },
  { id: 's-perm', tipo: 'status', nome: 'Permissivo', ton_id: 'TON-B', bi: 4 },
];

describe('pivô: Ligar (bomba), canhão e permissivo como pontos', () => {
  it('acha o papel pelo nome — Desligar/Desligado e Canhao_ligado não viram Ligar/Ligado', async () => {
    const { svc } = montar(PONTOS, {}, {});
    const pts = await svc.pontos('PIV');
    expect(pts.cmd).toEqual({ desligar: 'p-desl', ligar: 'p-ligar', canhao: 'p-canhao', percentimetro: 'p-perc', direita: 'p-dir' });
    expect(pts.st.ligado).toEqual({ ton_id: 'TON-A', bi: 1, inv: true });
    expect(pts.st.canhao).toEqual({ ton_id: 'TON-B', bi: 5, inv: false });
    expect(pts.st.desligado).toEqual({ ton_id: 'TON-B', bi: 3, inv: false });
    expect(pts.st.permissivo).toEqual({ ton_id: 'TON-B', bi: 4, inv: false });
  });

  it('nomes antigos ainda valem: Ligar_bomba = Ligar, Bomba_ligada = Ligado', async () => {
    const { svc } = montar([
      { id: 'a', tipo: 'comando', nome: 'Ligar_bomba' },
      { id: 'b', tipo: 'status', nome: 'Bomba_ligada', ton_id: 'T', bi: 1 },
    ], {}, {});
    const pts = await svc.pontos('PIV');
    expect(pts.cmd.ligar).toBe('a');
    expect(pts.st.ligado).toEqual({ ton_id: 'T', bi: 1, inv: false });
  });

  it('bomba dos pontos: Ligar = pulso; desliga pelo Desligar do pivô (sem BO própria)', async () => {
    const { svc } = montar(PONTOS, { 'p-ligar': { ton_id: 'TON-A', bo: 1, pulso_ms: 800 } }, {});
    expect(await svc.bombaDosPontos('PIV')).toMatchObject({
      origem: 'pontos', dono_id: 'PIV', modo: 'pulso', ton_id: 'TON-A', bo_liga: 1, pulso_ms: 800,
      bo_desliga: null, bi_ton_id: 'TON-A', bi_confirma: 1, bi_inv: true,
    });
    const { svc: s2 } = montar(PONTOS, {}, {});
    expect(await s2.bombaDosPontos('PIV')).toBeNull();
  });

  it('Ligado invertido: BI 0 = ligada', async () => {
    const { svc } = montar(PONTOS, { 'p-ligar': { ton_id: 'TON-A', bo: 1, pulso_ms: 500 } }, { 'TON-A:1': 0 });
    expect(await svc.bombaLigada(await svc.bombaDosPontos('PIV'))).toBe(1);
  });

  describe('canhão (botão que alterna)', () => {
    it('desligado → um pulso → confirma ligado', async () => {
      const { svc, acionados } = montar(PONTOS, {}, { 'TON-B:5': 0 });
      const pts = await svc.pontos('PIV');
      expect(await svc.aplicarCanhao('PIV', pts, true, undefined, undefined, 10)).toBe('ok');
      expect(acionados).toEqual(['p-canhao']);
    });

    it('já no estado pedido → não pulsa (o pulso inverteria)', async () => {
      const { svc, acionados } = montar(PONTOS, {}, { 'TON-B:5': 1 });
      const pts = await svc.pontos('PIV');
      expect(await svc.aplicarCanhao('PIV', pts, true, undefined, undefined, 10)).toBe('ja');
      expect(acionados).toEqual([]);
    });

    it('sem status ou sem leitura → não comanda às cegas', async () => {
      const semStatus = PONTOS.filter((p) => p.id !== 's-canhao');
      const a = montar(semStatus, {}, {});
      expect(await a.svc.aplicarCanhao('PIV', await a.svc.pontos('PIV'), true, undefined, undefined, 10)).toBe('sem_status');
      const b = montar(PONTOS, {}, {});
      expect(await b.svc.aplicarCanhao('PIV', await b.svc.pontos('PIV'), true, undefined, undefined, 10)).toBe('sem_leitura');
      expect([...a.acionados, ...b.acionados]).toEqual([]);
    });

    it('pulsou e o status não mudou → nao_confirmou', async () => {
      const { svc } = montar(PONTOS, {}, { 'TON-B:5': 0 });
      svc.cmd.acionarPonto = jest.fn(async () => undefined);   // painel não respondeu
      const pts = await svc.pontos('PIV');
      expect(await svc.aplicarCanhao('PIV', pts, true, undefined, undefined, 0)).toBe('nao_confirmou');
    });
  });
});

describe('percentímetro com o pivô girando', () => {
  function girando(irr: any, pararEm: Date | null) {
    const { svc } = montar(PONTOS, {}, {});
    const sqls: unknown[][] = [];
    svc.assertPivo = async (id: string) => id;
    svc.prisma.equipamentos = { findFirst: async () => ({ nome: 'PIV', automacao: true }) };
    svc.prisma.$executeRaw = jest.fn(async (_s: TemplateStringsArray, ...v: unknown[]) => { sqls.push(v); return 1; });
    svc.irrigacaoAtiva = async () => (irr ? { id: 'SEQ', acao: 'girar_direita', irrigacao: irr, parar_em: pararEm, usuario_id: null, created_at: new Date() } : null);
    svc.percentimetro = jest.fn(async () => ({ bo: 5, cicloS: 60 }));
    svc.parametrosPercentimetro = async () => ({ lamina100: 3.58, cicloS: 60 });
    svc.trilha = jest.fn(async () => undefined);
    return { svc, sqls };
  }
  const irr = (pct: number, parada: any = { tipo: 'porVoltas', voltas: 1 }, semAgua = false) =>
    ({ config: { direcao: 'Avanço', percentual: pct, semAgua, canhao: false }, parada });

  it('manda o perc novo e reescala a parada por voltas (50 % → 100 % = metade do que falta)', async () => {
    const em = new Date(Date.now() + 2 * 3600000);
    const { svc, sqls } = girando(irr(50), em);
    const r = await svc.ajustarPercentimetro('PIV', { percentual: 100 });
    expect(svc.percentimetro).toHaveBeenCalledWith('PIV', expect.anything(), 1000, undefined, undefined);
    expect(r.percentual).toBe(100);
    const resta = (r.parar_em as Date).getTime() - Date.now();
    expect(Math.abs(resta - 3600000)).toBeLessThan(5000);
    expect(JSON.parse(String(sqls[0][0])).config.percentual).toBe(100);
  });

  it('por tempo a parada não muda; por lâmina calcula o %', async () => {
    const em = new Date(Date.now() + 3600000);
    const { svc } = girando(irr(80, { tipo: 'porTempo', minutos: 60 }), em);
    const r = await svc.ajustarPercentimetro('PIV', { lamina: 7.16 });
    expect(r.percentual).toBe(50);
    expect(r.parar_em).toBe(em);
  });

  it('recusa: parado, sem água ou mesmo valor — sem comando', async () => {
    for (const [i, msg] of [[null, /não está irrigando/], [irr(100, undefined, true), /sem água/], [irr(36), /já está em 36/]] as const) {
      const { svc } = girando(i, null);
      await expect(svc.ajustarPercentimetro('PIV', { percentual: 36 })).rejects.toThrow(msg);
      expect(svc.percentimetro).not.toHaveBeenCalled();
    }
  });
});

describe('desligar: perc off depois de concluir', () => {
  it('a sequência fica concluída antes do perc off e a trava só sai depois do ack', async () => {
    const { svc } = montar(PONTOS, { 'p-perc': { ton_id: 'TON-B', bo: 5, pulso_ms: 500 } }, { 'TON-B:3': 1 });
    const ordem: string[] = [];
    svc.lerConfig = async () => ({ bombeamento: null, bomba_de: null, sequencia: { pressurizacao_s: 0, confirma_giro_s: 5, confirma_bomba_s: 5 } });
    svc.prisma.$executeRaw = jest.fn(async (s: TemplateStringsArray) => { if (s.join('?').includes('status =')) ordem.push('concluida'); return 1; });
    svc.cmd.comandoTon = jest.fn(async (o: { cmd: string }) => { ordem.push(o.cmd); expect(ctl.finalizando).toBe(true); });
    const ctl: { seqId: string; cancelar: boolean; finalizando?: boolean } = { seqId: 'S', cancelar: false };
    await svc.executar('PIV', 'desligar', ctl);
    expect(ordem).toEqual(['concluida', 'perc off']);
  });
});

describe('saídas mantidas (sequencia.comandos_mantidos)', () => {
  // Painel sem selo (TON no lugar do CLP): cada BO fica em alto enquanto a função está ligada.
  const PTS: Ponto[] = [
    { id: 'p-ligar', tipo: 'comando', nome: 'Ligar' },
    { id: 'p-dir', tipo: 'comando', nome: 'Girar_direita' },
    { id: 'p-esq', tipo: 'comando', nome: 'Girar_esquerda' },
    { id: 'p-canhao', tipo: 'comando', nome: 'Canhao' },
    { id: 's-dir', tipo: 'status', nome: 'Girando_direita', ton_id: 'T', bi: 2 },
    { id: 's-esq', tipo: 'status', nome: 'Girando_esquerda', ton_id: 'T', bi: 3 },
  ];
  const BOS = {
    'p-ligar': { ton_id: 'T', bo: 1, pulso_ms: 500 },
    'p-dir': { ton_id: 'T', bo: 2, pulso_ms: 500 },
    'p-esq': { ton_id: 'T', bo: 3, pulso_ms: 500 },
    'p-canhao': { ton_id: 'T', bo: 6, pulso_ms: 500 },
  };
  function mantido(entradas: Record<string, number | null>) {
    const m = montar(PTS, BOS, entradas);
    const q = m.svc.prisma.$queryRaw;
    m.svc.prisma.$queryRaw = jest.fn(async (s: TemplateStringsArray, ...v: unknown[]) =>
      (s.join('?').includes('comandos_mantidos') ? [{ m: true }] : q(s, ...v)));
    m.svc.prisma.$executeRaw = jest.fn(async () => 1);
    const saidas: string[] = [];
    m.svc.cmd.acionarBoDireto = jest.fn(async (p: { bo: number; modo: string }) => {
      saidas.push(`r${p.bo} ${p.modo}`);
      if (p.bo === 2) entradas['T:2'] = p.modo === 'liga' ? 1 : 0;   // o pivô responde no Girando
      if (p.bo === 3) entradas['T:3'] = p.modo === 'liga' ? 1 : 0;
    });
    m.svc.cmd.lerEntradaTon = jest.fn(async (ton: string, bi: number) => ({ valor: entradas[`${ton}:${bi}`] ?? null, updated_at: null }));
    const seq = { pressurizacao_s: 0, confirma_giro_s: 5, confirma_bomba_s: 5, comandos_mantidos: true };
    m.svc.lerConfig = async () => ({ bombeamento: await m.svc.bombaDosPontos('PIV'), bomba_de: null, sequencia: seq });
    m.svc.companheiros = async () => [];
    return { ...m, saidas };
  }

  it('bomba dos pontos vira modo mantido', async () => {
    const { svc } = mantido({});
    expect(await svc.bombaDosPontos('PIV')).toMatchObject({ modo: 'mantido', bo_liga: 1 });
  });

  it('girar: Ligar em alto, o outro sentido em baixo ANTES, este em alto — sem pulso', async () => {
    const { svc, saidas, acionados } = mantido({ 'T:2': 0, 'T:3': 0 });
    await svc.executar('PIV', 'girar_direita', { seqId: 'S', cancelar: false });
    expect(saidas).toEqual(['r1 liga', 'r3 desliga', 'r2 liga']);
    expect(acionados).toEqual([]);
  });

  it('desligar sem ponto Desligar: baixa os dois sentidos, o canhão e o Ligar', async () => {
    const { svc, saidas, acionados } = mantido({ 'T:2': 1, 'T:3': 0 });
    await svc.executar('PIV', 'desligar', { seqId: 'S', cancelar: false });
    expect(saidas).toEqual(['r2 desliga', 'r3 desliga', 'r6 desliga', 'r1 desliga']);
    expect(acionados).toEqual([]);
  });

  // NEXON-98 — "Salvar e enviar" com o pivô ligado: desliga inteiro e só então liga com as novas opções.
  it('reiniciar: o Desligar inteiro primeiro, depois a partida no novo sentido', async () => {
    const { svc, saidas } = mantido({ 'T:2': 1, 'T:3': 0 });
    await svc.executar('PIV', 'girar_esquerda', { seqId: 'S', cancelar: false }, undefined, undefined, null, { reiniciar: true });
    expect(saidas).toEqual(['r2 desliga', 'r3 desliga', 'r6 desliga', 'r1 desliga', 'r1 liga', 'r2 desliga', 'r3 liga']);
    const status = svc.prisma.$executeRaw.mock.calls.map((c: unknown[]) => c[1]);
    expect(status).toContain('concluida');
    expect(status).not.toContain('falhou');
  });

  it('reiniciar: parada não confirmada NÃO religa e a sequência falha', async () => {
    const entradas: Record<string, number | null> = { 'T:2': 1, 'T:3': 0 };
    const { svc } = mantido(entradas);
    const saidas: string[] = [];
    // o pivô não responde: o Girando continua em 1 depois de baixar a saída
    svc.cmd.acionarBoDireto = jest.fn(async (p: { bo: number; modo: string }) => { saidas.push(`r${p.bo} ${p.modo}`); });
    const seq = { pressurizacao_s: 0, confirma_giro_s: 0, confirma_bomba_s: 0, comandos_mantidos: true };
    svc.lerConfig = async () => ({ bombeamento: await svc.bombaDosPontos('PIV'), bomba_de: null, sequencia: seq });
    await svc.executar('PIV', 'girar_esquerda', { seqId: 'S', cancelar: false }, undefined, undefined, null, { reiniciar: true });
    expect(saidas.filter((x) => x.endsWith(' liga'))).toEqual([]);
    const chamadas = svc.prisma.$executeRaw.mock.calls as unknown[][];
    expect(chamadas.some((c) => c[1] === 'falhou' && /não confirmou a parada/.test(String(c[2])))).toBe(true);
  });

  it('reiniciar: Desligar no meio interrompe e não religa', async () => {
    const { svc, saidas } = mantido({ 'T:2': 1, 'T:3': 0 });
    const ctl = { seqId: 'S', cancelar: false };
    const base = svc.cmd.acionarBoDireto;
    // o operador manda Desligar enquanto o reinício ainda está parando o pivô
    svc.cmd.acionarBoDireto = jest.fn(async (p: { bo: number; modo: string }) => { await base(p); ctl.cancelar = true; });
    await svc.executar('PIV', 'girar_esquerda', ctl, undefined, undefined, null, { reiniciar: true });
    expect(saidas.filter((x) => x.endsWith(' liga'))).toEqual([]);
    expect(svc.prisma.$executeRaw.mock.calls.map((c: unknown[]) => c[1])).toContain('interrompida');
  });

  it('reiniciar: comando recusado antes de sair (broker fora) cancela a linha e o pivô segue como estava', async () => {
    const { svc } = mantido({ 'T:2': 1, 'T:3': 0 });
    const saidas: string[] = [];
    svc.cmd.acionarBoDireto = jest.fn(async (p: { bo: number; modo: string }) => { saidas.push(`r${p.bo} ${p.modo}`); throw Object.assign(new Error('Broker MQTT fora'), { status: 503 }); });
    svc.trilha = jest.fn(async () => undefined);
    await svc.executar('PIV', 'girar_esquerda', { seqId: 'S', cancelar: false }, undefined, undefined, null, { reiniciar: true });
    expect(saidas).toEqual(['r2 desliga']);   // nada saiu: sem nova tentativa, sem bomba, sem religar
    const status = svc.prisma.$executeRaw.mock.calls.map((c: unknown[]) => c[1]);
    expect(status).toContain('cancelada');
    expect(status).not.toContain('falhou');
    expect(svc.trilha).toHaveBeenCalledWith('PIV', expect.stringMatching(/Reinício NÃO executou.*segue com a irrigação anterior/), null, 'manual', 'ALTA');
  });

  it('reiniciar: timeout na parada com o pivô ainda girando NÃO mexe na bomba e cancela a linha', async () => {
    const { svc } = mantido({ 'T:2': 1, 'T:3': 0 });
    const saidas: string[] = [];
    // ack perdido e o pivô não parou: o Girando segue em 1
    svc.cmd.acionarBoDireto = jest.fn(async (p: { bo: number; modo: string }) => { saidas.push(`r${p.bo} ${p.modo}`); throw Object.assign(new Error('TON não respondeu'), { status: 504 }); });
    svc.trilha = jest.fn(async () => undefined);
    await svc.executar('PIV', 'girar_esquerda', { seqId: 'S', cancelar: false }, undefined, undefined, null, { reiniciar: true });
    expect(saidas).not.toContain('r1 desliga');   // bomba intocada: não gira a seco
    expect(saidas.filter((x) => x.endsWith(' liga'))).toEqual([]);
    const status = svc.prisma.$executeRaw.mock.calls.map((c: unknown[]) => c[1]);
    expect(status).toContain('cancelada');
    expect(svc.trilha).toHaveBeenCalledWith('PIV', expect.stringMatching(/Reinício NÃO executou.*vale a irrigação anterior/), null, 'manual', 'ALTA');
  });

  it('reiniciar: timeout na parada mas o pivô parou (ack perdido) → completa o desligamento, não religa', async () => {
    const entradas: Record<string, number | null> = { 'T:2': 1, 'T:3': 0 };
    const { svc } = mantido(entradas);
    const saidas: string[] = [];
    let primeira = true;
    svc.cmd.acionarBoDireto = jest.fn(async (p: { bo: number; modo: string }) => {
      saidas.push(`r${p.bo} ${p.modo}`);
      if (p.bo === 2) entradas['T:2'] = p.modo === 'liga' ? 1 : 0;   // o comando chegou ao pivô
      if (primeira) { primeira = false; throw Object.assign(new Error('TON não respondeu'), { status: 504 }); }
    });
    svc.trilha = jest.fn(async () => undefined);
    await svc.executar('PIV', 'girar_esquerda', { seqId: 'S', cancelar: false }, undefined, undefined, null, { reiniciar: true });
    expect(saidas).toContain('r1 desliga');       // bomba desligada: pivô parado não fica com bomba ligada
    expect(saidas.filter((x) => x.endsWith(' liga'))).toEqual([]);
    const status = svc.prisma.$executeRaw.mock.calls.map((c: unknown[]) => c[1]);
    expect(status).toContain('falhou');
    expect(status).not.toContain('cancelada');
    expect(svc.trilha).toHaveBeenCalledWith('PIV', expect.stringMatching(/Reinício falhou no meio da parada.*ficou desligado/), null, 'manual', 'ALTA');
  });

  it('reiniciar: parada herdada vale o que faltava, não recomeça do zero', async () => {
    const { svc } = mantido({ 'T:2': 1, 'T:3': 0 });
    const irr = { modo: 'simples', config: { direcao: 'Reverso', percentual: 50, semAgua: true, canhao: false }, parada: { tipo: 'porVoltas', voltas: 1 } };
    const antes = Date.now();
    await svc.executar('PIV', 'girar_esquerda', { seqId: 'S', cancelar: false }, undefined, undefined, irr, { reiniciar: true, restanteParadaMs: 3600000 });
    const pararEm = (svc.prisma.$executeRaw.mock.calls as unknown[][]).map((c) => c[1]).find((v) => v instanceof Date) as Date;
    expect(pararEm.getTime() - antes).toBeGreaterThanOrEqual(3600000);
    expect(pararEm.getTime() - antes).toBeLessThan(3600000 + 60000);   // 1 volta do zero seriam 21 h
  });

  it('Desligar direto no ponto com sequência em andamento: interrompe e completa o desligamento', async () => {
    const { svc } = montar(PONTOS, {}, {});
    const ctl = { seqId: 'S', cancelar: false };
    svc.rodando.set('PIV', ctl);
    svc.acionar = jest.fn(async () => ({ status: 'executando' }));
    // outro ponto do pivô não interrompe nada
    await svc.pontoExterno('antes', 'PIV', 'p-canhao');
    expect(ctl.cancelar).toBe(false);
    await svc.pontoExterno('depois', 'PIV', 'p-canhao');
    expect(svc.acionar).not.toHaveBeenCalled();
    // o Desligar interrompe antes do pulso e, depois dele, roda o desligar inteiro
    await svc.pontoExterno('antes', 'PIV ', 'p-desl');
    expect(ctl.cancelar).toBe(true);
    await svc.pontoExterno('depois', 'PIV', 'p-desl', { id: 'U1' });
    expect(svc.acionar).toHaveBeenCalledWith('PIV', 'desligar', { id: 'U1' }, undefined, expect.objectContaining({ motivo: expect.stringMatching(/direto no ponto/) }));
    // Ligar direto no ponto com a sequência rodando é recusado (cruzaria com a partida do servidor)
    svc.rodando.set('PIV', { seqId: 'S2', cancelar: false });
    await expect(svc.pontoExterno('antes', 'PIV', 'p-ligar')).rejects.toThrow(/Sequência do pivô em andamento/);
    // sem sequência em andamento, o Desligar no ponto segue como sempre foi
    svc.rodando.delete('PIV');
    svc.acionar.mockClear();
    await svc.pontoExterno('antes', 'PIV', 'p-desl');
    await svc.pontoExterno('depois', 'PIV', 'p-desl');
    expect(svc.acionar).not.toHaveBeenCalled();
  });

  describe('acionar com reiniciar', () => {
    const NOVA = { modo: 'simples', config: { direcao: 'Reverso', percentual: 80, semAgua: false, canhao: false }, parada: { tipo: 'semParar' } };
    function acionavel(entradas: Record<string, number | null>, ativa: unknown = null) {
      const m = mantido(entradas);
      m.svc.assertPivo = async () => 'PIV';
      m.svc.prisma.equipamentos = { findFirst: async () => ({ nome: 'Pivô 1', automacao: true }) };
      m.svc.lerPonta = async () => null;
      m.svc.irrigacaoAtiva = jest.fn(async () => ativa);
      m.svc.trilha = jest.fn(async () => undefined);
      m.svc.executar = jest.fn(async () => undefined);
      return m;
    }

    it('pivô parado: recusa (é um Ligar comum) e nada executa', async () => {
      const { svc } = acionavel({ 'T:2': 0, 'T:3': 0 });
      await expect(svc.acionar('PIV', 'girar_esquerda', undefined, undefined, { irrigacao: NOVA, reiniciar: true })).rejects.toThrow(/não está ligado/);
      expect(svc.executar).not.toHaveBeenCalled();
    });

    it('recusa início agendado, falta das opções e o desligar', async () => {
      const { svc } = acionavel({ 'T:2': 1, 'T:3': 0 });
      const futuro = new Date(Date.now() + 3600000).toISOString();
      await expect(svc.acionar('PIV', 'girar_esquerda', undefined, undefined, { irrigacao: { ...NOVA, inicio: futuro }, reiniciar: true })).rejects.toThrow(/sempre agora/);
      await expect(svc.acionar('PIV', 'girar_esquerda', undefined, undefined, { reiniciar: true })).rejects.toThrow(/novas opções/);
      await expect(svc.acionar('PIV', 'desligar', undefined, undefined, { reiniciar: true })).rejects.toThrow(/só para girar/);
      expect(svc.executar).not.toHaveBeenCalled();
    });

    it('sem jeito de parar o pivô (sem Desligar e sem saídas mantidas): recusa antes de qualquer comando', async () => {
      const { svc, saidas } = acionavel({ 'T:2': 1, 'T:3': 0 });
      const seq = { pressurizacao_s: 0, confirma_giro_s: 5, confirma_bomba_s: 5, comandos_mantidos: false };
      svc.lerConfig = async () => ({ bombeamento: null, bomba_de: null, sequencia: seq });
      await expect(svc.acionar('PIV', 'girar_esquerda', undefined, undefined, { irrigacao: NOVA, reiniciar: true })).rejects.toThrow(/Desligar cadastrado/);
      expect(saidas).toEqual([]);
      expect(svc.executar).not.toHaveBeenCalled();
    });

    it('girando: grava a trilha antes → depois e executa com reiniciar', async () => {
      const ativa = { id: 'A', acao: 'girar_direita', irrigacao: { modo: 'simples', config: { direcao: 'Avanço', percentual: 60, semAgua: false, canhao: false }, parada: { tipo: 'semParar' } }, parar_em: null };
      const { svc } = acionavel({ 'T:2': 1, 'T:3': 0 }, ativa);
      const r = await svc.acionar('PIV', 'girar_esquerda', { id: 'U1' }, { dispositivo: 'Chrome no Windows' }, { irrigacao: NOVA, reiniciar: true });
      expect(r.status).toBe('executando');
      expect(svc.trilha).toHaveBeenCalledWith('PIV', expect.stringMatching(/^Reiniciar com novas opções · Direita · 60% .* → Esquerda · 80%/), 'U1', 'manual', 'INFO', 'Chrome no Windows');
      expect(svc.executar.mock.calls[0][6]).toEqual({ reiniciar: true, restanteParadaMs: undefined, paraSemGiro: false, origem: 'manual' });
    });

    it('manterParada: parada por tempo da programação segue com o que falta', async () => {
      const ativa = {
        id: 'A', acao: 'girar_direita', parar_em: new Date(Date.now() + 30 * 60000),
        irrigacao: { modo: 'programacao', config: { direcao: 'Avanço', percentual: 60, semAgua: false, canhao: false }, parada: { tipo: 'porTempo', minutos: 480 }, programacao: { id: 'P', nome: 'Noite' } },
      };
      const { svc } = acionavel({ 'T:2': 1, 'T:3': 0 }, ativa);
      await svc.acionar('PIV', 'girar_esquerda', undefined, undefined, { irrigacao: NOVA, reiniciar: true, manterParada: true });
      const [, , , , , irr, extra] = svc.executar.mock.calls[0];
      expect(irr.parada).toEqual({ tipo: 'porTempo', minutos: 480 });
      expect(irr.programacao).toEqual({ id: 'P', nome: 'Noite' });
      expect(extra.restanteParadaMs).toBeGreaterThan(29 * 60000);
      expect(extra.restanteParadaMs).toBeLessThanOrEqual(30 * 60000);
    });

    it('manterParada: por voltas, o que falta anda na velocidade nova', async () => {
      const ativa = {
        id: 'A', acao: 'girar_direita', parar_em: new Date(Date.now() + 60 * 60000),
        irrigacao: { modo: 'simples', config: { direcao: 'Avanço', percentual: 40, semAgua: false, canhao: false }, parada: { tipo: 'porVoltas', voltas: 1 } },
      };
      const { svc } = acionavel({ 'T:2': 1, 'T:3': 0 }, ativa);
      await svc.acionar('PIV', 'girar_esquerda', undefined, undefined, { irrigacao: NOVA, reiniciar: true, manterParada: true });
      const extra = svc.executar.mock.calls[0][6];
      // 60 min a 40 % → 30 min a 80 %
      expect(Math.round(extra.restanteParadaMs / 60000)).toBe(30);
    });

    it('manterParada: voltas já vencidas param em 1 min, nunca recomeçam do zero', async () => {
      const ativa = {
        id: 'A', acao: 'girar_direita', parar_em: new Date(Date.now() - 5000),
        irrigacao: { modo: 'simples', config: { direcao: 'Avanço', percentual: 40, semAgua: false, canhao: false }, parada: { tipo: 'porVoltas', voltas: 3 } },
      };
      const { svc } = acionavel({ 'T:2': 1, 'T:3': 0 }, ativa);
      await svc.acionar('PIV', 'girar_esquerda', undefined, undefined, { irrigacao: NOVA, reiniciar: true, manterParada: true });
      expect(svc.executar.mock.calls[0][6].restanteParadaMs).toBe(60000);
      // parar_em provisório vai na linha, para a ponta que começar no meio do reinício
      const insert = (svc.prisma.$executeRaw.mock.calls as unknown[][]).find((c) => (c[0] as string[]).join('?').includes('INSERT INTO pivo_sequencias'))!;
      expect(insert[insert.length - 1]).toBeInstanceOf(Date);
    });

    it('dois pedidos juntos: só um vira sequência', async () => {
      const { svc } = acionavel({ 'T:2': 1, 'T:3': 0 });
      let soltar: () => void = () => undefined;
      svc.executar = jest.fn(() => new Promise<void>((ok) => { soltar = ok; }));
      const r = await Promise.allSettled([
        svc.acionar('PIV', 'girar_esquerda', undefined, undefined, { irrigacao: NOVA, reiniciar: true }),
        svc.acionar('PIV', 'girar_esquerda', undefined, undefined, { irrigacao: NOVA, reiniciar: true }),
      ]);
      soltar();
      expect(r.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(svc.executar).toHaveBeenCalledTimes(1);
    });
  });

  it('canhão sem status: a saída é o canhão (enviado, sem confirmação)', async () => {
    const { svc, saidas } = mantido({});
    expect(await svc.aplicarCanhao('PIV', await svc.pontos('PIV'), true, undefined, undefined, 5)).toBe('enviado');
    expect(saidas).toEqual(['r6 liga']);
  });
});

// NEXON-98 — "Parado" em pivô SEM o ponto Percentímetro (PIVO 1/2/3 do Chimarrão): liga só a
// bomba e não manda girar. O status do pivô segue "parado"; quem diz que está irrigando é a bomba.
describe('irrigando parado sem o ponto Percentímetro (só a bomba)', () => {
  const PTS: Ponto[] = [
    { id: 'p-desl', tipo: 'comando', nome: 'Desligar' },
    { id: 'p-dir', tipo: 'comando', nome: 'Girar_direita' },
    { id: 'p-esq', tipo: 'comando', nome: 'Girar_esquerda' },
    { id: 's-desl', tipo: 'status', nome: 'Desligado', ton_id: 'T', bi: 1 },
    { id: 's-dir', tipo: 'status', nome: 'Girando_direita', ton_id: 'T', bi: 2 },
    { id: 's-esq', tipo: 'status', nome: 'Girando_esquerda', ton_id: 'T', bi: 3 },
  ];
  const BOS = { 'p-desl': { ton_id: 'T', bo: 4, pulso_ms: 500 }, 'p-dir': { ton_id: 'T', bo: 2, pulso_ms: 500 }, 'p-esq': { ton_id: 'T', bo: 3, pulso_ms: 500 } };
  const BOMBA = { origem: 'legado', ton_id: 'TB', modo: 'pulso', bo_liga: 1, bo_desliga: 2, bi_confirma: 1, confirma_s: 0, pulso_ms: 500 };
  const SEQ = { pressurizacao_s: 0, confirma_giro_s: 0, confirma_bomba_s: 0, comandos_mantidos: false };
  const PARADO = { modo: 'simples', config: { direcao: 'Avanço', percentual: 0, semAgua: false, canhao: false, semGiro: true }, parada: { tipo: 'porTempo', minutos: 60 } };

  /** Pivô parado (Desligado=1), bomba legada na TON "TB" (BO1 liga, BO2 desliga, BI1 confirma). */
  function pivo(entradas: Record<string, number | null> = {}, ultima: unknown = null) {
    const e = { 'T:1': 1, 'T:2': 0, 'T:3': 0, ...entradas };
    const m = montar(PTS, BOS, e);
    const q = m.svc.prisma.$queryRaw;
    m.svc.prisma.$queryRaw = jest.fn(async (s: TemplateStringsArray, ...v: unknown[]) => {
      const sql = s.join('?');
      if (sql.includes('FROM pivo_sequencias') && sql.includes('ORDER BY created_at DESC')) return ultima ? [ultima] : [];
      if (sql.includes('count(*)')) return [{ n: 0 }];
      return q(s, ...v);
    });
    m.svc.prisma.$executeRaw = jest.fn(async () => 1);
    const saidas: string[] = [];
    m.svc.cmd.acionarBoDireto = jest.fn(async (p: { tonId: string; bo: number; modo: string }) => {
      saidas.push(`${p.tonId} r${p.bo} ${p.modo}`);
      if (p.tonId === 'TB' && p.bo === 1) e['TB:1'] = 1;   // a bomba responde na BI
      if (p.tonId === 'TB' && p.bo === 2) e['TB:1'] = 0;
    });
    m.svc.lerConfig = async () => ({ bombeamento: BOMBA, bomba_de: null, sequencia: SEQ });
    m.svc.companheiros = async () => [];
    m.svc.trilha = jest.fn(async () => undefined);
    return { ...m, saidas, e };
  }
  const linha = (x: Record<string, unknown> = {}) => ({ id: 'S1', acao: 'girar_direita', status: 'concluida', irrigacao: PARADO, parar_em: null, usuario_id: null, created_at: new Date(), ...x });

  it('partida: liga a bomba, NÃO manda girar e agenda a parada por tempo', async () => {
    const { svc, saidas, acionados } = pivo({ 'TB:1': 0 });
    await svc.executar('PIV', 'girar_direita', { seqId: 'S', cancelar: false }, undefined, undefined, PARADO);
    expect(saidas).toEqual(['TB r1 pulso']);
    expect(acionados).toEqual([]);   // nenhum comando de giro nem de desligar no pivô
    const args = (svc.prisma.$executeRaw.mock.calls as unknown[][]).map((c) => c[1]);
    expect(args).toContain('concluida');
    expect(args.some((v) => v instanceof Date)).toBe(true);   // parar_em
  });

  it('a irrigação conta como em curso pela bomba, não pelo status do pivô', async () => {
    expect(await pivo({ 'TB:1': 1 }, linha()).svc.irrigacaoAtiva('PIV')).toMatchObject({ id: 'S1' });
    expect(await pivo({ 'TB:1': null }, linha()).svc.irrigacaoAtiva('PIV')).toMatchObject({ id: 'S1' });   // sem leitura: vale o comando
    // um girar comum com o pivô parado segue NÃO sendo irrigação em curso
    const comum = { ...PARADO, config: { ...PARADO.config, percentual: 60, semGiro: undefined } };
    expect(await pivo({ 'TB:1': 1 }, linha({ irrigacao: comum })).svc.irrigacaoAtiva('PIV')).toBeNull();
  });

  it('bomba desligada fora do NexON encerra a irrigação parada — só depois de 1 min seguido desligada', async () => {
    const { svc } = pivo({ 'TB:1': 0 }, linha());
    const inserts = () => (svc.prisma.$executeRaw.mock.calls as unknown[][]).filter((c) => (c[0] as string[]).join('?').includes('INSERT INTO pivo_sequencias'));
    // primeira leitura em 0 (ruído, BI atrasada): segue contando como em curso e nada é gravado
    expect(await svc.irrigacaoAtiva('PIV')).toMatchObject({ id: 'S1' });
    expect(inserts()).toHaveLength(0);
    // 1 min depois, ainda em 0: encerra, amarrado à linha lida
    svc.bombaZeroDesde.set('PIV', { linhaId: 'S1', desde: Date.now() - 61000 });
    expect(await svc.irrigacaoAtiva('PIV')).toBeNull();
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0]).toContain('S1');
    expect(svc.trilha).toHaveBeenCalledWith('PIV', expect.stringMatching(/bomba foi desligada fora do NexON/), null, 'parada', 'WARN');
  });

  it('a bomba voltou a aparecer ligada: a contagem zera', async () => {
    const { svc, e } = pivo({ 'TB:1': 0 }, linha());
    await svc.irrigacaoAtiva('PIV');
    expect(svc.bombaZeroDesde.has('PIV')).toBe(true);
    e['TB:1'] = 1;
    await svc.irrigacaoAtiva('PIV');
    expect(svc.bombaZeroDesde.has('PIV')).toBe(false);
  });

  it('travas: não liga por cima, deixa desligar (mesmo sem BI da bomba) e deixa reiniciar', async () => {
    const { svc } = pivo({ 'TB:1': null }, linha());
    const pts = await svc.pontos('PIV');
    expect(await svc.travaLigar('PIV', pts)).toMatch(/irrigando parado/);
    expect(await svc.travaDesligar('PIV', pts, { bombeamento: BOMBA })).toBeNull();
    expect(await svc.travaReiniciar('PIV', pts)).toBeNull();
    // pivô parado de verdade (sem irrigação): reiniciar segue recusado, desligar também
    const livre = pivo({ 'TB:1': 0 });
    expect(await livre.svc.travaReiniciar('PIV', pts)).toMatch(/não está ligado/);
    expect(await livre.svc.travaDesligar('PIV', pts, { bombeamento: BOMBA })).toMatch(/já está desligado/);
  });

  it('desligar: para a bomba; e a bomba fica ligada se o outro pivô dela está irrigando parado', async () => {
    const a = pivo({ 'TB:1': 1 }, linha());
    await a.svc.executar('PIV', 'desligar', { seqId: 'S', cancelar: false });
    expect(a.saidas).toContain('TB r2 pulso');
    const b = pivo({ 'TB:1': 1 }, linha());
    b.svc.companheiros = async () => [{ id: 'OUTRO', nome: 'PIVO 2' }];   // o companheiro lê a mesma linha: irrigando parado
    const passos: string[] = [];
    await b.svc.desligarBomba('PIV', BOMBA, async (_e: string, m: string) => { passos.push(m); });
    expect(b.saidas).not.toContain('TB r2 pulso');
    expect(passos.join(' ')).toMatch(/Bomba mantida ligada: PIVO 2/);
  });

  const PARANDO = { paraSemGiro: true };

  it('desligar com a TON do pivô sem resposta: a bomba desliga do mesmo jeito', async () => {
    const { svc, saidas } = pivo({ 'TB:1': 1 }, linha());
    svc.cmd.acionarPonto = jest.fn(async () => { throw Object.assign(new Error('TON não respondeu'), { status: 504 }); });
    await svc.executar('PIV', 'desligar', { seqId: 'S', cancelar: false }, undefined, undefined, null, PARANDO);
    expect(saidas).toContain('TB r2 pulso');
    expect((svc.prisma.$executeRaw.mock.calls as unknown[][]).map((c) => c[1])).toContain('concluida');
  });

  it('pivô que pode estar girando: Desligar sem resposta continua abortando, sem mexer na bomba', async () => {
    const { svc, saidas } = pivo({ 'TB:1': 1 });
    svc.cmd.acionarPonto = jest.fn(async () => { throw Object.assign(new Error('TON não respondeu'), { status: 504 }); });
    await svc.executar('PIV', 'desligar', { seqId: 'S', cancelar: false });
    expect(saidas).not.toContain('TB r2 pulso');   // desligar a bomba deixaria o pivô girando a seco
    expect((svc.prisma.$executeRaw.mock.calls as unknown[][]).map((c) => c[1])).toContain('falhou');
  });

  it('bomba que não confirma desligada: o Desligar NÃO conclui, fica na trilha e a irrigação volta a contar', async () => {
    const { svc } = pivo({ 'TB:1': 1 }, linha());
    svc.cmd.acionarBoDireto = jest.fn(async () => undefined);   // o pulso sai, mas a BI segue em 1
    await svc.executar('PIV', 'desligar', { seqId: 'S', cancelar: false }, undefined, undefined, null, { ...PARANDO, origem: 'parada' });
    const args = (svc.prisma.$executeRaw.mock.calls as unknown[][]).map((c) => c[1]);
    expect(args).toContain('cancelada');
    expect(args).not.toContain('concluida');
    expect(svc.trilha).toHaveBeenCalledWith('PIV', expect.stringMatching(/Desligar NÃO concluiu: a bomba não confirmou desligada/), null, 'parada', 'ALTA');
    // não enche a trilha: as tentativas seguintes não gravam outra linha; depois de três, espaça
    await svc.executar('PIV', 'desligar', { seqId: 'S2', cancelar: false }, undefined, undefined, null, PARANDO);
    expect(svc.trilha).toHaveBeenCalledTimes(1);
    expect(svc.podeTentarDesligar('PIV')).toBe(true);
    await svc.executar('PIV', 'desligar', { seqId: 'S3', cancelar: false }, undefined, undefined, null, PARANDO);
    expect(svc.podeTentarDesligar('PIV')).toBe(false);
  });

  it('pivô girando com bomba que não confirma desligada conclui como antes (a retomada da ponta depende disso)', async () => {
    const { svc } = pivo({ 'T:1': 0, 'T:2': 1, 'TB:1': 1 });
    svc.cmd.acionarBoDireto = jest.fn(async () => undefined);
    svc.cmd.acionarPonto = jest.fn(async () => undefined);
    await svc.executar('PIV', 'desligar', { seqId: 'S', cancelar: false });
    const args = (svc.prisma.$executeRaw.mock.calls as unknown[][]).map((c) => c[1]);
    expect(args).toContain('concluida');
    expect(args).not.toContain('cancelada');
  });

  it('desligar de irrigação parada que estoura (TON da bomba sem resposta): não some, volta a contar e avisa', async () => {
    const { svc } = pivo({ 'TB:1': 1 }, linha());
    svc.cmd.acionarBoDireto = jest.fn(async () => { throw Object.assign(new Error('TON da bomba não respondeu'), { status: 504 }); });
    await svc.executar('PIV', 'desligar', { seqId: 'S', cancelar: false }, undefined, undefined, null, PARANDO);
    const args = (svc.prisma.$executeRaw.mock.calls as unknown[][]).map((c) => c[1]);
    expect(args).toContain('cancelada');
    expect(args).not.toContain('falhou');
    expect(svc.trilha).toHaveBeenCalledWith('PIV', expect.stringMatching(/Desligar NÃO concluiu: TON da bomba não respondeu/), null, 'manual', 'ALTA');
  });

  it('a contagem de "bomba desligada" é da linha: sobra de outra irrigação não encerra a nova com uma leitura só', async () => {
    const { svc } = pivo({ 'TB:1': 0 }, linha({ id: 'S9' }));
    svc.bombaZeroDesde.set('PIV', { linhaId: 'S1', desde: Date.now() - 600000 });   // sobra antiga
    expect(await svc.irrigacaoAtiva('PIV')).toMatchObject({ id: 'S9' });
    expect(svc.bombaZeroDesde.get('PIV').linhaId).toBe('S9');
  });

  describe('acionar', () => {
    function acionavel(pontos = PTS, bomba: unknown = BOMBA, bos: Record<string, { ton_id: string; bo: number; pulso_ms: number }> = BOS) {
      const m = montar(pontos, bos, { 'T:1': 1, 'T:2': 0, 'T:3': 0 });
      m.svc.assertPivo = async () => 'PIV';
      m.svc.prisma.equipamentos = { findFirst: async () => ({ nome: 'PIVO 1', automacao: true }) };
      m.svc.prisma.$executeRaw = jest.fn(async () => 1);
      m.svc.lerConfig = async () => ({ bombeamento: bomba, bomba_de: null, sequencia: SEQ });
      m.svc.lerPonta = async () => null;
      m.svc.companheiros = async () => [];
      m.svc.irrigacaoAtiva = jest.fn(async () => null);
      m.svc.trilha = jest.fn(async () => undefined);
      m.svc.executar = jest.fn(async () => undefined);
      return m;
    }
    const pedido = (parada: unknown = { tipo: 'porTempo', minutos: 60 }) => ({ irrigacao: { modo: 'simples', config: { direcao: 'Avanço', percentual: 0, semAgua: false, canhao: true, semGiro: false }, parada } });

    it('sem o ponto Percentímetro: marca "só a bomba" (o servidor decide, não o cliente) e tira o canhão', async () => {
      const { svc } = acionavel();
      await svc.acionar('PIV', 'girar_direita', undefined, undefined, pedido());
      expect(svc.executar.mock.calls[0][5].config).toMatchObject({ percentual: 0, semGiro: true, canhao: false });
      expect(svc.trilha).toHaveBeenCalledWith('PIV', expect.stringMatching(/^Ligar · Parado · Molhado · 60 min/), null, 'manual', 'INFO', undefined);
    });

    it('com o ponto Percentímetro ligado a uma BO: 0 % segue pelo caminho normal (gira com o percentímetro em 0)', async () => {
      const { svc } = acionavel([...PTS, { id: 'p-perc', tipo: 'comando', nome: 'Percentimetro' }], BOMBA, { ...BOS, 'p-perc': { ton_id: 'T', bo: 5, pulso_ms: 500 } });
      await svc.acionar('PIV', 'girar_direita', undefined, undefined, pedido());
      expect(svc.executar.mock.calls[0][5].config.semGiro).toBeUndefined();
    });

    it('ponto Percentímetro cadastrado SEM BO não segura o pivô: vale só a bomba', async () => {
      const { svc } = acionavel([...PTS, { id: 'p-perc', tipo: 'comando', nome: 'Percentimetro' }]);
      await svc.acionar('PIV', 'girar_direita', undefined, undefined, pedido());
      expect(svc.executar.mock.calls[0][5].config.semGiro).toBe(true);
    });

    it('bomba sem confirmação (BI) não irriga parado: o NexON não saberia quando acabou', async () => {
      await expect(acionavel(PTS, { ...BOMBA, bi_confirma: null }).svc.acionar('PIV', 'girar_direita', undefined, undefined, pedido())).rejects.toThrow(/não tem confirmação de ligada/);
    });

    it('recusa parado com parada por ângulo/voltas e parado sem bomba configurada', async () => {
      await expect(acionavel().svc.acionar('PIV', 'girar_direita', undefined, undefined, pedido({ tipo: 'porVoltas', voltas: 1 }))).rejects.toThrow(/não percorre ângulo nem volta/);
      await expect(acionavel(PTS, null).svc.acionar('PIV', 'girar_direita', undefined, undefined, pedido())).rejects.toThrow(/não tem bomba configurada/);
    });
  });
});
