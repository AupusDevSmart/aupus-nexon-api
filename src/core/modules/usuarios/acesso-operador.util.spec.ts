import { expandirPermissoes, resumirPermissoes } from './acesso-operador.util';

describe('acesso-operador.util', () => {
  it('expande geral + exceções em uma linha por unidade (exceção fora da seleção é ignorada)', () => {
    const linhas = expandirPermissoes(
      ['u1', 'u2', 'u2 ', 'u3'],
      { comandar: true, relatorios: false },
      [
        { unidade_id: 'u2', comandar: false, relatorios: true },
        { unidade_id: 'fora', comandar: true, relatorios: true },
      ],
    );
    expect(linhas).toEqual([
      { unidade_id: 'u1', comandar: true, relatorios: false },
      { unidade_id: 'u2', comandar: false, relatorios: true },
      { unidade_id: 'u3', comandar: true, relatorios: false },
    ]);
  });

  it('resumir volta ao formulário: maioria vira geral, o resto vira exceção', () => {
    const r = resumirPermissoes([
      { unidade_id: 'u1', comandar: true, relatorios: false },
      { unidade_id: 'u2', comandar: false, relatorios: false },
      { unidade_id: 'u3', comandar: true, relatorios: false },
    ]);
    expect(r.permissoes).toEqual({ visualizar: true, comandar: true, relatorios: false });
    expect(r.excecoes).toEqual([{ unidade_id: 'u2', comandar: false, relatorios: false }]);
    expect(r.unidade_ids).toEqual(['u1', 'u2', 'u3']);
  });

  it('empate → a combinação mais permissiva vira a geral; vazio → só visualizar', () => {
    const r = resumirPermissoes([
      { unidade_id: 'u1', comandar: true, relatorios: true },
      { unidade_id: 'u2', comandar: false, relatorios: false },
    ]);
    expect(r.permissoes.comandar).toBe(true);
    expect(resumirPermissoes([]).permissoes).toEqual({ visualizar: true, comandar: false, relatorios: false });
  });
});
