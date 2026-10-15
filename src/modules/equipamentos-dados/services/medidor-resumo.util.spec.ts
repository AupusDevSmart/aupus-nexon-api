import { resumoBlocos } from './medidor-resumo.util';

const b = (t: number, kWc: number, kvarInd = 0, kvarCap = 0, kWi = 0) => ({ t, kWc, kWi, kvarInd, kvarCap });

describe('resumoBlocos', () => {
  it('energia, picos e reativo máximo com natureza', () => {
    const r = resumoBlocos([b(1, 100, 30), b(2, 200, 0, 50), b(3, 0, 0, 0, 80)]);
    expect(r.consumo_kwh).toBe(75);
    expect(r.injecao_kwh).toBe(20);
    expect(r.energia_reativa_kvarh).toBe(20);
    expect(r.consumo_max).toEqual({ kw: 200, t: 2 });
    expect(r.injecao_max).toEqual({ kw: 80, t: 3 });
    expect(r.reativo_max).toEqual({ kvar: 50, t: 2, natureza: 'cap' });
  });

  it('menor FP indutivo e capacitivo por bloco', () => {
    const r = resumoBlocos([b(1, 100, 48.4), b(2, 100, 10), b(3, 100, 0, 60)]);
    expect(r.fp_min_ind!.t).toBe(1);
    expect(r.fp_min_ind!.fp).toBeCloseTo(0.9, 3);
    expect(r.fp_min_cap!.t).toBe(3);
    expect(r.fp_min_cap!.fp).toBeCloseTo(0.857, 3);
  });

  it('excedente só abaixo de 0,92: kWh × (0,92/FP − 1)', () => {
    const r = resumoBlocos([b(1, 100, 48.4), b(2, 100, 10)]);
    // bloco 1: FP 0,9 → 25 kWh × (0,92/0,9 − 1) ≈ 0,556
    expect(r.reativo_excedente_kvarh).toBeCloseTo(25 * (0.92 / (100 / Math.sqrt(100 ** 2 + 48.4 ** 2)) - 1), 6);
  });

  it('FP médio pelo kvarh resultante; bloco sem consumo fica fora', () => {
    const r = resumoBlocos([b(1, 100, 30), b(2, 100, 0, 30), b(3, 0.1, 50)]);
    expect(r.fp_medio).toBe(1);
    expect(resumoBlocos([]).fp_medio).toBeNull();
  });
});
