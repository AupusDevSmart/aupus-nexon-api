import {
  bloqueioVigente,
  dentroDaJanela,
  ehComandoDePartida,
  ehPivo,
  janelaValida,
  momentoEmSaoPaulo,
  parseHHMM,
} from './janela-horario';

const em = (diaSemana: number, hhmm: string) => ({ diaSemana, minutos: parseHHMM(hhmm)! });

describe('janela-horario', () => {
  describe('parseHHMM / janelaValida', () => {
    it('aceita HH:MM e recusa lixo', () => {
      expect(parseHHMM('06:00')).toBe(360);
      expect(parseHHMM('23:59')).toBe(1439);
      expect(parseHHMM('24:00')).toBeNull();
      expect(parseHHMM('6:00')).toBeNull();
      expect(parseHHMM(undefined)).toBeNull();
    });

    it('janela exige inicio, fim e dias 1..7', () => {
      expect(janelaValida({ inicio: '06:00', fim: '18:00', dias: [1, 2] })).toBe(true);
      expect(janelaValida({ inicio: '06:00', fim: '18:00', dias: [0] })).toBe(false);
      expect(janelaValida({ inicio: '06:00', fim: '18:00' })).toBe(false);
      expect(janelaValida(null)).toBe(false);
    });
  });

  describe('momentoEmSaoPaulo', () => {
    it('converte UTC para America/Sao_Paulo (UTC-3), com dia ISO', () => {
      // 2026-09-28 (segunda) 02:30 UTC = domingo 27/09 23:30 em SP
      expect(momentoEmSaoPaulo(new Date('2026-09-28T02:30:00Z'))).toEqual({ minutos: 23 * 60 + 30, diaSemana: 7 });
      // 2026-09-28 21:00 UTC = segunda 18:00 em SP
      expect(momentoEmSaoPaulo(new Date('2026-09-28T21:00:00Z'))).toEqual({ minutos: 18 * 60, diaSemana: 1 });
    });
  });

  describe('dentroDaJanela', () => {
    const comercial = { inicio: '06:00', fim: '18:00', dias: [1, 2, 3, 4, 5] };

    it('[inicio, fim) no mesmo dia', () => {
      expect(dentroDaJanela(comercial, em(1, '06:00'))).toBe(true);
      expect(dentroDaJanela(comercial, em(1, '17:59'))).toBe(true);
      expect(dentroDaJanela(comercial, em(1, '18:00'))).toBe(false);
      expect(dentroDaJanela(comercial, em(1, '05:59'))).toBe(false);
    });

    it('fora dos dias marcados', () => {
      expect(dentroDaJanela(comercial, em(6, '10:00'))).toBe(false);
      expect(dentroDaJanela(comercial, em(7, '10:00'))).toBe(false);
    });

    it('atravessando a meia-noite pertence ao dia em que começa', () => {
      const noturna = { inicio: '22:00', fim: '05:00', dias: [5] }; // sexta
      expect(dentroDaJanela(noturna, em(5, '23:00'))).toBe(true);
      expect(dentroDaJanela(noturna, em(6, '04:59'))).toBe(true); // madrugada de sábado
      expect(dentroDaJanela(noturna, em(6, '05:00'))).toBe(false);
      expect(dentroDaJanela(noturna, em(5, '04:00'))).toBe(false); // madrugada de sexta = janela de quinta
      const domingo = { inicio: '22:00', fim: '02:00', dias: [7] };
      expect(dentroDaJanela(domingo, em(1, '01:00'))).toBe(true); // segunda de madrugada
    });

    it('inicio == fim = dia inteiro; sem dias = nunca', () => {
      expect(dentroDaJanela({ inicio: '00:00', fim: '00:00', dias: [3] }, em(3, '13:00'))).toBe(true);
      expect(dentroDaJanela({ inicio: '06:00', fim: '18:00', dias: [] }, em(3, '13:00'))).toBe(false);
    });
  });

  describe('bloqueioVigente (ponta)', () => {
    const ponta = { ativo: true, inicio: '18:00', fim: '21:00', dias: [1, 2, 3, 4, 5] };

    it('bloqueia dentro da ponta em dia útil', () => {
      expect(bloqueioVigente(ponta, em(2, '18:30'))).toBe(true);
      expect(bloqueioVigente(ponta, em(2, '21:00'))).toBe(false);
      expect(bloqueioVigente(ponta, em(6, '19:00'))).toBe(false);
    });

    it('desligado, ausente ou malformado nunca bloqueia', () => {
      expect(bloqueioVigente({ ...ponta, ativo: false }, em(2, '19:00'))).toBe(false);
      expect(bloqueioVigente(null, em(2, '19:00'))).toBe(false);
      expect(bloqueioVigente({ ativo: true, inicio: '18h', fim: '21:00', dias: [2] }, em(2, '19:00'))).toBe(false);
    });
  });

  describe('ehComandoDePartida', () => {
    it('ligar/partida contam; desligar/parar nunca', () => {
      expect(ehComandoDePartida('Ligar pivô')).toBe(true);
      expect(ehComandoDePartida('Partida')).toBe(true);
      expect(ehComandoDePartida('LIGA BOMBA')).toBe(true);
      expect(ehComandoDePartida('Desligar pivô')).toBe(false);
      expect(ehComandoDePartida('Parar pivô')).toBe(false);
      expect(ehComandoDePartida('Abrir')).toBe(false);
      expect(ehComandoDePartida('')).toBe(false);
    });
  });

  it('ehPivo casa pivo/pivô/irriga sem acento', () => {
    expect(ehPivo('Pivô 3')).toBe(true);
    expect(ehPivo(null, 'IRRIGAÇÃO NORTE')).toBe(true);
    expect(ehPivo('Inversor 1')).toBe(false);
  });
});
