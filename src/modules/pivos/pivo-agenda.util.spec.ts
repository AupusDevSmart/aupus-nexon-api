import { agoraEmSaoPaulo, lerData, lerHora, validarAgenda } from './pivo-agenda.util';
import { programacaoDisparaAgora, type ProgramacaoExec } from './pivo-automacao.util';

/** Agenda do pivô por data (planilha, NEXON-98): validação das linhas e disparo só no dia. */
const AGORA = { data: '2026-11-11', minutos: 12 * 60 };   // 11/11/2026 12:00
const linha = (x: Record<string, unknown> = {}) => ({ data: '12/11/2026', hora_inicio: '21:00', hora_fim: '05:00', sentido: 'Direita', percentual: 60, com_agua: 'Sim', ...x });

describe('agenda por data: leitura dos campos', () => {
  it('data em DD/MM/AAAA, AAAA-MM-DD ou Date; data impossível é recusada', () => {
    expect(lerData('05/01/2027')).toBe('2027-01-05');
    expect(lerData('2027-01-05')).toBe('2027-01-05');
    expect(lerData(new Date(Date.UTC(2027, 0, 5)))).toBe('2027-01-05');
    expect(lerData('31/02/2027')).toBeNull();
    expect(lerData('amanhã')).toBeNull();
  });

  it('hora em HH:MM, H:MM ou HH:MM:SS', () => {
    expect(lerHora('21:00')).toBe(1260);
    expect(lerHora('5:30')).toBe(330);
    expect(lerHora('05:30:00')).toBe(330);
    expect(lerHora('24:00')).toBeNull();
    expect(lerHora('9h')).toBeNull();
  });

  it('hoje e a hora saem no fuso da operação', () => {
    // 02:30 UTC de 12/11 ainda é 23:30 de 11/11 em São Paulo
    expect(agoraEmSaoPaulo(new Date('2026-11-12T02:30:00Z'))).toEqual({ data: '2026-11-11', minutos: 23 * 60 + 30 });
  });
});

describe('agenda por data: validação da planilha', () => {
  it('linha boa: fim menor que o início vira o dia; o nome diz o dia e o horário', () => {
    const { ok, erros } = validarAgenda([linha()], AGORA);
    expect(erros).toEqual([]);
    expect(ok).toEqual([{ linha: 2, data: '2026-11-12', hora_inicio: '21:00', duracao_min: 480, sentido: 'horario', velocidade: 60, com_agua: true, nome: '12/11/2026 · 21:00 → 05:00' }]);
  });

  it('aceita sentido e água por extenso, vírgula no percentual e duração em minutos', () => {
    const { ok, erros } = validarAgenda([linha({ sentido: 'esquerda', percentual: '59,7', com_agua: 'molhado', hora_fim: '', duracao_min: 90 })], AGORA);
    expect(erros).toEqual([]);
    expect(ok[0]).toMatchObject({ sentido: 'anti_horario', velocidade: 59.7, duracao_min: 90 });
  });

  it('seco não leva percentímetro', () => {
    const { ok } = validarAgenda([linha({ com_agua: 'Não', percentual: '' })], AGORA);
    expect(ok[0]).toMatchObject({ com_agua: false, velocidade: null });
  });

  it('uma linha errada recusa o envio inteiro, com o motivo de cada linha', () => {
    const { ok, erros } = validarAgenda([
      linha(),
      linha({ data: '10/11/2026' }),                // já passou
      linha({ data: '13/11/2026', hora_inicio: '25:00' }),
      linha({ data: '14/11/2026', sentido: 'para cima' }),
      linha({ data: '15/11/2026', percentual: 0 }),  // 0 % na agenda viraria 100 % girando
      linha({ data: '16/11/2026', hora_fim: '', duracao_min: '' }),
    ], AGORA);
    expect(ok).toEqual([]);
    expect(erros.map((e) => e.linha)).toEqual([3, 4, 5, 6, 7]);
    expect(erros[0].motivo).toMatch(/já passaram/);
    expect(erros[3].motivo).toMatch(/de 1 a 100/);
  });

  it('hoje só vale daqui para frente', () => {
    expect(validarAgenda([linha({ data: '11/11/2026', hora_inicio: '11:59' })], AGORA).erros[0].motivo).toMatch(/já passaram/);
    expect(validarAgenda([linha({ data: '11/11/2026', hora_inicio: '12:01', hora_fim: '13:00' })], AGORA).erros).toEqual([]);
  });

  it('não deixa sobrepor: nem linhas entre si, nem o que já está agendado', () => {
    const duas = validarAgenda([linha(), linha({ data: '13/11/2026', hora_inicio: '04:00', hora_fim: '06:00' })], AGORA);
    expect(duas.erros).toEqual([{ linha: 3, motivo: 'Sobrepõe linha 2.' }]);
    const comExistente = validarAgenda([linha()], AGORA, null, [{ data: '2026-11-12', hora_inicio: '22:00', duracao_min: 60 }]);
    expect(comExistente.erros[0]).toMatchObject({ linha: 2 });
    expect(comExistente.erros[0].motivo).toMatch(/já está agendado em 12\/11\/2026 22:00/);
  });

  it('emendadas não passam: o pivô precisa de 10 min para desligar antes de ligar de novo', () => {
    const emendadas = validarAgenda([linha({ hora_inicio: '06:00', hora_fim: '08:00' }), linha({ hora_inicio: '08:00', hora_fim: '10:00' })], AGORA);
    expect(emendadas.erros).toEqual([{ linha: 3, motivo: 'Fica a menos de 10 minutos de linha 2: o pivô precisa desligar antes de ligar de novo.' }]);
    expect(validarAgenda([linha({ hora_inicio: '06:00', hora_fim: '08:00' }), linha({ hora_inicio: '08:10', hora_fim: '10:00' })], AGORA).erros).toEqual([]);
  });

  it('fim igual ao início é recusado (viraria 24 horas de irrigação)', () => {
    expect(validarAgenda([linha({ hora_inicio: '08:00', hora_fim: '08:00' })], AGORA).erros[0].motivo).toMatch(/fim é igual ao início/);
    expect(validarAgenda([linha({ hora_inicio: '08:00', hora_fim: '', duracao_min: 1440 })], AGORA).erros).toEqual([]);
  });

  it('início dentro do horário de ponta bloqueado é recusado — pela mesma regra do disparo', () => {
    const TODOS = [1, 2, 3, 4, 5, 6, 7];
    const naPonta = linha({ hora_inicio: '18:30', hora_fim: '22:00' });   // 12/11/2026 é quinta
    expect(validarAgenda([naPonta], AGORA, { ativo: true, inicio: '18:00', fim: '21:00', dias: TODOS }).erros[0].motivo).toMatch(/horário de ponta/);
    expect(validarAgenda([naPonta], AGORA, { ativo: false, inicio: '18:00', fim: '21:00', dias: TODOS }).erros).toEqual([]);
    // a ponta só vale nos dias dela: 14/11/2026 é sábado
    const sabado = linha({ data: '14/11/2026', hora_inicio: '18:30', hora_fim: '22:00' });
    expect(validarAgenda([sabado], AGORA, { ativo: true, inicio: '18:00', fim: '21:00', dias: [1, 2, 3, 4, 5] }).erros).toEqual([]);
    expect(validarAgenda([naPonta], AGORA, { ativo: true, inicio: '18:00', fim: '21:00', dias: [1, 2, 3, 4, 5] }).erros[0].motivo).toMatch(/horário de ponta/);
    // sem dias marcados a ponta não vale em dia nenhum (como no disparo)
    expect(validarAgenda([naPonta], AGORA, { ativo: true, inicio: '18:00', fim: '21:00', dias: [] }).erros).toEqual([]);
  });

  it('planilha vazia ou grande demais', () => {
    expect(validarAgenda([], AGORA).erros[0].motivo).toMatch(/nenhuma linha/);
    expect(validarAgenda(Array.from({ length: 2001 }, () => linha()), AGORA).erros[0].motivo).toMatch(/Limite de 2000/);
  });

  it('o ano todo: 365 noites seguidas passam', () => {
    const itens = Array.from({ length: 365 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 10, 12 + i));
      return linha({ data: d.toISOString().slice(0, 10), hora_inicio: '21:00', hora_fim: '05:00' });
    });
    const { ok, erros } = validarAgenda(itens, AGORA);
    expect(erros).toEqual([]);
    expect(ok).toHaveLength(365);
  });
});

describe('agenda por data: disparo', () => {
  const prog = (x: Partial<ProgramacaoExec> = {}): ProgramacaoExec => ({
    id: 'P', nome: 'x', ativo: true, hora_inicio: '21:00', dias: [], modo: 'tempo', angulo_inicial: null, angulo_final: null,
    duracao_min: 480, sentido: 'horario', velocidade: 60, com_agua: true, ultima_execucao_em: null, ...x,
  });
  const as21h = { minutos: 21 * 60, diaSemana: 3 };

  it('linha com data dispara na hora sem olhar os dias da semana (o dia quem filtra é a consulta)', () => {
    expect(programacaoDisparaAgora(prog({ data: '2026-11-11', dias: [] }), as21h, Date.now())).toBe(true);
    expect(programacaoDisparaAgora(prog({ data: '2026-11-11' }), { minutos: 20 * 60, diaSemana: 3 }, Date.now())).toBe(false);
    // dispara uma vez só, mesmo que a marca seja antiga (virada do dia)
    expect(programacaoDisparaAgora(prog({ data: '2026-11-11', ultima_execucao_em: new Date(Date.now() - 30 * 3600000) }), as21h, Date.now())).toBe(false);
  });

  it('semanal continua exigindo o dia da semana', () => {
    expect(programacaoDisparaAgora(prog({ dias: [1, 2] }), as21h, Date.now())).toBe(false);
    expect(programacaoDisparaAgora(prog({ dias: [3] }), as21h, Date.now())).toBe(true);
  });
});
