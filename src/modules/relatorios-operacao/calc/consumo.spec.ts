import {
  cargaBaseKw,
  curvaTipica,
  demanda12m,
  demandaMaxima,
  energiaPorPosto,
  horaDoBloco,
  intervalosFpBaixo,
  modalidadeTarifaria,
  reativoIndutivoPct,
  ultrapassagens,
} from './consumo';

const H = 3_600_000;
const SEG = Date.UTC(2026, 9, 12, 3, 0, 0); // segunda 12/10/2026 00:00 BRT
const bloco = (hora: number, kWc: number, extra: Partial<{ kWi: number; kvarInd: number; kvarCap: number }> = {}, dia = SEG) => ({
  t: dia + hora * H + 15 * 60_000,
  kWc,
  kWi: 0,
  kvarInd: 0,
  kvarCap: 0,
  ...extra,
});

describe('consumo — demanda e reativo', () => {
  it('hora do bloco = hora local de quando aconteceu', () => {
    expect(horaDoBloco(SEG + 18 * H + 15 * 60_000)).toBe(18);
    expect(horaDoBloco(SEG + 24 * H)).toBe(23); // bloco que fecha à meia-noite é das 23h
  });

  it('FP baixo: indutivo só das 06h às 24h, capacitivo só na madrugada', () => {
    const blocos = [
      bloco(10, 10, { kvarInd: 10 }), // FP 0,71 indutivo de dia → conta
      bloco(3, 10, { kvarInd: 10 }), // indutivo de madrugada → não conta
      bloco(3, 10, { kvarCap: 10 }), // capacitivo de madrugada → conta
      bloco(10, 10, { kvarInd: 1 }), // FP 0,995 → ok
      bloco(10, 0.1, { kvarInd: 5 }), // sem carga → fora
    ];
    expect(intervalosFpBaixo(blocos)).toBe(2);
    expect(reativoIndutivoPct(blocos)).toBeCloseTo((26 / 36) * 100, 1);
    expect(reativoIndutivoPct([bloco(1, 1)])).toBeNull();
  });

  it('ultrapassagem com tolerância de 5%; sem contratada → null', () => {
    const blocos = [bloco(1, 104), bloco(2, 106), bloco(3, 200)];
    expect(ultrapassagens(blocos, 100)).toBe(2);
    expect(ultrapassagens(blocos, null)).toBeNull();
  });

  it('demanda máxima e carga base (P10)', () => {
    const blocos = Array.from({ length: 10 }, (_, i) => bloco(i, (i + 1) * 10));
    expect(demandaMaxima(blocos)).toEqual({ kw: 100, t: blocos[9].t });
    expect(cargaBaseKw(blocos)).toBe(19);
    expect(cargaBaseKw([])).toBeNull();
  });

  it('12 meses terminando no mês, mais antigo primeiro', () => {
    const r = demanda12m('2026-10', new Map([['2026-10', 120.04], ['2025-11', 80]]));
    expect(r).toHaveLength(12);
    expect(r[0]).toEqual({ mes: '2025-11', maxKw: 80 });
    expect(r[11]).toEqual({ mes: '2026-10', maxKw: 120 });
    expect(r[5].maxKw).toBeNull();
  });

  it('curva típica separa dia útil de fim de semana', () => {
    const sab = SEG + 5 * 24 * H;
    const c = curvaTipica([bloco(10, 10), bloco(10, 30), bloco(10, 5, {}, sab)], (d) => d !== '2026-10-17')!;
    expect(c.diaUtil[10]).toBe(20);
    expect(c.fimDeSemana[10]).toBe(5);
    expect(c.diaUtil[11]).toBeNull();
    expect(curvaTipica([], () => true)).toBeNull();
  });

  it('energia por posto soma kWh do bloco (kW × 0,25 h)', () => {
    const r = energiaPorPosto([bloco(18, 40), bloco(10, 40), bloco(23, 4)], (t) => (horaDoBloco(t) === 18 ? 'ponta' : horaDoBloco(t) >= 22 ? 'reservado' : 'foraPonta'));
    expect(r).toEqual({ pontaKwh: 10, foraPontaKwh: 10, reservadoKwh: 1 });
    expect(energiaPorPosto([], () => 'ponta')).toBeNull();
  });

  it('modalidade tarifária em texto', () => {
    expect(modalidadeTarifaria('A', 'A4')).toBe('tarifa verde A4');
    expect(modalidadeTarifaria('B', 'B3')).toBe('tarifa convencional B3');
    expect(modalidadeTarifaria(null, null)).toBeNull();
  });
});
