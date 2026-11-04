import { PivoSequenciaService } from './pivo-sequencia.service';

/**
 * Bomba, solenoide e canhão como pontos do pivô (docs/IOT-PIVO-LIGAR-BOMBA-CANHAO.md):
 * papéis pelo nome, bomba montada pelas BO/BI da Topologia e o canhão que alterna.
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
  { id: 'p-desl-bomba', tipo: 'comando', nome: 'Desligar_bomba' },
  { id: 'p-liga-bomba', tipo: 'comando', nome: 'Ligar_bomba' },
  { id: 'p-valv', tipo: 'comando', nome: 'Valvula' },
  { id: 'p-canhao', tipo: 'comando', nome: 'Canhao' },
  { id: 'p-dir', tipo: 'comando', nome: 'Girar_direita' },
  { id: 's-bomba', tipo: 'status', nome: 'Bomba_ligada', ton_id: 'TON-A', bi: 4, inv: true },
  { id: 's-canhao', tipo: 'status', nome: 'Canhao_ligado', ton_id: 'TON-B', bi: 5 },
  { id: 's-desligado', tipo: 'status', nome: 'Desligado', ton_id: 'TON-B', bi: 3 },
  { id: 's-perm', tipo: 'status', nome: 'Permissivo', ton_id: 'TON-B', bi: 4 },
];

describe('pivô: pontos de bomba, solenoide e canhão', () => {
  it('acha o papel pelo nome — Desligar_bomba não vira o Desligar do pivô', async () => {
    const { svc } = montar(PONTOS, {}, {});
    const pts = await svc.pontos('PIV');
    expect(pts.cmd).toEqual({
      desligar: 'p-desl', bomba_desliga: 'p-desl-bomba', bomba_liga: 'p-liga-bomba',
      valvula: 'p-valv', canhao: 'p-canhao', direita: 'p-dir',
    });
    expect(pts.st.bomba).toEqual({ ton_id: 'TON-A', bi: 4, inv: true });
    expect(pts.st.canhao).toEqual({ ton_id: 'TON-B', bi: 5, inv: false });
    expect(pts.st.desligado).toEqual({ ton_id: 'TON-B', bi: 3, inv: false });
    expect(pts.st.permissivo).toEqual({ ton_id: 'TON-B', bi: 4, inv: false });
  });

  it('bomba dos pontos: cada sinal na sua TON; com Desligar_bomba é botoeira (pulso)', async () => {
    const { svc } = montar(PONTOS, {
      'p-liga-bomba': { ton_id: 'TON-A', bo: 5, pulso_ms: 800 },
      'p-desl-bomba': { ton_id: 'TON-C', bo: 6, pulso_ms: 600 },
    }, {});
    const b = await svc.bombaDosPontos('PIV');
    expect(b).toMatchObject({
      origem: 'pontos', dono_id: 'PIV', modo: 'pulso',
      ton_id: 'TON-A', bo_liga: 5, pulso_ms: 800,
      ton_desliga_id: 'TON-C', bo_desliga: 6, pulso_desliga_ms: 600,
      bi_ton_id: 'TON-A', bi_confirma: 4, bi_inv: true,
    });
  });

  it('sem Desligar_bomba a BO de ligar fica mantida; sem Ligar_bomba ligado a BO não há bomba', async () => {
    const semDesl = PONTOS.filter((p) => p.id !== 'p-desl-bomba');
    const { svc } = montar(semDesl, { 'p-liga-bomba': { ton_id: 'TON-A', bo: 5, pulso_ms: 500 } }, {});
    expect((await svc.bombaDosPontos('PIV')).modo).toBe('mantido');
    const { svc: s2 } = montar(PONTOS, {}, {});
    expect(await s2.bombaDosPontos('PIV')).toBeNull();
  });

  it('Bomba_ligada invertida: BI 0 = ligada', async () => {
    const { svc } = montar(PONTOS, { 'p-liga-bomba': { ton_id: 'TON-A', bo: 5, pulso_ms: 500 } }, { 'TON-A:4': 0 });
    const b = await svc.bombaDosPontos('PIV');
    expect(await svc.bombaLigada(b)).toBe(1);
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
