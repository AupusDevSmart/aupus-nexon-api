import { diasParados, disponibilidadePct, duracaoDentro, mediaDisponibilidade, unirIntervalos } from './disponibilidade';

const H = 3_600_000;

describe('disponibilidade', () => {
  it('une intervalos sobrepostos e corta no período', () => {
    expect(unirIntervalos([{ ini: 5, fim: 10 }, { ini: 0, fim: 6 }, { ini: 20, fim: 30 }])).toEqual([{ ini: 0, fim: 10 }, { ini: 20, fim: 30 }]);
    expect(duracaoDentro([{ ini: 0, fim: 10 }, { ini: 8, fim: 15 }], 5, 12)).toBe(7);
  });

  it('% do tempo monitorado sem alarme de comunicação', () => {
    const ini = 0;
    const fim = 100 * H;
    expect(disponibilidadePct([{ ini: 10 * H, fim: 20 * H }], ini, fim, 0)).toBe(90);
    expect(disponibilidadePct([], ini, fim, 0)).toBe(100);
  });

  it('só conta a partir do início do monitoramento; nada monitorado → null', () => {
    expect(disponibilidadePct([{ ini: 60 * H, fim: 70 * H }], 0, 100 * H, 50 * H)).toBe(80);
    expect(disponibilidadePct([], 0, 10 * H, 50 * H)).toBeNull();
  });

  it('média ignora desconhecidos', () => {
    expect(mediaDisponibilidade([100, null, 90])).toBe(95);
    expect(mediaDisponibilidade([null])).toBeNull();
  });
});

describe('dias parados dos inversores', () => {
  const dias = ['d1', 'd2', 'd3', 'd4'];
  const mapa = (o: Record<string, Record<string, number>>) => new Map(Object.entries(o).map(([k, v]) => [k, new Map(Object.entries(v))]));

  it('sem leitura ou zero conta como parado (e sem leitura é contado à parte)', () => {
    const e = mapa({ a: { d1: 100, d2: 100, d4: 0 }, b: { d1: 100, d2: 100, d3: 100, d4: 100 } });
    const r = diasParados(e, ['a', 'b'], dias);
    expect(r.porInversor.get('a')).toEqual(['d3', 'd4']);
    expect(r.semLeitura.get('a')).toBe(1);
    expect(r.porInversor.get('b')).toEqual([]);
    expect(r.diasComParado).toBe(2);
  });

  it('dia nublado (todos baixos) não conta; só um baixo com os outros normais conta', () => {
    const e = mapa({ a: { d1: 100, d2: 5, d3: 4, d4: 100 }, b: { d1: 100, d2: 6, d3: 100, d4: 100 } });
    const r = diasParados(e, ['a', 'b'], dias);
    expect(r.porInversor.get('a')).toEqual(['d3']);
    expect(r.porInversor.get('b')).toEqual([]);
  });

  it('inversor único: abaixo de 5% da própria mediana', () => {
    const e = mapa({ a: { d1: 100, d2: 100, d3: 3, d4: 90 } });
    expect(diasParados(e, ['a'], dias).porInversor.get('a')).toEqual(['d3']);
  });
});
