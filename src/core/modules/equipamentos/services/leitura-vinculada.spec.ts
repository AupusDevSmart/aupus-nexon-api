import { camposDoStatusPivo, ehPivo, papelStatusPivo } from './leitura-vinculada';

describe('leitura vinculada do pivô (NEXON-62)', () => {
  it('acha o papel pelo nome do ponto', () => {
    expect(papelStatusPivo('Girando_direita')).toBe('direita');
    expect(papelStatusPivo('Girando_esquerda')).toBe('esquerda');
    expect(papelStatusPivo('Desligado')).toBe('desligado');
    expect(papelStatusPivo('Erro')).toBe('erro');
    expect(papelStatusPivo('Horimetro')).toBeNull();
  });

  it('reconhece o tipo pivô', () => {
    expect(ehPivo('Pivô de Irrigação')).toBe(true);
    expect(ehPivo('Disjuntor')).toBe(false);
    expect(ehPivo(null)).toBe(false);
  });

  it('girando para a esquerda vira Reverso', () => {
    expect(camposDoStatusPivo({ direita: 0, esquerda: 1, desligado: 0, erro: 0 })).toEqual({
      irrigando: true, sentido: 'Reverso', falha: false, painel_energizado: true,
    });
  });

  it('parado não tem sentido', () => {
    expect(camposDoStatusPivo({ direita: 0, esquerda: 0, desligado: 1, erro: 0 })).toEqual({
      irrigando: false, falha: false, painel_energizado: true,
    });
  });

  it('erro da TON vira falha', () => {
    expect(camposDoStatusPivo({ erro: 1 }).falha).toBe(true);
  });

  it('sem nenhuma entrada lida não inventa estado', () => {
    expect(camposDoStatusPivo({ direita: null, esquerda: null })).toEqual({});
  });
});
