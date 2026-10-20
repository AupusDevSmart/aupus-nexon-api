import { diaLocal, diaSemanaIso, isoBrt, periodoDoMes, semanaDaLinhaDoTempo, somarMeses } from './periodo';

describe('periodo dos relatórios de operação', () => {
  const agora = new Date('2026-10-20T15:00:00Z'); // 20/10 12:00 BRT

  it('mês fechado vai do dia 1 00:00 BRT ao 1º do mês seguinte', () => {
    const p = periodoDoMes('2026-09', agora)!;
    expect(p.inicio.toISOString()).toBe('2026-09-01T03:00:00.000Z');
    expect(p.fim.toISOString()).toBe('2026-10-01T03:00:00.000Z');
    expect(p.diaInicio).toBe('2026-09-01');
    expect(p.diaFim).toBe('2026-09-30');
  });

  it('mês corrente termina agora', () => {
    const p = periodoDoMes('2026-10', agora)!;
    expect(p.fim.toISOString()).toBe(agora.toISOString());
    expect(p.diaFim).toBe('2026-10-20');
    expect(p.fimMes.toISOString()).toBe('2026-11-01T03:00:00.000Z');
  });

  it('recusa mês futuro, malformado ou antes de 2020', () => {
    expect(periodoDoMes('2026-11', agora)).toBeNull();
    expect(periodoDoMes('2026-13', agora)).toBeNull();
    expect(periodoDoMes('10/2026', agora)).toBeNull();
    expect(periodoDoMes('2019-12', agora)).toBeNull();
    expect(periodoDoMes(undefined, agora)).toBeNull();
  });

  it('ISO com offset de Brasília', () => {
    expect(isoBrt(new Date('2026-10-20T21:05:09Z'))).toBe('2026-10-20T18:05:09-03:00');
    expect(isoBrt(new Date('2026-10-01T02:00:00Z'))).toBe('2026-09-30T23:00:00-03:00');
    expect(isoBrt(null)).toBeNull();
  });

  it('dia local e dia da semana ISO', () => {
    expect(diaLocal(new Date('2026-10-01T02:59:00Z'))).toBe('2026-09-30');
    expect(diaSemanaIso('2026-10-19')).toBe(1); // segunda
    expect(diaSemanaIso('2026-10-18')).toBe(7); // domingo
    expect(somarMeses('2026-01', -1)).toBe('2025-12');
  });

  it('linha do tempo: última semana completa (seg–dom) dentro do período', () => {
    expect(semanaDaLinhaDoTempo(periodoDoMes('2026-09', agora)!)).toBe('2026-09-21'); // 21–27/09; 28–30 incompleta
    expect(semanaDaLinhaDoTempo(periodoDoMes('2026-10', agora)!)).toBe('2026-10-12'); // 12–18/10; hoje 20 (terça)
  });

  it('linha do tempo sem semana completa começa no 1º dia do período', () => {
    const p = periodoDoMes('2026-10', new Date('2026-10-05T15:00:00Z'))!;
    expect(semanaDaLinhaDoTempo(p)).toBe('2026-10-01');
  });

  it('semana que termina exatamente no fim do mês conta', () => {
    // maio/2026 termina num domingo (31)
    expect(semanaDaLinhaDoTempo(periodoDoMes('2026-05', agora)!)).toBe('2026-05-25');
  });
});
