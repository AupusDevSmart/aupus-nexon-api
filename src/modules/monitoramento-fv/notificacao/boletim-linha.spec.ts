import { EntradaLinha, linhaBoletim, linhaBoletimLegado } from './boletim-linha';

const base: EntradaLinha = {
  unidadeId: 'u1', nome: 'UFV Teste', previsto: 1000, escolha: undefined, origemManual: null, temApi: true, parcial: '',
  fmtKwh: (v) => v.toFixed(1),
};
const esc = (o: Partial<NonNullable<EntradaLinha['escolha']>>) => ({
  fonte: 'ton' as const, motivo: 'concordam' as const, kwh: 1000, kwhTon: 1000, kwhNuvem: 1000, divergenciaPct: 0, ...o,
});

describe('linha do boletim diário pela fonte escolhida (NEXON-37)', () => {
  it('sem escolha ou sem kWh → sem linha', () => {
    expect(linhaBoletim(base)).toBeNull();
    expect(linhaBoletim({ ...base, escolha: esc({ fonte: null, motivo: 'sem_dados', kwh: null }) })).toBeNull();
  });

  it('manual vence e diz a origem', () => {
    const l = linhaBoletim({ ...base, origemManual: 'bdo', escolha: esc({ fonte: 'manual', motivo: 'manual', kwh: 900 }) });
    expect(l).toMatchObject({ kwh_realizado: 900, fonte: 'bdo', confianca: 'alta', motivo: 'conferido no BDO' });
  });

  it('concordam → TON, alta', () => {
    expect(linhaBoletim({ ...base, escolha: esc({}) })).toMatchObject({ fonte: 'ton', confianca: 'alta', motivo: 'API e TON batem' });
  });

  it('divergem → valor da TON, confiança pela diferença', () => {
    const l = linhaBoletim({ ...base, escolha: esc({ motivo: 'divergem', kwh: 1500, kwhTon: 1500, kwhNuvem: 1000, divergenciaPct: 33.3 }) });
    expect(l).toMatchObject({ kwh_realizado: 1500, fonte: 'ton', confianca: 'baixa' });
    expect(l?.motivo).toContain('usando TON');
  });

  it('TON incompleta → valor da API, com o motivo parcial', () => {
    const l = linhaBoletim({
      ...base, parcial: '1/2 inversores',
      escolha: esc({ fonte: 'nuvem', motivo: 'ton_incompleta', kwh: 1000, kwhTon: 400, divergenciaPct: 60 }),
    });
    expect(l).toMatchObject({ kwh_realizado: 1000, fonte: 'api', confianca: 'media' });
    expect(l?.motivo).toContain('1/2 inversores');
  });

  it('nuvem zerada → TON', () => {
    expect(linhaBoletim({ ...base, escolha: esc({ motivo: 'nuvem_zerada', kwhNuvem: 0 }) })).toMatchObject({ fonte: 'ton', motivo: 'via TON (API zerada)' });
  });

  it('só TON sem API e com aviso de cadastro duplicado', () => {
    const l = linhaBoletim({ ...base, temApi: false, aviso: ' · dup', escolha: esc({ motivo: 'so_ton', kwhNuvem: null, divergenciaPct: null }) });
    expect(l).toMatchObject({ fonte: 'ton', confianca: 'media', motivo: 'via TON (sem API) · dup' });
  });

  it('fonte fixada na nuvem', () => {
    const l = linhaBoletim({ ...base, escolha: esc({ fonte: 'nuvem', motivo: 'fixada', kwh: 1000, kwhTon: 1020, divergenciaPct: 2 }) });
    expect(l).toMatchObject({ fonte: 'api', confianca: 'alta' });
    expect(l?.motivo).toMatch(/^fonte fixada: API/);
  });
});

describe('regra antiga (serviço da fonte fora do ar)', () => {
  const leg = { unidadeId: 'u1', nome: 'UFV', previsto: 0, parcial: '', fmtKwh: (v: number) => v.toFixed(1) };
  it('API vence e confere com a TON', () => {
    expect(linhaBoletimLegado({ ...leg, api: { kwh: 1000, origem: 'nuvem' }, tonKwh: 1020 }))
      .toMatchObject({ kwh_realizado: 1000, fonte: 'api', confianca: 'alta', motivo: 'API e TON batem' });
  });
  it('sem API → TON; manual vence', () => {
    expect(linhaBoletimLegado({ ...leg, api: null, tonKwh: 800 })).toMatchObject({ kwh_realizado: 800, fonte: 'ton', motivo: 'via TON (sem API)' });
    expect(linhaBoletimLegado({ ...leg, api: { kwh: 700, origem: 'manual' }, tonKwh: 800 })).toMatchObject({ kwh_realizado: 700, fonte: 'manual' });
    expect(linhaBoletimLegado({ ...leg, api: null, tonKwh: 0 })).toBeNull();
  });
});
