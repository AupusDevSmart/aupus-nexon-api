import { papelDoPonto, valorDoBit } from './status-pontos.util';

describe('status-pontos.util', () => {
  describe('papelDoPonto', () => {
    it('papel declarado no vínculo vence o nome', () => {
      expect(papelDoPonto('mola', 'Qualquer coisa')).toBe('mola');
      expect(papelDoPonto('REMOTO', 'Local')).toBe('remoto');
    });

    it('papel desconhecido cai na inferência pelo nome', () => {
      expect(papelDoPonto('outro', 'Mola carregada')).toBe('mola');
      expect(papelDoPonto(null, 'DJ aberto')).toBe('aberto');
      expect(papelDoPonto(null, 'Disjuntor Fechado')).toBe('fechado');
      expect(papelDoPonto(null, 'Modo Local')).toBe('local');
      expect(papelDoPonto(null, 'Remoto')).toBe('remoto');
    });

    it('nome ambíguo ou sem pista → null', () => {
      expect(papelDoPonto(null, 'Local/Remoto')).toBeNull();
      expect(papelDoPonto(null, 'Aberto/Fechado')).toBeNull();
      expect(papelDoPonto(null, 'Temperatura')).toBeNull();
      expect(papelDoPonto(null, '')).toBeNull();
    });
  });

  describe('valorDoBit', () => {
    it('bit normal e com inversão NF', () => {
      expect(valorDoBit('1', false)).toBe(1);
      expect(valorDoBit(0, null)).toBe(0);
      expect(valorDoBit('1', 'true')).toBe(0);
      expect(valorDoBit(0, true)).toBe(1);
    });
    it('sem leitura → null', () => {
      expect(valorDoBit(null, true)).toBeNull();
      expect(valorDoBit(undefined, false)).toBeNull();
      expect(valorDoBit('x', false)).toBeNull();
    });
  });
});
