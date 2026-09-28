import { avaliarRestricoes, ContextoComando } from './restricoes-comando';

const base: ContextoComando = {
  comandarNaUnidade: null,
  janelaOperador: null,
  bloqueioPonta: null,
  nomePonto: 'Ligar pivô',
  agora: { diaSemana: 2, minutos: 19 * 60 }, // terça 19:00 (dentro da ponta padrão)
};
const ponta = { ativo: true, inicio: '18:00', fim: '21:00', dias: [1, 2, 3, 4, 5] };

describe('avaliarRestricoes (acionar)', () => {
  it('sem restrição nenhuma → libera (comportamento v1)', () => {
    expect(avaliarRestricoes(base)).toBeNull();
  });

  it('operador com linhas mas sem comandar na unidade → SEM_PERMISSAO_UNIDADE', () => {
    expect(avaliarRestricoes({ ...base, comandarNaUnidade: false })?.code).toBe('SEM_PERMISSAO_UNIDADE');
    expect(avaliarRestricoes({ ...base, comandarNaUnidade: true })).toBeNull();
  });

  it('fora da janela do operador → COMANDO_FORA_JANELA com o horário na mensagem', () => {
    const r = avaliarRestricoes({ ...base, janelaOperador: { inicio: '06:00', fim: '18:00', dias: [1, 2, 3, 4, 5] } });
    expect(r?.code).toBe('COMANDO_FORA_JANELA');
    expect(r?.message).toContain('06:00–18:00');
    expect(
      avaliarRestricoes({
        ...base,
        janelaOperador: { inicio: '06:00', fim: '18:00', dias: [2] },
        agora: { diaSemana: 2, minutos: 10 * 60 },
      }),
    ).toBeNull();
  });

  it('janela malformada é ignorada (não trava o operador)', () => {
    expect(avaliarRestricoes({ ...base, janelaOperador: { inicio: 'x' } })).toBeNull();
  });

  it('ponta ativa barra só PARTIDA', () => {
    expect(avaliarRestricoes({ ...base, bloqueioPonta: ponta })?.code).toBe('COMANDO_BLOQUEADO_PONTA');
    expect(avaliarRestricoes({ ...base, bloqueioPonta: ponta, nomePonto: 'Parar pivô' })).toBeNull();
    expect(avaliarRestricoes({ ...base, bloqueioPonta: { ...ponta, ativo: false } })).toBeNull();
    expect(
      avaliarRestricoes({ ...base, bloqueioPonta: ponta, agora: { diaSemana: 6, minutos: 19 * 60 } }),
    ).toBeNull();
  });

  it('ordem: permissão antes de janela antes de ponta', () => {
    const tudo = {
      ...base,
      comandarNaUnidade: false,
      janelaOperador: { inicio: '06:00', fim: '18:00', dias: [1] },
      bloqueioPonta: ponta,
    };
    expect(avaliarRestricoes(tudo)?.code).toBe('SEM_PERMISSAO_UNIDADE');
    expect(avaliarRestricoes({ ...tudo, comandarNaUnidade: true })?.code).toBe('COMANDO_FORA_JANELA');
  });
});
