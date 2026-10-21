import {
  agregarTonDia, blocosSolares, DiaFonte, divergencia, EntradaFonte, escolherFonte, fonteDoGrupo,
  normalizarFonteGeracao, resumirFontes, seloFonte,
} from './geracao-fonte';
import { inicioDoDiaUtc } from './geracao-datas';

const base: EntradaFonte = {
  config: 'automatico', kwhTon: null, tonCompleta: true, kwhNuvem: null, nuvemCompleta: true, kwhManual: null,
};
const e = (o: Partial<EntradaFonte>): EntradaFonte => ({ ...base, ...o });

describe('escolha da fonte (NEXON-37)', () => {
  describe('casos reais', () => {
    it('UFV SOLAR POWER: TON = nuvem (0%) → ton, concordam', () => {
      const r = escolherFonte(e({ kwhTon: 2140.6, kwhNuvem: 2140.6 }));
      expect(r).toMatchObject({ fonte: 'ton', motivo: 'concordam', kwh: 2140.6, divergenciaPct: 0 });
    });

    it('San German 02: ±0,5% → ton, concordam', () => {
      expect(escolherFonte(e({ kwhTon: 1005, kwhNuvem: 1000 }))).toMatchObject({ fonte: 'ton', motivo: 'concordam', divergenciaPct: 0.5 });
      expect(escolherFonte(e({ kwhTon: 995, kwhNuvem: 1000 }))).toMatchObject({ fonte: 'ton', motivo: 'concordam' });
    });

    it('San German 01: TON +50% com as duas completas → ton, divergem', () => {
      const r = escolherFonte(e({ kwhTon: 1500, kwhNuvem: 1000 }));
      expect(r).toMatchObject({ fonte: 'ton', motivo: 'divergem', kwh: 1500, divergenciaPct: 33.3 });
    });

    it('San German 01 com fonte fixada em nuvem → nuvem, fixada', () => {
      const r = escolherFonte(e({ config: 'nuvem', kwhTon: 1500, kwhNuvem: 1000 }));
      expect(r).toMatchObject({ fonte: 'nuvem', motivo: 'fixada', kwh: 1000 });
    });

    it('UFV Aupus II: nuvem zerada e TON gerando → ton, nuvem_zerada', () => {
      const r = escolherFonte(e({ kwhTon: 812.4, kwhNuvem: 0 }));
      expect(r).toMatchObject({ fonte: 'ton', motivo: 'nuvem_zerada', kwh: 812.4 });
    });

    it('manual vence fonte fixada', () => {
      const r = escolherFonte(e({ config: 'ton', kwhTon: 1500, kwhNuvem: 1000, kwhManual: 1200 }));
      expect(r).toMatchObject({ fonte: 'manual', motivo: 'manual', kwh: 1200 });
    });
  });

  describe('cada motivo', () => {
    it('manual sem TON nem nuvem', () => {
      expect(escolherFonte(e({ kwhManual: 0 }))).toMatchObject({ fonte: 'manual', motivo: 'manual', kwh: 0 });
    });

    it('fixada em ton', () => {
      expect(escolherFonte(e({ config: 'ton', kwhTon: 100, kwhNuvem: 300, tonCompleta: false }))).toMatchObject({ fonte: 'ton', motivo: 'fixada', kwh: 100 });
    });

    it('fixada sem dado na fixada → a outra', () => {
      expect(escolherFonte(e({ config: 'ton', kwhNuvem: 300 }))).toMatchObject({ fonte: 'nuvem', motivo: 'fixada_sem_dado', kwh: 300 });
      expect(escolherFonte(e({ config: 'nuvem', kwhTon: 200 }))).toMatchObject({ fonte: 'ton', motivo: 'fixada_sem_dado', kwh: 200 });
    });

    it('fixada sem dado em nenhuma → sem_dados', () => {
      expect(escolherFonte(e({ config: 'nuvem' }))).toMatchObject({ fonte: null, motivo: 'sem_dados', kwh: null });
    });

    it('só TON / só nuvem / nenhuma', () => {
      expect(escolherFonte(e({ kwhTon: 10, tonCompleta: false }))).toMatchObject({ fonte: 'ton', motivo: 'so_ton', divergenciaPct: null });
      expect(escolherFonte(e({ kwhNuvem: 10, nuvemCompleta: false }))).toMatchObject({ fonte: 'nuvem', motivo: 'so_nuvem' });
      expect(escolherFonte(e({}))).toMatchObject({ fonte: null, motivo: 'sem_dados', kwh: null });
    });

    it('5% exatos ainda concordam; acima não', () => {
      expect(escolherFonte(e({ kwhTon: 1000, kwhNuvem: 950 })).motivo).toBe('concordam');
      expect(escolherFonte(e({ kwhTon: 1000, kwhNuvem: 940 })).motivo).toBe('divergem');
    });

    it('TON incompleta e nuvem completa → nuvem, ton_incompleta', () => {
      const r = escolherFonte(e({ kwhTon: 400, tonCompleta: false, kwhNuvem: 1000, nuvemCompleta: true }));
      expect(r).toMatchObject({ fonte: 'nuvem', motivo: 'ton_incompleta', kwh: 1000, divergenciaPct: 60 });
    });

    it('TON incompleta e nuvem também incompleta → ton, divergem', () => {
      expect(escolherFonte(e({ kwhTon: 400, tonCompleta: false, kwhNuvem: 1000, nuvemCompleta: false }))).toMatchObject({ fonte: 'ton', motivo: 'divergem' });
    });

    it('as duas zeradas concordam', () => {
      expect(escolherFonte(e({ kwhTon: 0, kwhNuvem: 0 }))).toMatchObject({ fonte: 'ton', motivo: 'concordam', divergenciaPct: 0 });
    });
  });

  it('divergencia relativa ao maior', () => {
    expect(divergencia(150, 100)).toBeCloseTo(1 / 3);
    expect(divergencia(null, 100)).toBeNull();
  });

  it('config desconhecida = automatico', () => {
    expect(normalizarFonteGeracao('NUVEM')).toBe('nuvem');
    expect(normalizarFonteGeracao(undefined)).toBe('automatico');
    expect(normalizarFonteGeracao('satelite')).toBe('automatico');
  });
});

describe('TON do dia', () => {
  it('blocos solares: passado 48, futuro 0, hoje até agora', () => {
    const agora = new Date(inicioDoDiaUtc('2026-10-21').getTime() + 9 * 3_600_000 + 7 * 60_000); // 09:07 local
    expect(blocosSolares('2026-10-20', agora)).toBe(48);
    expect(blocosSolares('2026-10-22', agora)).toBe(0);
    expect(blocosSolares('2026-10-21', agora)).toBe(12);
    const madrugada = new Date(inicioDoDiaUtc('2026-10-21').getTime() + 3 * 3_600_000);
    expect(blocosSolares('2026-10-21', madrugada)).toBe(0);
  });

  it('soma daily_yield; sem daily_yield usa a integral', () => {
    const r = agregarTonDia([
      { yieldKwh: 100, integralKwh: 98, blocosSolares: 48 },
      { yieldKwh: null, integralKwh: 50, blocosSolares: 40 },
    ], 2, 48);
    expect(r).toEqual({ kwh: 150, completa: true });
  });

  it('inversor sem leitura ou abaixo de 70% → incompleta', () => {
    expect(agregarTonDia([{ yieldKwh: 100, integralKwh: 0, blocosSolares: 48 }], 2, 48).completa).toBe(false);
    expect(agregarTonDia([{ yieldKwh: 100, integralKwh: 0, blocosSolares: 33 }], 1, 48).completa).toBe(false);
    expect(agregarTonDia([{ yieldKwh: 100, integralKwh: 0, blocosSolares: 34 }], 1, 48).completa).toBe(true);
  });

  it('nenhum inversor com leitura → null', () => {
    expect(agregarTonDia([], 3, 48)).toEqual({ kwh: null, completa: false });
  });
});

describe('fonte do período', () => {
  const dia = (o: Partial<DiaFonte>): DiaFonte => ({
    data: '2026-10-20', fonte: 'ton', motivo: 'concordam', kwh: 10, divergenciaPct: 0, kwhTon: 10, kwhNuvem: 10, kwhManual: null, ...o,
  });

  it('única, mista, sem dado', () => {
    expect(fonteDoGrupo([dia({}), dia({})])).toBe('ton');
    expect(fonteDoGrupo([dia({}), dia({ fonte: 'nuvem' })])).toBe('mista');
    expect(fonteDoGrupo([dia({ fonte: null, motivo: 'sem_dados', kwh: null })])).toBeNull();
  });

  it('selo', () => {
    expect(seloFonte('ton', false)).toBe('Fonte: TON');
    expect(seloFonte('nuvem', false)).toBe('Fonte: nuvem');
    expect(seloFonte('manual', false)).toBe('Fonte: manual');
    expect(seloFonte('mista', false)).toBe('Fontes: TON e nuvem');
    expect(seloFonte('ton', true)).toBe('Fontes divergem — usando TON');
    expect(seloFonte(null, false)).toBeNull();
  });

  it('resumo soma o escolhido e cada fonte, marca divergência', () => {
    const r = resumirFontes([
      dia({ kwh: 100, kwhTon: 100, kwhNuvem: 99 }),
      dia({ fonte: 'nuvem', motivo: 'ton_incompleta', kwh: 80, kwhTon: 30, kwhNuvem: 80 }),
      dia({ motivo: 'divergem', kwh: 150, kwhTon: 150, kwhNuvem: 100 }),
      dia({ fonte: null, motivo: 'sem_dados', kwh: null, kwhTon: null, kwhNuvem: null }),
    ]);
    expect(r).toEqual({
      escolhida: 'mista', divergem: true, selo: 'Fontes divergem — usando TON', kwh: 330, kwhTon: 280, kwhNuvem: 279,
    });
    expect(resumirFontes([]).kwhTon).toBeNull();
  });
});
