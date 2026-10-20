import { comInversoresDaGeracao, diffVinculo, ehNovo, resumoVinculo } from './vinculos-operador.util';

describe('vínculo do operador (spec NEXON-20, seção 4)', () => {
  it('diff mostra o que entra e o que sai (revisão e trilha)', () => {
    const d = diffVinculo(
      { validade: null, equipamentos: [{ equipamentoId: 'P1', verRs: false }, { equipamentoId: 'I1', verRs: false }], unidadesGeracao: ['U1'] },
      { validade: '2026-12-31', equipamentos: [{ equipamentoId: 'P1', verRs: true }, { equipamentoId: 'P2', verRs: false }], unidadesGeracao: [] },
    );
    expect(d.entram).toEqual(['P2']);
    expect(d.saem).toEqual(['I1']);
    expect(d.verRsLigado).toEqual(['P1']);
    expect(d.geracaoDesligada).toEqual(['U1']);
    expect(d.validadeDepois).toBe('2026-12-31');
    expect(d.mudou).toBe(true);
  });

  it('sem mudança não grava', () => {
    const e = { validade: null, equipamentos: [{ equipamentoId: 'P1', verRs: false }], unidadesGeracao: [] };
    expect(diffVinculo(e, { ...e }).mudou).toBe(false);
  });

  it('"Ver geração" libera todos os inversores da instalação (PER-15)', () => {
    const r = comInversoresDaGeracao(
      [{ equipamentoId: 'P1', verRs: true }],
      ['U1'],
      new Map([['U1', ['I1', 'I2']], ['U2', ['I3']]]),
    );
    expect(r.map((i) => i.equipamentoId).sort()).toEqual(['I1', 'I2', 'P1']);
  });

  it('selo "Novo": 30 dias e só se ainda não liberado (PER-21g)', () => {
    const agora = new Date('2026-10-20T12:00:00Z');
    expect(ehNovo('2026-10-01T00:00:00Z', false, agora)).toBe(true);
    expect(ehNovo('2026-10-01T00:00:00Z', true, agora)).toBe(false);
    expect(ehNovo('2026-08-01T00:00:00Z', false, agora)).toBe(false);
  });

  it('resumo do rodapé', () => {
    expect(resumoVinculo(Array(14).fill('INVERSOR'), 2)).toBe('2 usinas · 14 inversores');
    expect(resumoVinculo(['PIVO', 'TRANSFORMADOR'], 0)).toBe('1 pivô · 1 outro equipamento');
    expect(resumoVinculo([], 0)).toBe('nenhum equipamento');
  });
});
