import { avaliarRestricoes, ContextoComando, ehMedidor, sujeitoPermissaoPorUnidade } from './restricoes-comando';

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

describe('sujeitoPermissaoPorUnidade (NEXON-20, 6.2)', () => {
  it('Admin, analistas e proprietário comandam sem a permissão por instalação', () => {
    for (const p of ['admin', 'analista_automacao', 'analista_operacao', 'proprietario'] as const) {
      expect(sujeitoPermissaoPorUnidade(p)).toBe(false);
    }
  });
  it('operador e papéis sem nome seguem sujeitos', () => {
    expect(sujeitoPermissaoPorUnidade('operador')).toBe(true);
    expect(sujeitoPermissaoPorUnidade('outro')).toBe(true);
  });
});

describe('ehMedidor', () => {
  it('medidor não recebe comando; inversor, disjuntor e pivô sim', () => {
    expect(ehMedidor('MEDIDOR')).toBe(true);
    expect(ehMedidor('medidor_ssu')).toBe(true);
    expect(ehMedidor('INVERSOR')).toBe(false);
    expect(ehMedidor('DISJUNTOR')).toBe(false);
    expect(ehMedidor('PIVO')).toBe(false);
    expect(ehMedidor(null)).toBe(false);
  });
});

describe('chave Local/Remoto do pivô (BI07)', () => {
  const sem = { ...base, agora: { diaSemana: 2, minutos: 10 * 60 } };
  it('REMOTO bloqueia a partida (Bombeamento, Girar, Ligar)', () => {
    for (const nomePonto of ['Bombeamento', 'Girar_direita', 'Girar_esquerda', 'Ligar']) {
      expect(avaliarRestricoes({ ...sem, nomePonto, remoto: 1 })?.code).toBe('COMANDO_BLOQUEADO_REMOTO');
    }
  });
  it('sem leitura da chave também bloqueia a partida (fail-closed)', () => {
    expect(avaliarRestricoes({ ...sem, nomePonto: 'Girar_direita', remoto: null })?.code).toBe('COMANDO_BLOQUEADO_REMOTO');
  });
  it('Desligar, Canhão e Percentímetro passam em REMOTO', () => {
    for (const nomePonto of ['Desligar', 'Canhao', 'Percentimetro']) expect(avaliarRestricoes({ ...sem, nomePonto, remoto: 1 })).toBeNull();
  });
  it('LOCAL ou pivô sem o ponto Remoto: libera', () => {
    expect(avaliarRestricoes({ ...sem, nomePonto: 'Girar_direita', remoto: 0 })).toBeNull();
    expect(avaliarRestricoes({ ...sem, nomePonto: 'Girar_direita' })).toBeNull();
  });
});
