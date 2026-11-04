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
