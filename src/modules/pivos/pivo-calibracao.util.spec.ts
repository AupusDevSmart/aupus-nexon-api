import {
  anguloCalibrado,
  avaliarLeituras,
  azimute,
  coordenadaValida,
  deltaCircular,
  distanciaM,
  lerAckEncoder,
  passoSentido,
  passoTravado,
  prazoTravadoMs,
  zeroDaCalibracao,
  type AcompanhaSentido,
  type AcompanhaTravado,
  type Sentido,
} from './pivo-calibracao.util';
import { anguloDoEncoder } from './pivo-posicao.util';

/** NEXON-103 — os números são os da seção 6 da spec (Pivô 11, encoder de 360 posições). */
describe('calibração do ângulo do pivô', () => {
  const centro = { lat: -16, lon: -48 };
  const ponta = { lat: -15.997, lon: -47.997 };
  const umaCasa = (v: number) => Math.round(v * 10) / 10;

  describe('azimute do braço (centro → ponta)', () => {
    it('exemplo da spec: 43,9°', () => {
      expect(umaCasa(azimute(centro, ponta))).toBe(43.9);
    });

    it('ponta a leste: 90,0°', () => {
      expect(umaCasa(azimute(centro, { lat: -16, lon: -47.996 }))).toBe(90);
    });

    it('norte, sul e oeste', () => {
      expect(azimute(centro, { lat: -15.99, lon: -48 })).toBe(0);
      expect(azimute(centro, { lat: -16.01, lon: -48 })).toBe(180);
      expect(umaCasa(azimute(centro, { lat: -16, lon: -48.004 }))).toBe(270);
    });

    it('nunca devolve 360', () => {
      expect(azimute(centro, { lat: -15.99, lon: -48.0000000001 })).toBeLessThan(360);
    });
  });

  describe('distância entre centro e ponta', () => {
    it('o exemplo da spec tem ~463 m', () => {
      expect(distanciaM(centro, ponta)).toBeGreaterThan(450);
      expect(distanciaM(centro, ponta)).toBeLessThan(480);
    });

    it('pontos a menos de 50 m', () => {
      expect(distanciaM(centro, { lat: -16.0003, lon: -48 })).toBeLessThan(50);
    });

    it('coordenada fora da faixa não vale', () => {
      expect(coordenadaValida({ lat: -16, lon: -48 })).toBe(true);
      expect(coordenadaValida({ lat: 91, lon: 0 })).toBe(false);
      expect(coordenadaValida({ lat: 0, lon: 181 })).toBe(false);
      expect(coordenadaValida({ lat: NaN, lon: 0 })).toBe(false);
      expect(coordenadaValida(null)).toBe(false);
    });
  });

  describe('ângulo em operação — tabela da seção 6', () => {
    const cal = (sentido: Sentido) => ({ az_cal: 43.9, bruto_cal: 147, sentido });
    it.each([
      [147, 43.9, 43.9],
      [200, 96.9, 350.9],
      [10, 266.9, 180.9],
    ])('bruto %i → horário %f° · anti-horário %f°', (bruto, horario, anti) => {
      expect(umaCasa(anguloCalibrado(bruto, cal(1), 360))).toBe(horario);
      expect(umaCasa(anguloCalibrado(bruto, cal(-1), 360))).toBe(anti);
    });

    it('com o azimute calculado das coordenadas a tela mostra os mesmos valores', () => {
      const c = { az_cal: azimute(centro, ponta), bruto_cal: 147, sentido: 1 as Sentido };
      expect(umaCasa(anguloCalibrado(200, c, 360))).toBe(96.9);
      expect(umaCasa(anguloCalibrado(10, c, 360))).toBe(266.9);
    });

    it('fica sempre em 0 a 359,99, inclusive na virada', () => {
      for (let b = 0; b < 360; b++) {
        for (const s of [1, -1] as Sentido[]) {
          const a = anguloCalibrado(b, cal(s), 360);
          expect(a).toBeGreaterThanOrEqual(0);
          expect(a).toBeLessThan(360);
        }
      }
    });

    it('encoder de 4096 posições: a diferença de contagens vira graus', () => {
      expect(anguloCalibrado(1024, { az_cal: 10, bruto_cal: 0, sentido: 1 }, 4096)).toBe(100);
      expect(anguloCalibrado(1024, { az_cal: 10, bruto_cal: 0, sentido: -1 }, 4096)).toBe(280);
    });

    it('multivolta: usa só a parte de uma volta', () => {
      expect(anguloCalibrado(360 * 3 + 200, cal(1), 360)).toBe(anguloCalibrado(200, cal(1), 360));
    });
  });

  describe('a mesma calibração no formato da TON (resolução, sentido, zero)', () => {
    it('zero fica em −180 a 180 e dá o mesmo ângulo da fórmula da spec', () => {
      for (const s of [1, -1] as Sentido[]) {
        for (const res of [360, 2048, 4096, 8192]) {
          const cal = { az_cal: 43.87, bruto_cal: Math.round(res * 0.41), sentido: s };
          const { zero, invertido } = zeroDaCalibracao(cal, res);
          expect(zero).toBeGreaterThan(-180.001);
          expect(zero).toBeLessThanOrEqual(180);
          expect(invertido).toBe(s === -1);
          for (const bruto of [0, 1, Math.round(res / 3), res - 1]) {
            const pelaTon = anguloDoEncoder(bruto, { resolucao: res, invertido, zero })!.angulo;
            expect(Math.abs(deltaCircular(pelaTon, anguloCalibrado(bruto, cal, res)))).toBeLessThan(0.02);
          }
        }
      }
    });

    it('exemplo da spec: zero −103,1° no horário', () => {
      expect(zeroDaCalibracao({ az_cal: 43.9, bruto_cal: 147, sentido: 1 }, 360)).toEqual({ zero: -103.1, invertido: false });
      expect(zeroDaCalibracao({ az_cal: 43.9, bruto_cal: 147, sentido: -1 }, 360)).toEqual({ zero: -169.1, invertido: true });
    });
  });

  describe('"Ler encoder": 5 leituras seguidas', () => {
    it('todas iguais: aceita', () => {
      expect(avaliarLeituras([147, 147, 147, 147, 147], 360)).toMatchObject({ valida: true, valor: 147, motivo: null });
    });

    it('variando ±1: aceita a mais repetida', () => {
      expect(avaliarLeituras([147, 148, 147, 147, 148], 360)).toMatchObject({ valida: true, valor: 147 });
    });

    it('a virada 359 → 0 conta como 1', () => {
      expect(avaliarLeituras([359, 0, 359, 0, 0], 360)).toMatchObject({ valida: true, valor: 0 });
    });

    it('variou mais que 1: recusa com o motivo', () => {
      const r = avaliarLeituras([147, 149, 147, 147, 147], 360);
      expect(r.valida).toBe(false);
      expect(r.motivo).toMatch(/instável/);
    });

    it('menos de 5 leituras ou erro de comunicação: recusa', () => {
      expect(avaliarLeituras([147, 147, 147], 360).valida).toBe(false);
      expect(avaliarLeituras([147, 147, 147, 147, 147], 360, 1).valida).toBe(false);
      expect(avaliarLeituras([], 360)).toMatchObject({ valida: false, motivo: 'Encoder sem resposta' });
    });

    it('ack da TON', () => {
      expect(lerAckEncoder('pivo_el 147 147 148 147 147')).toEqual({ leituras: [147, 147, 148, 147, 147], erros: 0 });
      expect(lerAckEncoder('pivo_el_erro 2')).toEqual({ leituras: [], erros: 3 });
      expect(lerAckEncoder('pivo_el_erro 0')).toEqual({ leituras: [], erros: 5 });
      expect(lerAckEncoder('pivo_cmd_desconhecido')).toBeNull();
      expect(lerAckEncoder('pivo_el')).toBeNull();
    });
  });

  describe('alarme de sentido invertido', () => {
    const rodar = (dir: 'D' | 'E', angulos: number[]) => {
      let est: AcompanhaSentido | null = null;
      let invertido = false;
      for (const a of angulos) {
        const r = passoSentido(est, dir, a);
        est = r.estado;
        invertido = invertido || r.invertido;
      }
      return invertido;
    };

    it('direita com o ângulo aumentando: sem alarme', () => {
      expect(rodar('D', [10, 11, 12, 15, 20])).toBe(false);
    });

    it('direita com o ângulo diminuindo mais de 2°: alarme', () => {
      expect(rodar('D', [10, 9, 8])).toBe(false);
      expect(rodar('D', [10, 9, 8, 7])).toBe(true);
    });

    it('esquerda com o ângulo aumentando mais de 2°: alarme', () => {
      expect(rodar('E', [10, 12, 13])).toBe(true);
      expect(rodar('E', [10, 8, 5])).toBe(false);
    });

    it('a virada 359 → 0 não é salto nem alarme falso', () => {
      expect(rodar('D', [357, 358, 359, 0, 1, 2])).toBe(false);
      expect(rodar('E', [2, 1, 0, 359, 358, 357])).toBe(false);
    });

    it('ruído de ±1 em volta do mesmo ponto não acumula', () => {
      expect(rodar('D', [100, 99, 100, 99, 100, 99, 100, 99])).toBe(false);
    });

    it('trocar o comando recomeça a conta; parado não acompanha', () => {
      let r = passoSentido(null, 'D', 10);
      r = passoSentido(r.estado, 'D', 8);
      r = passoSentido(r.estado, 'E', 6);
      expect(r).toMatchObject({ invertido: false, contrario: 0 });
      expect(passoSentido(r.estado, null, 6).estado).toBeNull();
      expect(passoSentido(r.estado, 'D', null).estado).toBeNull();
    });
  });

  describe('alarme de pivô travado', () => {
    const MIN = 60_000;

    it('girando com o ângulo parado além do prazo: alarme', () => {
      let est: AcompanhaTravado | null = null;
      let r = passoTravado(est, true, 50, 0, 10 * MIN, 360);
      est = r.estado;
      r = passoTravado(est, true, 50, 9 * MIN, 10 * MIN, 360);
      expect(r.travado).toBe(false);
      r = passoTravado(r.estado, true, 50, 10 * MIN, 10 * MIN, 360);
      expect(r.travado).toBe(true);
    });

    it('andou um passo do encoder: zera o relógio', () => {
      let r = passoTravado(null, true, 50, 0, 10 * MIN, 360);
      r = passoTravado(r.estado, true, 51, 9 * MIN, 10 * MIN, 360);
      r = passoTravado(r.estado, true, 51, 15 * MIN, 10 * MIN, 360);
      expect(r.travado).toBe(false);
    });

    it('a virada 359 → 0 conta como movimento', () => {
      let r = passoTravado(null, true, 359, 0, 10 * MIN, 360);
      r = passoTravado(r.estado, true, 0, 9 * MIN, 10 * MIN, 360);
      expect(r.estado?.ref).toBe(0);
      expect(r.travado).toBe(false);
    });

    it('parado ou sem leitura não acompanha', () => {
      expect(passoTravado({ ref: 1, desde: 0 }, false, 1, 99 * MIN, 10 * MIN, 360)).toMatchObject({ estado: null, travado: false });
      expect(passoTravado({ ref: 1, desde: 0 }, true, null, 99 * MIN, 10 * MIN, 360)).toMatchObject({ estado: null, travado: false });
    });

    it('prazo: o configurado, com piso no dobro do tempo de um passo do encoder', () => {
      expect(prazoTravadoMs(10, 360, 21, 100)).toBe(10 * MIN);
      // 10 %: volta de 210 h → 1° leva 35 min → prazo de 70 min
      expect(prazoTravadoMs(10, 360, 21, 10)).toBe(70 * MIN);
      expect(prazoTravadoMs(10, 360, null, 10)).toBe(10 * MIN);
      expect(prazoTravadoMs(NaN, 360, 21, 100)).toBe(10 * MIN);
      expect(prazoTravadoMs(999, 360, 21, 100)).toBe(240 * MIN);
    });
  });
});
