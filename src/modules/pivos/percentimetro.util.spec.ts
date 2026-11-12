import { duracaoParadaMs, normalizarIrrigacao, normalizarPercentual, percentualDaLamina, resumoIrrigacao } from './pivo-automacao.util';

/** Tabela iCrop do Pivô 11 (Chimarrão): lâmina 100 % = 3,58 mm. [% da tabela, lâmina impressa] */
const TABELA: Array<[number, number]> = [
  [100, 3.58], [95, 3.77], [90, 3.98], [85, 4.21], [80, 4.48], [75, 4.77], [70, 5.11], [65, 5.51], [60, 5.97], [55, 6.51],
  [50, 7.15], [45, 7.96], [40, 8.95], [35, 10.23], [30, 11.93], [25, 14.32], [20, 17.9], [15, 23.87], [10, 35.8], [5, 71.6],
];

describe('percentímetro: lâmina → %', () => {
  it.each(TABELA)('%d %% ↔ %d mm (erro ≤ 0,1 p.p., só arredondamento da lâmina impressa)', (pct, lamina) => {
    const p = percentualDaLamina(lamina, 3.58)!;
    expect(Math.abs(p - pct)).toBeLessThanOrEqual(0.1 + 1e-9);
  });

  it('lâmina abaixo da de 100 % é impossível; não é limitado a passos de 5 %', () => {
    expect(percentualDaLamina(3.0, 3.58)).toBeNull();
    expect(percentualDaLamina(6, 3.58)).toBe(59.7);
  });

  it('percentual: 1 casa, 0 vale (parado), ausente = 100', () => {
    expect(normalizarPercentual(59.66)).toBe(59.7);
    expect(normalizarPercentual(0)).toBe(0);
    expect(normalizarPercentual(undefined)).toBe(100);
    expect(normalizarPercentual(150)).toBe(100);
    expect(normalizarIrrigacao({ config: { percentual: 0 } })!.config.percentual).toBe(0);
  });

  it('0 % não tem parada por voltas (o pivô não anda); por tempo segue valendo', () => {
    const base = normalizarIrrigacao({ config: { percentual: 0 }, parada: { tipo: 'porVoltas', voltas: 1 } })!;
    expect(duracaoParadaMs(base, 6.09, null)).toBeNull();
    const tempo = normalizarIrrigacao({ config: { percentual: 0 }, parada: { tipo: 'porTempo', minutos: 30 } })!;
    expect(duracaoParadaMs(tempo, 6.09, null)).toBe(30 * 60000);
  });

  it('resumo mostra % com vírgula e a lâmina pedida', () => {
    const i = normalizarIrrigacao({ config: { direcao: 'Avanço', percentual: 59.7, lamina: 6 } })!;
    expect(resumoIrrigacao(i)).toBe('Direita · 59,7% (6,00 mm) · Molhado · sem parada');
  });
});

describe('parada "Andar X°" (porGraus, 12/11)', () => {
  it('normaliza, resume e estima a duração', () => {
    const i = normalizarIrrigacao({ config: { percentual: 50, direcao: 'Avanço' }, parada: { tipo: 'porGraus', graus: 30 } })!;
    expect(i.parada).toEqual({ tipo: 'porGraus', graus: 30 });
    expect(resumoIrrigacao(i)).toMatch(/anda 30°$/);
    // 30° = 1/12 de volta; 6 h/volta a 100 % → a 50 % 12 h/volta → 1 h
    expect(duracaoParadaMs(i, 6, null)).toBe(3600000);
    expect(normalizarIrrigacao({ config: {}, parada: { tipo: 'porGraus', graus: 0 } })!.parada).toEqual({ tipo: 'semParar' });
  });
});
