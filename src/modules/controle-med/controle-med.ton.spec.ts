import { bruto, hashCadastro, lerRespostaCtl, montarCadastro, montarCtl, resultadoDoToken } from './controle-med.ton';
import { PARAMS_PADRAO } from './controle-med.calc';

describe('controle pelo MED — conversa com a TON da UFV', () => {
  it('hash igual ao do firmware (FNV-1a das linhas, 24 bits) — mesmo caso do test_ctl.cpp', () => {
    expect(hashCadastro(['ctl geral 2 600 3 0', 'ctl cfg 1 1 600 0 1000 100 INV-Norte 01', 'ctl cfg 2 2 600 600 1000 100 INV2'])).toBe('c11d60');
    expect(hashCadastro([''])).toBe('1c9dc5');   // sem cadastro (n=0, linha vazia)
  });

  it('bruto: % x escala, dentro da faixa do registrador', () => {
    const f = { escala: 10, min: 0, max: 1000 };
    expect(bruto(f, 45.04)).toBe(450);
    expect(bruto(f, 120)).toBe(1000);
    expect(bruto({ escala: 10, min: -1000, max: 1000 }, -12.3)).toBe(-123);
    expect(bruto(null, 50)).toBe(0);
  });

  it('cadastro: P estático em % da Pn da UFV, zera no estágio 2, BI da UFV', () => {
    const alvo = (dev: string, addr: number) => ({ dev, addr, tonId: 'T', tonNome: 'TON', p: { escala: 10, min: 0, max: 1000 }, q: null });
    const ufv: any = { id: 'u', nome: 'UFV', ordem: 1, p_estatico_kw: 150, zera_estagio2: true, watchdog_nativo: false, rota: 'lora', bi_manual: 3, bi_invertida: true,
      inversores: [{ id: 'a', pn_kw: 100 }, { id: 'b', pn_kw: 200 }] };
    const c = montarCadastro([{ ufv, inv: ufv.inversores[0], alvo: alvo('INV A', 1) }, { ufv, inv: ufv.inversores[1], alvo: alvo('INV B', 2) }], { ...PARAMS_PADRAO, t_estagio2_s: 900 });
    expect(c.linhas).toEqual(['ctl geral 2 900 3 1', 'ctl cfg 1 1 500 0 1000 100 INV A', 'ctl cfg 2 2 500 0 1000 100 INV B']);
    expect(c.hash).toMatch(/^[0-9a-f]{6}$/);
  });

  it('ctl em pedaços de 3 trincas com o mesmo seq', () => {
    expect(montarCtl(10, 300, [])).toEqual(['ctl 10 300']);
    expect(montarCtl(10, 300, [[1, 1, 2], [2, 3, 4], [3, 5, 6], [4, 7, -8]])).toEqual(['ctl 10 300 1 1 2 2 3 4 3 5 6', 'ctl 10 300 4 7 -8']);
  });

  it('lê a resposta da TON', () => {
    const r = lerRespostaCtl('ok', 'A c=0a1b2c s=600 m=5 p=S2 1:okr 2:rb500 3:f');
    expect(r).toMatchObject({ ok: true, modo: 'A', hash: '0a1b2c', seg_seguro: 600, seg_manual: 5, pior: 'S2', porIdx: { 1: 'okr', 2: 'rb500', 3: 'f' } });
    expect(lerRespostaCtl('error', 'sem_cfg c=1c9dc5')).toMatchObject({ ok: false, erro: 'sem_cfg', hash: '1c9dc5' });
    expect(lerRespostaCtl('error', 'unknown_cmd').erro).toBe('unknown_cmd');
    expect(resultadoDoToken('okr')).toEqual({ ok: true, texto: 'ok (subindo pela rampa)' });
    expect(resultadoDoToken('rb500').ok).toBe(false);
    expect(resultadoDoToken('=').ok).toBe(true);
  });
});
