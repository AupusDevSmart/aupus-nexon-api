import { diffGrupos, gruposDaConfiguracao, gruposMudaram, normalizarGrupos, resumirGrupos } from './diagrama-grupos';

describe('diagrama-grupos (NEXON-31)', () => {
  const noDiagrama = ['e1', 'e2', 'e3', 'e4'];

  it('tira membro fora do diagrama, repetido entre grupos e descarta grupo vazio', () => {
    const r = normalizarGrupos(
      [
        { id: 'g1', nome: ' Bloco A ', equipamentoIds: ['e1', 'e2', 'x9'] },
        { id: 'g2', nome: 'Bloco B', equipamentoIds: ['e2', 'e3'] },
        { id: 'g3', nome: 'Vazio', equipamentoIds: ['x1'] },
        { id: 'g1', nome: 'Duplicado', equipamentoIds: ['e4'] },
      ],
      noDiagrama,
    );
    expect(r.map((g) => [g.id, g.nome, g.equipamentoIds])).toEqual([
      ['g1', 'Bloco A', ['e1', 'e2']],
      ['g2', 'Bloco B', ['e3']],
    ]);
    expect(r[0].recolhido).toBe(true);
    expect(r[0].posicaoX).toBeNull();
  });

  it('nome vazio vira "Grupo N" e posição do bloco é mantida', () => {
    const [g] = normalizarGrupos([{ id: 'g1', nome: '  ', equipamentoIds: ['e1'], posicaoX: 4, posicaoY: 7, recolhido: false }], noDiagrama);
    expect(g).toMatchObject({ nome: 'Grupo 1', posicaoX: 4, posicaoY: 7, recolhido: false });
  });

  it('lê configuracoes antigas sem quebrar', () => {
    expect(gruposDaConfiguracao(null)).toEqual([]);
    expect(gruposDaConfiguracao({ grandezasPmIds: [] })).toEqual([]);
    expect(gruposDaConfiguracao({ grupos: [{ id: 'g', nome: 'a', equipamentoIds: ['e1'] }, { lixo: 1 }] })).toHaveLength(1);
  });

  it('diff aponta criado, removido, renomeado e membros', () => {
    const antes = [
      { id: 'g1', nome: 'A', equipamentoIds: ['e1', 'e2'] },
      { id: 'g2', nome: 'B', equipamentoIds: ['e3'] },
    ];
    const depois = [
      { id: 'g1', nome: 'A1', equipamentoIds: ['e1', 'e4'] },
      { id: 'g3', nome: 'C', equipamentoIds: ['e3'] },
    ];
    const d = diffGrupos(antes, depois);
    expect(d.criados.map((g) => g.id)).toEqual(['g3']);
    expect(d.removidos.map((g) => g.id)).toEqual(['g2']);
    expect(d.renomeados).toEqual([{ id: 'g1', de: 'A', para: 'A1' }]);
    expect(d.membrosAlterados).toEqual([{ id: 'g1', nome: 'A1', entraram: ['e4'], sairam: ['e2'] }]);
    expect(gruposMudaram(d)).toBe(true);
    expect(resumirGrupos(d)).toBe('grupo criado "C" (1 equip.); grupo renomeado "A" → "A1"; grupo "A1" +1 -1 equip.; grupo desfeito "B"');
  });

  it('sem mudança não gera diff', () => {
    const g = [{ id: 'g1', nome: 'A', equipamentoIds: ['e1'] }];
    expect(gruposMudaram(diffGrupos(g, g))).toBe(false);
  });
});
