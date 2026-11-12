import { anguloDoEncoder, brutoDoEncoder, parametrosEncoder, tonDoEncoder, zeroParaAqui } from './pivo-posicao.util';

describe('posição do pivô pelo encoder', () => {
  const cfg = { resolucao: 8192, invertido: false, zero: 0 };

  it('converte contagem em graus (13 bits)', () => {
    expect(anguloDoEncoder(0, cfg)?.angulo).toBe(0);
    expect(anguloDoEncoder(2048, cfg)?.angulo).toBe(90);
    expect(anguloDoEncoder(4096, cfg)?.angulo).toBe(180);
    expect(anguloDoEncoder(8191, cfg)?.angulo).toBeCloseTo(359.96, 2);
  });

  it('resolução 360 = 1 grau por posição', () => {
    expect(anguloDoEncoder(123, { ...cfg, resolucao: 360 })?.angulo).toBe(123);
  });

  it('multivolta: usa só a parte de uma volta', () => {
    expect(anguloDoEncoder(3 * 8192 + 2048, cfg)?.angulo).toBe(90);
  });

  it('sentido invertido espelha o ângulo', () => {
    expect(anguloDoEncoder(2048, { ...cfg, invertido: true })?.angulo).toBe(270);
    expect(anguloDoEncoder(0, { ...cfg, invertido: true })?.angulo).toBe(0);
  });

  it('aplica a correção do zero e normaliza em 0–360', () => {
    expect(anguloDoEncoder(2048, { ...cfg, zero: -100 })).toEqual({ angulo: 350, anguloSemZero: 90 });
    expect(anguloDoEncoder(4096, { ...cfg, zero: 180 })?.angulo).toBe(0);
  });

  it('sem resolução não calcula', () => {
    expect(anguloDoEncoder(100, { ...cfg, resolucao: null })).toBeNull();
  });

  it('"Zerar aqui": a correção leva a posição atual a 0°', () => {
    for (const bruto of [0, 1000, 2048, 4096, 6000, 8000]) {
      const semZero = anguloDoEncoder(bruto, cfg)!.anguloSemZero;
      const zero = zeroParaAqui(semZero);
      expect(zero).toBeGreaterThanOrEqual(-180);
      expect(zero).toBeLessThanOrEqual(180);
      const a = anguloDoEncoder(bruto, { ...cfg, zero })!.angulo;
      expect(Math.min(a, 360 - a)).toBeLessThan(0.1);
    }
    expect(zeroParaAqui(0)).toBe(0);
    expect(zeroParaAqui(90)).toBe(-90);
    expect(zeroParaAqui(270)).toBe(90);
  });

  it('lê a contagem do JSON da TON', () => {
    expect(brutoDoEncoder({ posicao: 1234, samples: 3 })).toBe(1234);
    expect(brutoDoEncoder({ pos: '77' })).toBe(77);
    expect(brutoDoEncoder({ posicao: -1 })).toBeNull();
    expect(brutoDoEncoder({ error: 'no_samples' })).toBeNull();
    expect(brutoDoEncoder(null)).toBeNull();
  });

  it('parâmetros: resolução fora da faixa ou ausente vira null; zero padrão 0', () => {
    expect(parametrosEncoder({ encoder_equipamento_id: ' abc ', encoder_resolucao: 4096, encoder_invertido: true, correcao_angulo_zero: 12 }))
      .toEqual({ equipamentoId: 'abc', resolucao: 4096, invertido: true, zero: 12 });
    expect(parametrosEncoder({ encoder_resolucao: 4 })).toEqual({ equipamentoId: null, resolucao: null, invertido: false, zero: 0 });
    expect(parametrosEncoder(undefined).resolucao).toBeNull();
  });

  describe('de qual TON é o encoder (NEXON-103)', () => {
    const tons = [
      { nome: 'TON2', topico: 'AUPUS/BANCADA' },
      { nome: 'TON4', topico: 'AUPUS/BANCADA/satellite/98:A3:16:EB:DC:10' },
      { nome: 'TON4v2', topico: 'AUPUS/BANCADA/satellite/98:A3:16:EB:E1:A0' },
    ];
    it('satélite debaixo do gateway: vale a TON de tópico mais longo', () => {
      expect(tonDoEncoder('AUPUS/BANCADA/satellite/98:A3:16:EB:E1:A0/Emulador_1/data', tons)?.nome).toBe('TON4v2');
      expect(tonDoEncoder('AUPUS/BANCADA/satellite/98:A3:16:EB:DC:10/Emulador_1/data', tons)?.nome).toBe('TON4');
      expect(tonDoEncoder('AUPUS/BANCADA/Encoder_1/data', tons)?.nome).toBe('TON2');
    });
    it('prefixo tem de fechar na barra; sem tópico ou sem TON: null', () => {
      expect(tonDoEncoder('AUPUS/BANCADA2/Encoder_1/data', tons)).toBeNull();
      expect(tonDoEncoder(null, tons)).toBeNull();
      expect(tonDoEncoder('OUTRA/Encoder_1/data', tons)).toBeNull();
    });
  });
});
