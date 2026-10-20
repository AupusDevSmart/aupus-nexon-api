import {
  azimuteParaOpenMeteo, classificarIntervalo, energiaPrevista, fechamentoDoMes, ghiParaPoa, InversorIntervalo,
  outrasPerdas, pctEsperado, potenciaEsperadaKw, potenciaEstavel,
} from './geracao-calculo';
import { diaLocal, diasEntre, inicioDoDiaUtc, janelaDoPeriodo } from './geracao-datas';
import { diffConfig, potenciaTecnicaKw, validarConfig } from './geracao-config.service';
import { blocosContiguos } from './geracao-analise.service';

const inv = (id: string, realKw: number | null, extra: Partial<InversorIntervalo> = {}): InversorIntervalo => ({
  id, potenciaNominalKw: 333, realKw, falha: false, desligado: false, limiteAtivo: false, estavel: false, ...extra,
});

describe('esperado (GER-13/14)', () => {
  it('kWp × G/1000 × fator, sem limite AC', () => {
    expect(potenciaEsperadaKw(1512, 1000, 0.8)).toBeCloseTo(1209.6);
    expect(potenciaEsperadaKw(1512, 0, 0.8)).toBe(0);
  });
  it('% do esperado passa de 100', () => {
    expect(pctEsperado(110, 100)).toBeCloseTo(110);
    expect(pctEsperado(10, null)).toBeNull();
  });
});

describe('azimute spec → Open-Meteo', () => {
  it.each([[0, -180], [90, -90], [180, 0], [270, 90], [359, 179]])('%i° → %i°', (spec, om) => {
    expect(azimuteParaOpenMeteo(spec)).toBe(om);
  });
});

describe('classificação das perdas (seção 4)', () => {
  const ac = 999;

  it('clipping vira limitação de projeto (critério de aceite)', () => {
    const p = classificarIntervalo(1200, [inv('a', 333), inv('b', 333), inv('c', 333)], ac);
    expect(p.limitacaoProjetoKw).toBeCloseTo(201);
    expect(p.indisponibilidadeKw).toBe(0);
    expect(p.limitacaoExternaKw).toBe(0);
  });

  it('inversor em falha perde a parte proporcional à sua potência (critério de aceite)', () => {
    const p = classificarIntervalo(600, [inv('a', 200), inv('b', 200), inv('c', 0, { falha: true })], ac);
    expect(p.indisponiveis).toEqual(['c']);
    expect(p.indisponibilidadeKw).toBeCloseTo(200);
  });

  it('sem comunicação conta como indisponível', () => {
    const p = classificarIntervalo(300, [inv('a', 100), inv('b', 100), inv('c', null)], ac);
    expect(p.indisponibilidadeKw).toBeCloseTo(100);
  });

  it('inversor parado sem falha com sol forte (disjuntor aberto/sem rede) é indisponível', () => {
    const p = classificarIntervalo(600, [inv('a', 200), inv('b', 200), inv('c', 0)], ac);
    expect(p.indisponiveis).toEqual(['c']);
  });

  it('limitação externa por potência estável abaixo do teto', () => {
    const est = { estavel: true };
    const p = classificarIntervalo(900, [inv('a', 200, est), inv('b', 200, est), inv('c', 200, est)], ac);
    expect(p.limitacaoExternaKw).toBeCloseTo(300);
    expect(p.limitacaoProjetoKw).toBe(0);
  });

  it('limitação externa por registro de limite', () => {
    const p = classificarIntervalo(900, [inv('a', 250, { limiteAtivo: true }), inv('b', 250), inv('c', 250)], ac);
    expect(p.limitacaoExternaKw).toBeCloseTo(150);
  });

  it('variação normal (nuvem) não é limitação: vai para outras', () => {
    const p = classificarIntervalo(900, [inv('a', 250), inv('b', 250), inv('c', 250)], ac);
    expect(p.limitacaoExternaKw + p.limitacaoProjetoKw + p.indisponibilidadeKw).toBe(0);
  });

  it('real acima do esperado: sem perda', () => {
    expect(classificarIntervalo(300, [inv('a', 200), inv('b', 200)], ac).indisponibilidadeKw).toBe(0);
  });

  it('outras = resto, nunca negativo', () => {
    expect(outrasPerdas({ esperadoKwh: 100, realKwh: 80, indisponibilidadeKwh: 5, limitacaoProjetoKwh: 5, limitacaoExternaKwh: 0 })).toBe(10);
    expect(outrasPerdas({ esperadoKwh: 100, realKwh: 120, indisponibilidadeKwh: 0, limitacaoProjetoKwh: 0, limitacaoExternaKwh: 0 })).toBe(0);
  });

  it('estabilidade exige leituras e variação < 2%', () => {
    expect(potenciaEstavel(300, 304, 302, 15)).toBe(true);
    expect(potenciaEstavel(300, 320, 310, 15)).toBe(false);
    expect(potenciaEstavel(300, 301, 300, 2)).toBe(false);
  });
});

describe('previsão (GER-31)', () => {
  it('limita cada intervalo à potência AC', () => {
    expect(energiaPrevista([1200, 500], 999)).toBeCloseTo((999 + 500) * 0.25);
  });
});

describe('fechamento do mês (GER-27..29)', () => {
  it('antes do dia 5 sem histórico: indisponível', () => {
    const f = fechamentoDoMes({ diasCompletos: [100, 100, 100], diasDoMes: 31, diaHoje: 4, mediaHistorica: null });
    expect(f.disponivel).toBe(false);
    expect(f.motivo).toBe('Disponível a partir do dia 5');
  });
  it('antes do dia 5 com histórico: disponível', () => {
    const f = fechamentoDoMes({ diasCompletos: [100, 100], diasDoMes: 30, diaHoje: 3, mediaHistorica: 90 });
    expect(f.disponivel).toBe(true);
    expect(f.usaHistorico).toBe(true);
    // w = 2/30; média = w×100 + (1−w)×90
    const media = (2 / 30) * 100 + (28 / 30) * 90;
    expect(f.estimativaKwh).toBeCloseTo(200 + 28 * media);
  });
  it('sem histórico: acumulado + restantes × média corrente, faixa = desvio × √restantes', () => {
    const dias = [100, 120, 80, 100, 100, 100, 100, 100, 100];
    const f = fechamentoDoMes({ diasCompletos: dias, diasDoMes: 31, diaHoje: 10, mediaHistorica: null });
    expect(f.estimativaKwh).toBeCloseTo(900 + 22 * 100);
    const sd = Math.sqrt(dias.reduce((s, v) => s + (v - 100) ** 2, 0) / (dias.length - 1));
    expect(f.faixaKwh).toBeCloseTo(sd * Math.sqrt(22));
  });
  it('dia sem dados não entra na média', () => {
    const f = fechamentoDoMes({ diasCompletos: [100, null, 100, 100, 100], diasDoMes: 30, diaHoje: 6, mediaHistorica: null });
    expect(f.acumuladoKwh).toBe(400);
    expect(f.estimativaKwh).toBeCloseTo(400 + 25 * 100);
  });
});

describe('GHI → POA (solarímetro)', () => {
  it('módulo horizontal mantém o GHI', () => {
    const t = new Date('2026-10-20T15:00:00Z');
    expect(ghiParaPoa(800, t, -16.45, -49.1, 0, 0)).toBeCloseTo(800, 0);
  });
  it('voltado ao norte no inverno do hemisfério sul ganha irradiância', () => {
    const t = new Date('2026-06-21T15:00:00Z'); // meio-dia solar aprox. em Goiás
    const poa = ghiParaPoa(700, t, -16.45, -49.1, 20, 0);
    expect(poa).toBeGreaterThan(700);
    expect(ghiParaPoa(700, t, -16.45, -49.1, 20, 180)).toBeLessThan(700);
  });
});

describe('datas (America/Sao_Paulo)', () => {
  it('dia local e meia-noite local', () => {
    expect(diaLocal(new Date('2026-10-21T02:30:00Z'))).toBe('2026-10-20');
    expect(inicioDoDiaUtc('2026-10-20').toISOString()).toBe('2026-10-20T03:00:00.000Z');
  });
  it('semana segunda a domingo e próximo nulo no futuro', () => {
    const j = janelaDoPeriodo('semana', '2026-10-22', '2026-10-22');
    expect(j.inicio).toBe('2026-10-19');
    expect(j.fim).toBe('2026-10-25');
    expect(j.proximo).toBeNull();
    expect(j.anterior).toBe('2026-10-12');
  });
  it('mês e ano', () => {
    expect(janelaDoPeriodo('mes', '2026-02-10', '2026-10-20')).toMatchObject({ inicio: '2026-02-01', fim: '2026-02-28', proximo: '2026-03-01' });
    expect(janelaDoPeriodo('ano', '2025-05-10', '2026-10-20')).toMatchObject({ inicio: '2025-01-01', fim: '2025-12-31', proximo: '2026-01-01' });
  });
  it('blocos contíguos', () => {
    expect(blocosContiguos(['2026-10-03', '2026-10-01', '2026-10-02', '2026-10-05'], 2)).toEqual([
      ['2026-10-01', '2026-10-02'], ['2026-10-03'], ['2026-10-05'],
    ]);
  });
});

describe('config "Usina" (seção 7)', () => {
  it('kWp obrigatório e faixas bloqueiam', () => {
    expect(() => validarConfig({ fonte: 'nenhuma' }, [])).toThrow(/obrigatório/);
    expect(() => validarConfig({ fonte: 'nenhuma', kwp_dc: 10, fator_desempenho: 1.2 }, [])).toThrow(/faixa/);
    expect(() => validarConfig({ fonte: 'satelite', kwp_dc: 10, inclinacao_graus: 91, azimute_graus: 0 }, [])).toThrow(/faixa/);
  });
  it('solarímetro precisa ser da instalação e dizer GHI/POA', () => {
    const base = { fonte: 'solarimetro', kwp_dc: 10, inclinacao_graus: 15, azimute_graus: 0 };
    expect(() => validarConfig({ ...base, solarimetro_equipamento_id: 'x' }, ['y'])).toThrow(/desta instalação/);
    expect(() => validarConfig({ ...base, solarimetro_equipamento_id: 'y' }, ['y'])).toThrow(/GHI/);
    expect(validarConfig({ ...base, solarimetro_equipamento_id: 'y', solarimetro_medicao: 'ghi' }, ['y']).solarimetro_medicao).toBe('GHI');
  });
  it('padrões e tarifa só com R$', () => {
    const v = validarConfig({ fonte: 'nenhuma', kwp_dc: 10, tarifa_concessionaria_id: 'c1' }, []);
    expect(v.fator_desempenho).toBe(0.8);
    expect(v.tarifa_concessionaria_id).toBeNull();
  });
  it('diff só do que mudou', () => {
    expect(diffConfig({ kwp_dc: 10, fonte: 'nenhuma' }, { kwp_dc: '10', fonte: 'satelite' })).toEqual({ fonte: { de: 'nenhuma', para: 'satelite' } });
  });
  it('potência técnica em W vira kW', () => {
    expect(potenciaTecnicaKw('333000', 'W')).toBe(333);
    expect(potenciaTecnicaKw('333,5', 'kW')).toBe(333.5);
    expect(potenciaTecnicaKw('', null)).toBeNull();
  });
});

describe('revisão: exportação zero', () => {
  it('inversor parado com limite 0% é limitação externa, não indisponibilidade', () => {
    const p = classificarIntervalo(600, [inv('a', 0, { limiteAtivo: true }), inv('b', 0, { limiteAtivo: true })], 666);
    expect(p.indisponibilidadeKw).toBe(0);
    expect(p.limitacaoExternaKw).toBeCloseTo(600);
  });
});

describe('revisão de segurança: datas', () => {
  it('diasEntre tem teto', () => {
    expect(diasEntre('2000-01-01', '2030-12-31')).toHaveLength(400);
  });
});
