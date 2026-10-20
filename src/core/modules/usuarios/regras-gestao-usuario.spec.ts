import { capacidades, papelCanonico, podeCadastrar } from '../auth/papeis';
import { avaliarGestao, CasoGestao, permissoesAlemDoAutor } from './regras-gestao-usuario';

const caso = (c: Partial<CasoGestao>): CasoGestao => ({
  autor: 'admin',
  acao: 'editar',
  proprio: false,
  alvo: 'operador',
  alvoLigadoAoAutor: false,
  ...c,
});

describe('papéis (spec NEXON-20)', () => {
  it('mapeia os nomes do banco para o papel canônico', () => {
    expect(papelCanonico('super_admin')).toBe('admin');
    expect(papelCanonico('admin')).toBe('admin');
    expect(papelCanonico('analista')).toBe('analista_automacao');
    expect(papelCanonico('analista_operacao')).toBe('analista_operacao');
    expect(papelCanonico('gerente')).toBe('analista_operacao');
    expect(papelCanonico('propietario')).toBe('proprietario');
    expect(papelCanonico('operador')).toBe('operador');
    expect(papelCanonico('cativo')).toBe('outro');
    expect(papelCanonico(null)).toBe('outro');
  });

  it('matriz de quem cadastra quem (seção 3)', () => {
    expect(podeCadastrar('admin', 'admin')).toBe(true);
    expect(podeCadastrar('admin', 'analista_automacao')).toBe(true);
    expect(podeCadastrar('analista_automacao', 'admin')).toBe(false);
    expect(podeCadastrar('analista_automacao', 'analista_automacao')).toBe(false);
    expect(podeCadastrar('analista_automacao', 'analista_operacao')).toBe(true);
    expect(podeCadastrar('analista_operacao', 'analista_operacao')).toBe(false);
    expect(podeCadastrar('analista_operacao', 'proprietario')).toBe(true);
    expect(podeCadastrar('proprietario', 'operador')).toBe(true);
    expect(podeCadastrar('proprietario', 'proprietario')).toBe(false);
    expect(podeCadastrar('operador', 'operador')).toBe(false);
  });

  it('operador não vê unifilar nem comunicação; proprietário não vê o próprio nome', () => {
    expect(capacidades('operador').verUnifilar).toBe(false);
    expect(capacidades('operador').verComunicacao).toBe(false);
    expect(capacidades('proprietario').verUnifilar).toBe(true);
    expect(capacidades('proprietario').verNomeProprietario).toBe(false);
    expect(capacidades('analista_operacao').verNomeProprietario).toBe(true);
  });

  it('configuração técnica só Admin e analistas; operacional também proprietário e operador', () => {
    expect(capacidades('analista_operacao').configTecnica).toBe(true);
    expect(capacidades('proprietario').configTecnica).toBe(false);
    expect(capacidades('operador').configTecnica).toBe(false);
    expect(capacidades('operador').configOperacional).toBe(true);
    expect(capacidades('analista_operacao').cadastroTecnico).toBe(false);
    expect(capacidades('analista_operacao').tarifas).toBe(true);
  });
});

describe('avaliarGestao', () => {
  it('analista de automação não cria Admin nem outro analista de automação', () => {
    expect(avaliarGestao(caso({ autor: 'analista_automacao', alvo: 'admin' }))).toMatch(/Admin/);
    expect(avaliarGestao(caso({ autor: 'analista_automacao', alvo: 'analista_automacao' }))).toMatch(/automação/);
    expect(avaliarGestao(caso({ autor: 'analista_automacao', alvo: 'analista_operacao' }))).toBeNull();
  });

  it('proprietário só mexe em operador ligado a ele', () => {
    expect(avaliarGestao(caso({ autor: 'proprietario', alvo: 'operador', alvoLigadoAoAutor: true }))).toBeNull();
    expect(avaliarGestao(caso({ autor: 'proprietario', alvo: 'operador', alvoLigadoAoAutor: false }))).toMatch(/escopo/);
    expect(avaliarGestao(caso({ autor: 'proprietario', alvo: 'proprietario', alvoLigadoAoAutor: true }))).not.toBeNull();
    expect(avaliarGestao(caso({ autor: 'proprietario', acao: 'ver', alvo: 'operador', alvoLigadoAoAutor: false }))).not.toBeNull();
  });

  it('não promove para papel acima do que o autor cadastra', () => {
    expect(avaliarGestao(caso({ autor: 'analista_operacao', alvo: 'operador', novoPapel: 'analista_operacao' }))).not.toBeNull();
    expect(avaliarGestao(caso({ autor: 'analista_operacao', alvo: 'operador', novoPapel: 'proprietario' }))).toBeNull();
    expect(avaliarGestao(caso({ autor: 'proprietario', alvo: 'operador', alvoLigadoAoAutor: true, novoPapel: 'proprietario' }))).not.toBeNull();
  });

  it('ninguém troca o próprio papel (exceto Admin) nem se desativa', () => {
    expect(avaliarGestao(caso({ autor: 'proprietario', proprio: true, alvo: 'proprietario' }))).toBeNull();
    expect(avaliarGestao(caso({ autor: 'proprietario', proprio: true, alvo: 'proprietario', novoPapel: 'admin' }))).not.toBeNull();
    expect(avaliarGestao(caso({ autor: 'analista_operacao', proprio: true, acao: 'desativar', alvo: 'analista_operacao' }))).not.toBeNull();
  });

  it('super_admin só é alterado por super_admin', () => {
    expect(avaliarGestao(caso({ autor: 'admin', autorRole: 'admin', alvo: 'admin', alvoRole: 'super_admin' }))).not.toBeNull();
    expect(avaliarGestao(caso({ autor: 'admin', autorRole: 'super_admin', alvo: 'admin', alvoRole: 'super_admin' }))).toBeNull();
    expect(avaliarGestao(caso({ autor: 'admin', autorRole: 'admin', alvo: 'admin', alvoRole: 'admin' }))).toBeNull();
  });

  it('só super_admin atribui super_admin e mexe na senha de outro admin', () => {
    expect(avaliarGestao(caso({ autor: 'admin', autorRole: 'admin', alvo: 'operador', novoPapel: 'admin', novoRoleName: 'super_admin' }))).not.toBeNull();
    expect(avaliarGestao(caso({ autor: 'admin', autorRole: 'admin', proprio: true, alvo: 'admin', alvoRole: 'admin', novoPapel: 'admin', novoRoleName: 'super_admin' }))).not.toBeNull();
    expect(avaliarGestao(caso({ autor: 'admin', autorRole: 'admin', acao: 'senha', alvo: 'admin', alvoRole: 'admin' }))).not.toBeNull();
    expect(avaliarGestao(caso({ autor: 'admin', autorRole: 'super_admin', acao: 'senha', alvo: 'admin', alvoRole: 'admin' }))).toBeNull();
  });

  it('proprietário não mexe no cadastro de operador que atende outro dono', () => {
    const base = { autor: 'proprietario' as const, alvo: 'operador' as const, alvoLigadoAoAutor: true, alvoTemOutroDono: true };
    expect(avaliarGestao(caso({ ...base, acao: 'senha' }))).toMatch(/outro proprietário/);
    expect(avaliarGestao(caso({ ...base, acao: 'editar' }))).not.toBeNull();
    expect(avaliarGestao(caso({ ...base, acao: 'ver' }))).toBeNull();
  });

  it('permissão direta: ninguém concede o que não tem', () => {
    expect(permissoesAlemDoAutor('proprietario', ['equipamentos.view'], ['equipamentos.view', 'usuarios.manage'])).toEqual(['usuarios.manage']);
    expect(permissoesAlemDoAutor('admin', [], ['qualquer'])).toEqual([]);
  });
});
