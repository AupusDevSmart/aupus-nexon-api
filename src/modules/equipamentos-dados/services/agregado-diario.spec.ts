import {
  agruparPorMes,
  diaLocal,
  diasEntre,
  dividirIntervalo,
  faltantes,
  inicioDoDiaUtcSql,
  periodoValido,
} from './agregado-diario';

describe('agregado-diario', () => {
  it('dia local é o de Brasília (21h–24h não viram o dia seguinte)', () => {
    expect(diaLocal(new Date('2026-10-15T01:30:00Z'))).toBe('2026-10-14'); // 22h30 BRT
    expect(diaLocal(new Date('2026-10-15T03:00:00Z'))).toBe('2026-10-15'); // 00h BRT
  });

  it('meia-noite local em UTC sem fuso, o formato de timestamp_dados', () => {
    expect(inicioDoDiaUtcSql('2026-10-01')).toBe('2026-10-01 03:00:00');
    expect(inicioDoDiaUtcSql('2027-01-01')).toBe('2027-01-01 03:00:00');
  });

  it('dias do intervalo [inicio, fim), virando mês e ano', () => {
    expect(diasEntre('2026-12-30', '2027-01-02')).toEqual(['2026-12-30', '2026-12-31', '2027-01-01']);
    expect(diasEntre('2026-10-01', '2026-11-01')).toHaveLength(31);
    expect(diasEntre('2026-10-05', '2026-10-05')).toEqual([]);
  });

  describe('dividirIntervalo', () => {
    it('mês corrente: fechado até anteontem, ontem e hoje ao vivo', () => {
      expect(dividirIntervalo('2026-10-01', '2026-11-01', '2026-10-20')).toEqual({
        fechado: { inicio: '2026-10-01', fim: '2026-10-19' },
        vivo: { inicio: '2026-10-19', fim: '2026-11-01' },
      });
    });

    it('mês passado: tudo fechado', () => {
      expect(dividirIntervalo('2026-09-01', '2026-10-01', '2026-10-20')).toEqual({
        fechado: { inicio: '2026-09-01', fim: '2026-10-01' },
        vivo: null,
      });
    });

    it('primeiro dia do mês: nada fechado', () => {
      expect(dividirIntervalo('2026-11-01', '2026-12-01', '2026-11-01')).toEqual({
        fechado: null,
        vivo: { inicio: '2026-11-01', fim: '2026-12-01' },
      });
    });
  });

  it('faltantes por equipamento e o menor intervalo que cobre todos', () => {
    const dias = ['2026-09-01', '2026-09-02', '2026-09-03'];
    const guardadas = [
      { equipamento_id: 'a                         ', dia: '2026-09-01' }, // char(26) com espaço
      { equipamento_id: 'a', dia: '2026-09-02' },
      { equipamento_id: 'a', dia: '2026-09-03' },
      { equipamento_id: 'b', dia: '2026-09-01' },
    ];
    const r = faltantes(['a', 'b'], dias, guardadas);
    expect([...r.porEquipamento.entries()]).toEqual([['b', ['2026-09-02', '2026-09-03']]]);
    expect(r.intervalo).toEqual({ inicio: '2026-09-02', fim: '2026-09-04' });
    expect(faltantes(['a'], dias, guardadas).intervalo).toBeNull();
  });

  it('ano: soma a energia por mês e tira a média só dos dias com potência', () => {
    const r = agruparPorMes([
      { dia: '2026-01-01', equipamento_id: 'a', energia_total: 10, potencia_media: 4, num_leituras: 5 },
      { dia: '2026-01-02', equipamento_id: 'a', energia_total: 20, potencia_media: null, num_leituras: 3 },
      { dia: '2026-01-03', equipamento_id: 'a', energia_total: null, potencia_media: 8, num_leituras: 2 },
      { dia: '2026-02-01', equipamento_id: 'a', energia_total: 7, potencia_media: 1, num_leituras: 1 },
    ]);
    expect(r).toEqual([
      { mes: '2026-01', equipamento_id: 'a', energia_total: 30, potencia_media: 6, num_leituras: 10 },
      { mes: '2026-02', equipamento_id: 'a', energia_total: 7, potencia_media: 1, num_leituras: 1 },
    ]);
  });

  it('período válido: 2020 até o ano que vem, mês 1–12', () => {
    const agora = new Date('2026-10-20T12:00:00Z');
    expect(periodoValido(2026, 10, agora)).toBe(true);
    expect(periodoValido(2027, undefined, agora)).toBe(true);
    expect(periodoValido(2028, undefined, agora)).toBe(false);
    expect(periodoValido(1000, undefined, agora)).toBe(false);
    expect(periodoValido(NaN, undefined, agora)).toBe(false);
    expect(periodoValido(2026, 13, agora)).toBe(false);
    expect(periodoValido(2026, 0, agora)).toBe(false);
  });
});
