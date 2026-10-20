import {
  classificarParada,
  horasDe,
  laminaAplicadaMm,
  laminaProgramadaMm,
  limiarOperacao,
  PASSO_MS,
  percentil,
  segmentosNaSemana,
  segmentosOperando,
  voltasPorVelocidade,
} from './pivo-operacao';

const M = 60_000;
const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 12, 3, 0, 0); // segunda 12/10/2026 00:00 BRT

/** Blocos de 15 min a partir de T0 com as potências dadas. */
const serie = (kws: number[], inicio = T0) => kws.map((kw, i) => ({ t: inicio + (i + 1) * PASSO_MS, kw }));

describe('limiar de operação', () => {
  it('10% do P95 das potências positivas, mínimo 1 kW', () => {
    expect(limiarOperacao([0, 0, 200, 200, 200])).toBeCloseTo(20);
    expect(limiarOperacao([0.2, 0.3])).toBe(1);
    expect(limiarOperacao([0, 0, 0])).toBe(Infinity);
  });

  it('percentil interpola', () => {
    expect(percentil([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentil([], 50)).toBeNull();
  });
});

describe('segmentos irrigando', () => {
  it('blocos acima do limiar viram segmento; queda medida = parada', () => {
    const segs = segmentosOperando(serie([0, 100, 100, 100, 0, 0]), 10);
    expect(segs).toEqual([{ ini: T0 + PASSO_MS, fim: T0 + 4 * PASSO_MS, termino: 'parada' }]);
    expect(horasDe(segs)).toBeCloseTo(0.75);
  });

  it('buraco de leitura fecha como sem_dado (não é parada)', () => {
    const a = serie([100, 100]);
    const b = serie([100, 0], T0 + 3 * H);
    const segs = segmentosOperando([...a, ...b], 10);
    expect(segs.map((s) => s.termino)).toEqual(['sem_dado', 'parada']);
    expect(horasDe(segs)).toBeCloseTo(0.75);
  });

  it('segmento aberto no fim da série termina sem_dado', () => {
    expect(segmentosOperando(serie([0, 50, 50]), 10)[0].termino).toBe('sem_dado');
  });

  it('horas cortadas no período', () => {
    expect(horasDe([{ ini: 0, fim: 10 * H }], 2 * H, 5 * H)).toBe(3);
  });

  it('segmentos em horas desde o início da semana, cortados em 0..168', () => {
    expect(segmentosNaSemana([{ ini: T0 - H, fim: T0 + 2.5 * H }, { ini: T0 + 167 * H, fim: T0 + 170 * H }], T0)).toEqual([
      { inicioH: 0, fimH: 2.5 },
      { inicioH: 167, fimH: 168 },
    ]);
  });
});

describe('motivo da parada', () => {
  const ponta = { ativo: true, inicio: '18:00', fim: '21:00', dias: [1, 2, 3, 4, 5] };
  const as18 = T0 + 18 * H; // segunda 18:00 BRT

  it('comando até 15 min antes ou 2 min depois', () => {
    expect(classificarParada(as18 + 3 * H, [as18 + 3 * H - 10 * M], null)).toBe('comando');
    expect(classificarParada(as18 + 3 * H, [as18 + 3 * H + 5 * M], null)).toBe('nao_programada');
  });

  it('parada no início da ponta com bloqueio ligado = ponta', () => {
    expect(classificarParada(as18 + 5 * M, [], ponta)).toBe('ponta');
    expect(classificarParada(as18 + 5 * M, [], { ...ponta, ativo: false })).toBe('nao_programada');
    expect(classificarParada(as18 + 5 * M + 5 * 24 * H, [], ponta)).toBe('nao_programada'); // sábado
  });
});

describe('lâmina e voltas', () => {
  it('lâmina média = lâmina_100 × horas ÷ tempo de volta a 100%', () => {
    expect(laminaAplicadaMm(42, 8, 21)).toBe(16);
    expect(laminaAplicadaMm(42, null, 21)).toBeNull();
  });

  it('voltas pela velocidade de cada trecho; sem velocidade conhecida → null', () => {
    expect(voltasPorVelocidade([{ horas: 21, pct: 100 }, { horas: 42, pct: 50 }], 21)).toBe(2);
    expect(voltasPorVelocidade([{ horas: 21, pct: 100 }, { horas: 1, pct: null }], 21)).toBeNull();
    expect(voltasPorVelocidade([], 21)).toBeNull();
  });

  it('lâmina programada: por tempo e por percurso, nos dias marcados', () => {
    const dias = ['2026-10-12', '2026-10-13', '2026-10-17']; // seg, ter, sáb
    const base = { ativo: true, com_agua: true, angulo_inicial: null, angulo_final: null, duracao_min: null, sentido: 'horario', velocidade: null };
    // 10,5 h por dia, seg–sex: 2 dias × 8 × 10,5/21 = 8 mm
    expect(laminaProgramadaMm([{ ...base, modo: 'tempo', duracao_min: 630, dias: [1, 2, 3, 4, 5] }], dias, 8, 21)).toBe(8);
    // meia volta a 50%: 8 × 0,5 × 2 = 8 mm por dia, só sábado
    expect(laminaProgramadaMm([{ ...base, modo: 'percurso', angulo_inicial: 0, angulo_final: 180, velocidade: 50, dias: [6] }], dias, 8, 21)).toBe(8);
    expect(laminaProgramadaMm([{ ...base, modo: 'tempo', duracao_min: 60, dias: [1], com_agua: false }], dias, 8, 21)).toBeNull();
    expect(laminaProgramadaMm([], dias, 8, 21)).toBeNull();
  });
});
