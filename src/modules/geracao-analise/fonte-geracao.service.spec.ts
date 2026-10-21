import { FonteGeracaoService } from './fonte-geracao.service';

/** Prisma falso: responde pela tabela citada no SQL (sem banco). */
function prismaFalso(r: {
  config?: any[]; inversores?: any[]; ton?: any[]; horaria?: any[]; diaria?: any[]; fusion?: any[]; erroConfig?: string;
  provedorFusion?: string[]; contador?: Record<string, number>;
}) {
  const texto = (q: any) => (Array.isArray(q) ? q.join('?') : String(q?.strings?.join('?') ?? q?.sql ?? q));
  return {
    $queryRaw: (q: any) => {
      const t = texto(q);
      const res = (): any[] => {
        if (t.includes('FROM unidade_usina_config')) {
          if (r.erroConfig) throw new Error(r.erroConfig);
          return r.config ?? [];
        }
        if (t.includes('FROM unidade_fv_config')) return (r.provedorFusion ?? []).map((u) => ({ u }));
        if (t.includes('FROM equipamentos e')) return r.inversores ?? [];
        if (t.includes('FROM geracao_horaria_plantas')) return r.horaria ?? [];
        if (t.includes('FROM geracao_diaria_plantas')) return r.diaria ?? [];
        if (t.includes("fonte = 'NUVEM_FUSION'")) {
          if (r.contador) r.contador.fusion = (r.contador.fusion ?? 0) + 1;
          return r.fusion ?? [];
        }
        if (t.includes('FROM equipamentos_dados')) {
          if (r.contador) r.contador.ton = (r.contador.ton ?? 0) + 1;
          return r.ton ?? [];
        }
        return [];
      };
      const p: any = Promise.resolve().then(res);
      return p;
    },
  } as any;
}

// 21/10/2026 12:00 local (15:00 UTC)
const agora = new Date('2026-10-21T15:00:00Z');
const inversores = [{ u: 'U1', id: 'E1', chave: 't/1' }, { u: 'U1', id: 'E2', chave: 't/2' }];
const tonCompleta = (dia: string, y: number) => [
  { eq: 'E1', dia, y, integ: y, blocos: dia === '2026-10-21' ? 24 : 48 },
  { eq: 'E2', dia, y, integ: y, blocos: dia === '2026-10-21' ? 24 : 48 },
];

describe('FonteGeracaoService.porDias (NEXON-37)', () => {
  it('ontem: TON completa e diário da nuvem concordam → ton', async () => {
    const s = new FonteGeracaoService(prismaFalso({
      inversores, ton: tonCompleta('2026-10-20', 500),
      diaria: [{ u: 'U1', dia: '2026-10-20', kwh: 1010, origem: 'nuvem' }],
    }));
    const d = (await s.porDias(['U1'], '2026-10-20', '2026-10-20', agora)).get('U1')?.get('2026-10-20');
    expect(d).toMatchObject({ fonte: 'ton', motivo: 'concordam', kwh: 1000, kwhTon: 1000, kwhNuvem: 1010, tonCompleta: true, nuvemCompleta: true });
  });

  it('hoje: inversor faltando e horário recente → nuvem (ton_incompleta)', async () => {
    const s = new FonteGeracaoService(prismaFalso({
      inversores, ton: [{ eq: 'E1', dia: '2026-10-21', y: 300, integ: 300, blocos: 24 }],
      horaria: [{ u: 'U1', dia: '2026-10-21', kwh: 650, ultima: '2026-10-21T11:00:00' }],
    }));
    const d = (await s.porDias(['U1'], '2026-10-21', '2026-10-21', agora)).get('U1')?.get('2026-10-21');
    expect(d).toMatchObject({ fonte: 'nuvem', motivo: 'ton_incompleta', kwh: 650, tonCompleta: false, nuvemCompleta: true });
  });

  it('horário parado há mais de 2 h hoje = nuvem incompleta → ton (em_andamento)', async () => {
    const s = new FonteGeracaoService(prismaFalso({
      inversores, ton: [{ eq: 'E1', dia: '2026-10-21', y: 300, integ: 300, blocos: 24 }],
      horaria: [{ u: 'U1', dia: '2026-10-21', kwh: 650, ultima: '2026-10-21T08:00:00' }],
    }));
    const d = (await s.porDias(['U1'], '2026-10-21', '2026-10-21', agora)).get('U1')?.get('2026-10-21');
    expect(d).toMatchObject({ fonte: 'ton', motivo: 'em_andamento', nuvemCompleta: false });
  });

  it('manual no diário vence; fonte fixada lida da config', async () => {
    const s = new FonteGeracaoService(prismaFalso({
      inversores, config: [{ u: 'U1', f: 'nuvem' }], ton: tonCompleta('2026-10-20', 500),
      diaria: [{ u: 'U1', dia: '2026-10-20', kwh: 900, origem: 'bdo' }],
      horaria: [{ u: 'U1', dia: '2026-10-20', kwh: 700, ultima: '2026-10-20T18:00:00' }],
    }));
    const d = (await s.porDias(['U1'], '2026-10-20', '2026-10-20', agora)).get('U1')?.get('2026-10-20');
    expect(d).toMatchObject({ fonte: 'manual', kwh: 900, kwhNuvem: 700 });
  });

  it('sem horário nem diário, o fallback Fusion de hoje vale como nuvem (só unidade Fusion)', async () => {
    const s = new FonteGeracaoService(prismaFalso({
      inversores, ton: [], provedorFusion: ['U1'],
      fusion: [
        { eq: 'E1', dia: '2026-10-21', y: 200, ultima: '2026-10-21T11:50:00' },
        { eq: 'E2', dia: '2026-10-21', y: 210, ultima: '2026-10-21T11:45:00' },
      ],
    }));
    const d = (await s.porDias(['U1'], '2026-10-21', '2026-10-21', agora)).get('U1')?.get('2026-10-21');
    expect(d).toMatchObject({ fonte: 'nuvem', motivo: 'so_nuvem', kwh: 410, nuvemCompleta: true });
  });

  it('coluna fonte_geracao ausente (SQL não aplicado) → automatico, sem erro', async () => {
    const s = new FonteGeracaoService(prismaFalso({
      inversores, erroConfig: 'column "fonte_geracao" does not exist', ton: tonCompleta('2026-10-20', 500),
      diaria: [{ u: 'U1', dia: '2026-10-20', kwh: 600, origem: 'nuvem' }],
    }));
    const d = (await s.porDias(['U1'], '2026-10-20', '2026-10-20', agora)).get('U1')?.get('2026-10-20');
    expect(d).toMatchObject({ fonte: 'ton', motivo: 'divergem' });
  });

  it('unidade sem provedor Fusion nem lê o fallback', async () => {
    const contador: Record<string, number> = {};
    const s = new FonteGeracaoService(prismaFalso({ inversores, fusion: [{ eq: 'E1', dia: '2026-10-21', y: 200, ultima: '2026-10-21T11:50:00' }], contador }));
    const d = (await s.porDias(['U1'], '2026-10-21', '2026-10-21', agora)).get('U1')?.get('2026-10-21');
    expect(contador.fusion ?? 0).toBe(0);
    expect(d).toMatchObject({ fonte: null, motivo: 'sem_dados' });
  });

  it('diário de hoje só fecha o dia depois das 21h', async () => {
    const dados = { inversores, ton: [{ eq: 'E1', dia: '2026-10-21', y: 300, integ: 300, blocos: 24 }],
      diaria: [{ u: 'U1', dia: '2026-10-21', kwh: 650, origem: 'nuvem' }] };
    const cedo = (await new FonteGeracaoService(prismaFalso(dados)).porDias(['U1'], '2026-10-21', '2026-10-21', agora)).get('U1')?.get('2026-10-21');
    expect(cedo).toMatchObject({ nuvemCompleta: false, fonte: 'ton', motivo: 'em_andamento' });
    const noite = new Date('2026-10-22T00:30:00Z'); // 21:30 local
    const tarde = (await new FonteGeracaoService(prismaFalso({ ...dados, ton: [{ eq: 'E1', dia: '2026-10-21', y: 300, integ: 300, blocos: 48 }] }))
      .porDias(['U1'], '2026-10-21', '2026-10-21', noite)).get('U1')?.get('2026-10-21');
    expect(tarde).toMatchObject({ nuvemCompleta: true, fonte: 'nuvem', motivo: 'ton_incompleta' });
  });

  it('cache por unidade: outro recorte com a mesma unidade não relê; ontem fica 10 min', async () => {
    const contador: Record<string, number> = {};
    const s = new FonteGeracaoService(prismaFalso({ inversores, ton: tonCompleta('2026-10-20', 500), contador }));
    await s.porDias(['U1'], '2026-10-20', '2026-10-21', agora);
    expect(contador.ton).toBe(2); // ontem + hoje
    await s.porDias(['U1', 'U2'], '2026-10-20', '2026-10-21', agora);
    expect(contador.ton).toBe(2); // U1 veio do cache; U2 (sem inversor) nem consulta a TON
    await s.porDias(['U1'], '2026-10-20', '2026-10-21', new Date(agora.getTime() + 2 * 60_000));
    expect(contador.ton).toBe(3); // hoje venceu (60 s), ontem ainda no cache
  });

  it('dias depois de hoje ficam de fora', async () => {
    const s = new FonteGeracaoService(prismaFalso({ inversores }));
    const m = (await s.porDias(['U1'], '2026-10-21', '2026-10-25', agora)).get('U1');
    expect([...(m?.keys() ?? [])]).toEqual(['2026-10-21']);
  });
});
