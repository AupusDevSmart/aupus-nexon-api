import { ehUnidadeGeracao, energiaDaUnidade } from './energia-unidade';

const base = { chavesServico: ['a', 'b'], operador: false, semTelemetria: false, fallback: 0 };

describe('energiaDaUnidade (NEXON-62)', () => {
  it('usina mista mostra a geração da fonte, sem descontar o medidor', () => {
    // Colégio Prevest: dashboard dava −209 kWh; a análise, 653 kWh.
    expect(energiaDaUnidade({ ...base, tipo: 'Misto', base: -209, kwhFonte: 653, parcela: { kwh: 650, fator: 1, chaves: ['a', 'b'] } })).toBe(653);
  });

  it('config de demanda com parte dos inversores não reduz a geração', () => {
    // SECADOR: config só com o Inv 2 dava 355 kWh; a análise, 554 kWh.
    expect(energiaDaUnidade({ ...base, tipo: 'Misto', base: 355, kwhFonte: 554, parcela: { kwh: 355, fator: 1, chaves: ['b'] } })).toBe(554);
  });

  it('perdas da config de demanda não mudam a geração', () => {
    // San German 01: dashboard com perdas dava 2.547 kWh; a análise, 2.628 kWh.
    expect(energiaDaUnidade({ ...base, tipo: 'Geração', base: 2547, kwhFonte: 2628, parcela: { kwh: 2547, fator: 0.97, chaves: ['a', 'b'] } })).toBe(2628);
  });

  it('operador com recorte de inversores fica na soma dos liberados', () => {
    expect(energiaDaUnidade({ ...base, operador: true, tipo: 'Geração', base: 90, kwhFonte: 500, parcela: { kwh: 200, fator: 1, chaves: ['a'] } })).toBe(200);
  });

  it('operador com todos os inversores liberados vê a fonte', () => {
    expect(energiaDaUnidade({ ...base, operador: true, tipo: 'Geração', base: 90, kwhFonte: 500, parcela: { kwh: 200, fator: 1, chaves: ['a', 'b'] } })).toBe(500);
  });

  it('carga segue a soma da config de demanda', () => {
    expect(energiaDaUnidade({ ...base, tipo: 'Carga', base: 120, kwhFonte: 500, parcela: { kwh: 0, fator: 1, chaves: [] } })).toBe(120);
  });

  it('sem telemetria e sem fonte usa o fallback da nuvem', () => {
    expect(energiaDaUnidade({ ...base, tipo: 'Geração', base: 0, semTelemetria: true, fallback: 347 })).toBe(347);
  });

  it('usina sem fonte fica nos inversores, sem medidor', () => {
    expect(energiaDaUnidade({ ...base, tipo: 'Misto', base: -30, parcela: { kwh: 80, fator: 1, chaves: ['a', 'b'] } })).toBe(80);
  });
});

describe('ehUnidadeGeracao', () => {
  it.each([['Geração', true], ['Misto', true], ['UFV', true], ['Carga', false], [null, false]])('%s', (tipo, esperado) => {
    expect(ehUnidadeGeracao(tipo as string | null)).toBe(esperado);
  });
});
