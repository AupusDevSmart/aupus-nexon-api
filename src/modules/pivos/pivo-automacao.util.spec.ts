import {
  chegouNoAngulo, dentroDaPonta, duracaoParadaMs, irrigacaoDaProgramacao, normalizarIrrigacao, programacaoDisparaAgora, ProgramacaoExec, resumoIrrigacao,
} from './pivo-automacao.util';

const H = 3600000;
const prog = (o: Partial<ProgramacaoExec> = {}): ProgramacaoExec => ({
  id: 'p1', nome: 'Noturna', ativo: true, hora_inicio: '21:00', dias: [1, 2, 3, 4, 5], modo: 'tempo',
  angulo_inicial: null, angulo_final: null, duracao_min: 480, sentido: 'horario', velocidade: 80, com_agua: true,
  ultima_execucao_em: null, ...o,
});

describe('normalizarIrrigacao', () => {
  it('limita percentual, desliga canhão sem água e converte início', () => {
    const i = normalizarIrrigacao({
      modo: 'simples', inicio: '2026-10-16T00:00:00.000Z',
      config: { direcao: 'Avanço', percentual: 250, semAgua: true, canhao: true },
      parada: { tipo: 'porVoltas', voltas: 2 },
    })!;
    expect(i.config).toMatchObject({ direcao: 'Avanço', percentual: 100, semAgua: true, canhao: false });
    expect(i.parada).toEqual({ tipo: 'porVoltas', voltas: 2 });
    expect(i.inicio).toBe('2026-10-16T00:00:00.000Z');
  });
  it('modo ângulo sem parada vira parada no ângulo final', () => {
    const i = normalizarIrrigacao({ modo: 'angulo', anguloFinal: 370, config: {}, parada: { tipo: 'semParar' } })!;
    expect(i.parada).toEqual({ tipo: 'porAngulo', angulo: 10 });
  });
  it('lixo → null', () => {
    expect(normalizarIrrigacao(null)).toBeNull();
    expect(normalizarIrrigacao('x')).toBeNull();
  });
});

describe('duracaoParadaMs', () => {
  const base = normalizarIrrigacao({ config: { direcao: 'Avanço', percentual: 50 }, parada: { tipo: 'porVoltas', voltas: 1 } })!;
  it('voltas: tempo de volta a 100% corrigido pelo percentímetro', () => {
    expect(duracaoParadaMs(base, 21, null)).toBe(42 * H);
  });
  it('sem água gira a 100%', () => {
    expect(duracaoParadaMs({ ...base, config: { ...base.config, semAgua: true } }, 21, null)).toBe(21 * H);
  });
  it('tempo em minutos', () => {
    expect(duracaoParadaMs({ ...base, parada: { tipo: 'porTempo', minutos: 90 } }, 21, null)).toBe(90 * 60000);
  });
  it('ângulo precisa do ângulo atual e respeita o sentido', () => {
    const a = { ...base, config: { ...base.config, percentual: 100 }, parada: { tipo: 'porAngulo' as const, angulo: 90 } };
    expect(duracaoParadaMs(a, 24, null)).toBeNull();
    expect(duracaoParadaMs(a, 24, 0)).toBe(6 * H);
    expect(duracaoParadaMs({ ...a, config: { ...a.config, direcao: 'Reverso' } }, 24, 0)).toBe(18 * H);
  });
  it('sem parada → null', () => {
    expect(duracaoParadaMs({ ...base, parada: { tipo: 'semParar' } }, 21, 10)).toBeNull();
  });
});

describe('chegouNoAngulo', () => {
  it('dentro da tolerância', () => expect(chegouNoAngulo('Avanço', 90, 80, 89)).toBe(true));
  it('passou do alvo entre leituras (avanço, atravessando 0°)', () => expect(chegouNoAngulo('Avanço', 2, 350, 10)).toBe(true));
  it('ainda não chegou', () => expect(chegouNoAngulo('Avanço', 90, 40, 50)).toBe(false));
  it('reverso', () => {
    expect(chegouNoAngulo('Reverso', 90, 100, 85)).toBe(true);
    expect(chegouNoAngulo('Reverso', 90, 120, 110)).toBe(false);
  });
});

describe('programacaoDisparaAgora', () => {
  const agora = Date.parse('2026-10-15T00:01:00Z');
  it('no minuto e no dia', () => expect(programacaoDisparaAgora(prog(), { minutos: 21 * 60 + 1, diaSemana: 3 }, agora)).toBe(true));
  it('fora do dia', () => expect(programacaoDisparaAgora(prog(), { minutos: 21 * 60, diaSemana: 6 }, agora)).toBe(false));
  it('antes da hora ou passada a folga', () => {
    expect(programacaoDisparaAgora(prog(), { minutos: 20 * 60 + 59, diaSemana: 3 }, agora)).toBe(false);
    expect(programacaoDisparaAgora(prog(), { minutos: 21 * 60 + 6, diaSemana: 3 }, agora)).toBe(false);
  });
  it('uma vez por dia', () => {
    const p = prog({ ultima_execucao_em: new Date(agora - 60000) });
    expect(programacaoDisparaAgora(p, { minutos: 21 * 60 + 2, diaSemana: 3 }, agora)).toBe(false);
  });
  it('pausada não dispara', () => expect(programacaoDisparaAgora(prog({ ativo: false }), { minutos: 21 * 60, diaSemana: 3 }, agora)).toBe(false));
});

describe('irrigacaoDaProgramacao', () => {
  it('tempo → parada por tempo, sentido horário = Avanço', () => {
    const i = irrigacaoDaProgramacao(prog());
    expect(i.config).toMatchObject({ direcao: 'Avanço', percentual: 80, semAgua: false });
    expect(i.parada).toEqual({ tipo: 'porTempo', minutos: 480 });
    expect(resumoIrrigacao(i)).toBe('Avanço · 80% · Molhado · 480 min');
  });
  it('percurso → para no ângulo final, seco', () => {
    const i = irrigacaoDaProgramacao(prog({ modo: 'percurso', angulo_final: 180, sentido: 'anti_horario', com_agua: false }));
    expect(i.config).toMatchObject({ direcao: 'Reverso', semAgua: true });
    expect(i.parada).toEqual({ tipo: 'porAngulo', angulo: 180 });
  });
});

describe('dentroDaPonta', () => {
  const j = { ativo: true, inicio: '18:00', fim: '21:00', dias: [1, 2, 3, 4, 5] };
  it('ativo e na janela', () => expect(dentroDaPonta(j, { minutos: 19 * 60, diaSemana: 2 })).toBe(true));
  it('desligado não vale', () => expect(dentroDaPonta({ ...j, ativo: false }, { minutos: 19 * 60, diaSemana: 2 })).toBe(false));
  it('fim de semana fora', () => expect(dentroDaPonta(j, { minutos: 19 * 60, diaSemana: 6 })).toBe(false));
});
