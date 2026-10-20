import { recortarEquipamentosIds } from './recorte-operador';

describe('recortarEquipamentosIds (gráfico de demanda do operador)', () => {
  it('sem recorte devolve a lista como veio', () => {
    expect(recortarEquipamentosIds(['E1', 'E2'], null)).toEqual(['E1', 'E2']);
  });

  it('operador: fica só o liberado, nos dois formatos e com id char(26) com espaço', () => {
    expect(recortarEquipamentosIds(['E1  ', 'E2'], ['E1'])).toEqual(['E1  ']);
    expect(recortarEquipamentosIds([{ id: 'E2', sinal: 1 }, { id: 'E1', sinal: -1 }], ['E1'])).toEqual([{ id: 'E1', sinal: -1 }]);
  });

  it('lista inválida vira vazia; nada liberado = nada no gráfico', () => {
    expect(recortarEquipamentosIds(null, ['E1'])).toEqual([]);
    expect(recortarEquipamentosIds(['E1'], [])).toEqual([]);
  });
});
