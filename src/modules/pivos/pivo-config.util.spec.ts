import { agruparConjugados, camposTecnicosAlterados, janelaOuPadrao, PONTA_PADRAO, RESERVADO_PADRAO } from './pivo-config.util';

describe('pivo-config.util', () => {
  describe('janelaOuPadrao', () => {
    it('sem config → padrão DESLIGADO (18:00–21:00 seg–sex)', () => {
      expect(janelaOuPadrao(null, PONTA_PADRAO)).toEqual({ ativo: false, inicio: '18:00', fim: '21:00', dias: [1, 2, 3, 4, 5] });
      expect(janelaOuPadrao({ inicio: 'x' }, RESERVADO_PADRAO).inicio).toBe('21:30');
    });

    it('config gravada é normalizada (dias únicos e ordenados)', () => {
      expect(janelaOuPadrao({ ativo: true, inicio: '17:30', fim: '20:30', dias: [5, 1, 1] }, PONTA_PADRAO)).toEqual({
        ativo: true,
        inicio: '17:30',
        fim: '20:30',
        dias: [1, 5],
      });
    });

    it('não devolve a referência do padrão', () => {
      const j = janelaOuPadrao(undefined, PONTA_PADRAO);
      j.dias.push(6);
      expect(PONTA_PADRAO.dias).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe('agruparConjugados', () => {
    const l = (pivo_id: string, pivo_nome: string, motobomba_id: string, motobomba_nome = 'Motobomba') => ({
      pivo_id,
      pivo_nome,
      motobomba_id,
      motobomba_nome,
    });

    it('agrupa pela motobomba e ordena os pivôs por número', () => {
      const g = agruparConjugados([l('p11', 'Pivô 11', 'mb1'), l('p3', 'Pivô 3', 'mb1')]);
      expect(g).toEqual([
        {
          motobomba: { equipamento_id: 'mb1', nome: 'Motobomba' },
          pivos: [
            { equipamento_id: 'p3', nome: 'Pivô 3' },
            { equipamento_id: 'p11', nome: 'Pivô 11' },
          ],
        },
      ]);
    });

    it('motobomba de um pivô só não é sistema conjugado', () => {
      expect(agruparConjugados([l('p5', 'Pivô 5', 'mb2')])).toEqual([]);
    });

    it('ids com espaço (char(26)) e repetidos não duplicam', () => {
      const g = agruparConjugados([l('p1 ', 'Pivô 1', 'mb '), l('p1', 'Pivô 1', 'mb'), l('p2', 'Pivô 2', 'mb')]);
      expect(g[0].pivos.map((p) => p.equipamento_id)).toEqual(['p1', 'p2']);
    });
  });

  describe('camposTecnicosAlterados (PER-33a)', () => {
    const atual = {
      parametros: { pressao_minima: 2, lamina_100: 8, tempo_volta_100: 24, correcao_angulo_zero: 0, direcionamento: 'valvula', valvula_ton_id: null, valvula_bo: null },
      motobomba_equipamento_id: 'MB1',
    };

    it('só operacional (lâmina, ponta, reservado) → nenhum técnico', () => {
      expect(camposTecnicosAlterados({ parametros: { lamina_100: 10 } }, atual)).toEqual([]);
      expect(camposTecnicosAlterados({}, atual)).toEqual([]);
    });

    it('bloco parametros inteiro com técnicos iguais ao gravado não conta', () => {
      expect(camposTecnicosAlterados({ parametros: { ...atual.parametros, lamina_100: 12 } }, atual)).toEqual([]);
      expect(camposTecnicosAlterados({ parametros: { pressao_minima: '2' as any, valvula_bo: undefined } }, atual)).toEqual([]);
      expect(camposTecnicosAlterados({ motobomba_equipamento_id: 'MB1 ' }, atual)).toEqual([]);
    });

    it('mudar tempo de volta, pressão, ângulo zero, válvula ou motobomba é técnico', () => {
      expect(camposTecnicosAlterados({ parametros: { tempo_volta_100: 30, pressao_minima: 2.5 } }, atual)).toEqual([
        'pressao_minima',
        'tempo_volta_100',
      ]);
      expect(camposTecnicosAlterados({ parametros: { correcao_angulo_zero: 5, direcionamento: 'fisico', valvula_bo: 3 } }, atual)).toEqual([
        'correcao_angulo_zero',
        'direcionamento',
        'valvula_bo',
      ]);
      expect(camposTecnicosAlterados({ motobomba_equipamento_id: null }, atual)).toEqual(['motobomba_equipamento_id']);
      expect(camposTecnicosAlterados({ parametros: { pressao_minima: null } }, atual)).toEqual(['pressao_minima']);
    });
  });
});
