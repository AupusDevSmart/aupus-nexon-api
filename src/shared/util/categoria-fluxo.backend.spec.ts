import * as fs from 'fs';
import * as path from 'path';
import {
  CATEGORIA_FLUXO,
  CATEGORIA_SINAL_PAIRS,
  sinalAgregado,
} from './categoria-fluxo.backend';

describe('categoria-fluxo.backend', () => {
  describe('sinalAgregado', () => {
    it('geracao e bidirecional -> +1', () => {
      expect(sinalAgregado('Inversor PV')).toBe(1);
      expect(sinalAgregado('Módulos PV')).toBe(1);
      expect(sinalAgregado('Gateway')).toBe(1); // BIDIRECIONAL
    });

    it('consumo -> -1', () => {
      expect(sinalAgregado('Power Meter')).toBe(-1);
      expect(sinalAgregado('Motor Elétrico')).toBe(-1);
      expect(sinalAgregado('Pivô')).toBe(-1);
    });

    it('NEUTRO, AMBIGUO, desconhecida e nula -> 0 (excluido)', () => {
      expect(sinalAgregado('Transformador de Potência')).toBe(0); // NEUTRO
      expect(sinalAgregado('Medidor SSU')).toBe(0); // AMBIGUO (fluxo_manual nao persistido)
      expect(sinalAgregado('Categoria Inexistente')).toBe(0);
      expect(sinalAgregado(null)).toBe(0);
      expect(sinalAgregado(undefined)).toBe(0);
    });
  });

  describe('CATEGORIA_SINAL_PAIRS', () => {
    it('contem apenas categorias que somam (sinal != 0)', () => {
      for (const [nome, sinal] of CATEGORIA_SINAL_PAIRS) {
        expect(sinal === 1 || sinal === -1).toBe(true);
        expect(sinalAgregado(nome)).toBe(sinal);
      }
    });

    it('exclui NEUTRO/AMBIGUO', () => {
      const nomes = CATEGORIA_SINAL_PAIRS.map(([n]) => n);
      expect(nomes).not.toContain('Medidor SSU');
      expect(nomes).not.toContain('Transformador de Potência');
      expect(nomes).not.toContain('Disjuntor BT');
    });

    it('cobre as categorias de geracao e consumo esperadas', () => {
      const nomes = CATEGORIA_SINAL_PAIRS.map(([n]) => n);
      expect(nomes).toEqual(
        expect.arrayContaining([
          'Inversor PV',
          'Módulos PV',
          'Gateway',
          'Power Meter',
          'Pivô',
        ]),
      );
    });
  });

  // Paridade com o front (fonte da verdade). Best-effort: se o AupusNexOn nao
  // estiver presente (ex.: CI do backend isolado), apenas avisa e nao falha.
  describe('paridade com o front CATEGORIA_FLUXO', () => {
    const frontPath = path.resolve(
      __dirname,
      '../../../../AupusNexOn/src/features/supervisorio/utils/categoria-fluxo.ts',
    );

    it('CATEGORIA_FLUXO do backend == do front', () => {
      if (!fs.existsSync(frontPath)) {
        // eslint-disable-next-line no-console
        console.warn(`[paridade] front nao encontrado em ${frontPath} — pulando`);
        return;
      }
      const conteudo = fs.readFileSync(frontPath, 'utf8');
      const inicio = conteudo.indexOf('CATEGORIA_FLUXO');
      const fim = conteudo.indexOf('};', inicio);
      const bloco = conteudo.slice(inicio, fim);

      const front: Record<string, string> = {};
      const re = /'([^']+)':\s*'([A-Z]+)'/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(bloco)) !== null) {
        front[m[1]] = m[2];
      }

      // Garante que o parse pegou algo (senao o teste seria vacuamente verde)
      expect(Object.keys(front).length).toBeGreaterThan(5);
      expect(front).toEqual(CATEGORIA_FLUXO);
    });
  });
});
