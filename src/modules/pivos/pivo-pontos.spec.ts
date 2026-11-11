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

  it('canhão sem status: a saída é o canhão (enviado, sem confirmação)', async () => {
    const { svc, saidas } = mantido({});
    expect(await svc.aplicarCanhao('PIV', await svc.pontos('PIV'), true, undefined, undefined, 5)).toBe('enviado');
    expect(saidas).toEqual(['r6 liga']);
  });
});
