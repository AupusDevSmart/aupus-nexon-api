import { diffConfiguracaoDemanda, diffVazio, resumirDiff } from './configuracao-demanda-auditoria';

describe('diffConfiguracaoDemanda (NEXON-19)', () => {
  it('registra só o que mudou, comparando Decimal/string como número', () => {
    const antes = {
      fator_perdas: '3.00',
      aplicar_perdas: true,
      demanda_geracao: { toNumber: () => 295 },
      demanda_carga: null,
      equipamentos_ids: JSON.stringify(['a', 'b ']),
    };
    const d = diffConfiguracaoDemanda(antes, {
      fator_perdas: 3,
      aplicar_perdas: false,
      demanda_geracao: 300,
      demanda_carga: 120,
      equipamentos_ids: ['b', 'c'],
    });
    expect(d.campos.map((c) => c.campo)).toEqual(['aplicar_perdas', 'demanda_geracao', 'demanda_carga']);
    expect(d.adicionados).toEqual(['c']);
    expect(d.removidos).toEqual(['a']);
    expect(resumirDiff(d, { a: 'TON', c: 'IV3' })).toBe(
      'Aplicar perdas: sim → não; Demanda de geração (kW): 295 → 300; Demanda de carga (kW): vazio → 120; +1 equipamento(s) (IV3); -1 equipamento(s) (TON)',
    );
  });

  it('campo ausente no PUT não conta como mudança', () => {
    const d = diffConfiguracaoDemanda({ demanda_carga: 50, equipamentos_ids: ['a'] }, { fator_perdas: undefined });
    expect(diffVazio(d)).toBe(true);
  });
});
