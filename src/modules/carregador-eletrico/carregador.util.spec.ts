import {
  dataBR,
  hojeSP,
  moradorVeValoresDa,
  papelCarregador,
  podeExportarRecargas,
  podeGerirMoradores,
  situacaoValidade,
  somarDias,
  tarifaValida,
  validadeDe,
} from './carregador.util';

describe('carregador.util', () => {
  it('papel: Aupus é analista, dono é proprietário, vinculado é morador', () => {
    expect(papelCarregador('super_admin', true)).toBe('analista');
    expect(papelCarregador('analista', false)).toBe('analista');
    expect(papelCarregador('proprietario', true)).toBe('proprietario');
    expect(papelCarregador('operador', true)).toBe('morador');
    expect(papelCarregador('cativo', false)).toBe('proprietario');
  });

  it('papel (NEXON-20): papéis novos de analista e operador sem morador', () => {
    expect(papelCarregador('admin', false)).toBe('analista');
    expect(papelCarregador('gerente', false)).toBe('analista');
    expect(papelCarregador('analista_automacao', false)).toBe('analista');
    expect(papelCarregador('analista_operacao', true)).toBe('analista');
    expect(papelCarregador('propietario', false)).toBe('proprietario');
    // Antes caía em proprietário (gerenciava moradores e exportava).
    expect(papelCarregador('operador', false)).toBe('operador');
    expect(papelCarregador(undefined, true)).toBe('morador');
  });

  it('exportar recargas e gerir moradores: só proprietário e analistas (PER-38)', () => {
    expect(podeExportarRecargas('analista')).toBe(true);
    expect(podeExportarRecargas('proprietario')).toBe(true);
    expect(podeExportarRecargas('operador')).toBe(false);
    expect(podeExportarRecargas('morador')).toBe(false);
    expect(podeGerirMoradores('operador')).toBe(false);
    expect(podeGerirMoradores('morador')).toBe(false);
    expect(podeGerirMoradores('proprietario')).toBe(true);
  });

  it('morador só vê valores da própria recarga', () => {
    expect(moradorVeValoresDa('morador', 'M1', 'M1 ')).toBe(true);
    expect(moradorVeValoresDa('morador', 'M1', 'M2')).toBe(false);
    expect(moradorVeValoresDa('morador', null, null)).toBe(false);
    expect(moradorVeValoresDa('proprietario', null, 'M2')).toBe(true);
  });

  it('tarifa na faixa R$ 0,30 a R$ 5,00', () => {
    expect(tarifaValida('1,15')).toBe(1.15);
    expect(tarifaValida(0.29)).toBeNull();
    expect(tarifaValida('5,01')).toBeNull();
    expect(tarifaValida('x')).toBeNull();
  });

  it('validade: vencido, vence amanhã (inclui hoje), válido', () => {
    expect(situacaoValidade(null, '2026-10-15')).toBe('sem_validade');
    expect(situacaoValidade('2026-10-14', '2026-10-15')).toBe('vencido');
    expect(situacaoValidade('2026-10-15', '2026-10-15')).toBe('vence_amanha');
    expect(situacaoValidade('2026-10-16', '2026-10-15')).toBe('vence_amanha');
    expect(situacaoValidade('2026-10-17', '2026-10-15')).toBe('valido');
  });

  it('validadeDe aceita ISO e dd/mm/aaaa, recusa data impossível', () => {
    expect(validadeDe('31/12/2026')).toBe('2026-12-31');
    expect(validadeDe('2026-02-30')).toBeUndefined();
    expect(validadeDe('')).toBeNull();
    expect(dataBR('2026-12-31')).toBe('31/12/2026');
  });

  it('datas em São Paulo', () => {
    expect(hojeSP(new Date('2026-10-16T02:00:00Z'))).toBe('2026-10-15');
    expect(somarDias('2026-12-31', 1)).toBe('2027-01-01');
  });
});
