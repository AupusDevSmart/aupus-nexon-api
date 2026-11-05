import {
  decidirDemanda, decidirFp, demandaProjetada, despachar, dividirQ, grandezas, janelaReativa, lerMinuto,
  PARAMS_PADRAO, portaoMedidor, qDisponivel, Ufv, validarCadastro,
} from './controle-med.calc';

/** Núcleo do controle pelo MED Concessionária (docs/IOT-CONTROLE-MED-CONCESSIONARIA-IMPLEMENTACAO.md). */

const minuto = (o: Record<string, unknown> = {}) => lerMinuto({
  NSU: 3, cdo: 15, phf: 0, phr: 0, sts: 1, qhfi: 0, qhfc: 0, qhri: 0, qhrc: 0, ke: 0.001, fmt: 2, q: 2,
  seg: 600, posto: 2, ssu_err: 0, fim: 0, mphf: 0, mphr: 0, mqhfi: 0, mqhfc: 0, mqhri: 0, mqhrc: 0, ...o,
}, Date.parse('2026-11-05T15:00:00Z'))!;

const inv = (id: string, pn = 100) => ({ id, nome: id, pn_kw: pn, smax_kva: pn * 1.1, qmax_pct: 60, sinal_q: 1 as const, q_noturno: false });
const ufv = (id: string, ordem: number, invs = [inv(`${id}-1`)], o: Partial<Ufv> = {}): Ufv => ({
  id, nome: id, ordem, p_estatico_kw: 1000, zera_estagio2: false, watchdog_nativo: true, rota: 'internet', inversores: invs, ...o,
});

describe('entrada da SSU', () => {
  it('lê o payload plano do satélite (m*) e converte pulsos em kW/kWh', () => {
    const m = minuto({ phr: 2000, mphr: 3000, mqhfi: 500, mqhrc: 100 });
    const g = grandezas(m);
    expect(g.E_exp).toBeCloseTo(2);            // 2000 × 0,001 kWh
    expect(g.P_exp).toBeCloseTo(180);          // 3000 pulsos/min × 0,001 × 60
    expect(g.Q_ind).toBeCloseTo(30);
    expect(g.Q_cap).toBeCloseTo(6);
    expect(g.T).toBe(900);
  });

  it('projeção do intervalo = medido + minuto atual mantido até o fim', () => {
    // 50 kWh já medidos, 200 kW por mais 450 s → (50·3600 + 200·450)/900 = 300 kW
    expect(demandaProjetada(50, 200, 450, 900)).toBeCloseTo(300);
  });
});

describe('portão de qualidade do medidor', () => {
  const agora = Date.parse('2026-11-05T15:00:30Z');
  it('aprova minuto coerente', () => {
    expect(portaoMedidor(minuto({ mphf: 1000, q: 1 }), null, PARAMS_PADRAO, agora).ok).toBe(true);
  });
  it('reprova: sts=0, erro subindo, minuto faltando e quadrante trocado', () => {
    const ant = { nsu: 3, seg: 780, ssu_err: 0, ts: null };
    const r = portaoMedidor(minuto({ sts: 0, ssu_err: 9, seg: 600, mphf: 1000, q: 3 }), ant, PARAMS_PADRAO, agora);
    expect(r.ok).toBe(false);
    expect(r.lacuna).toBe(true);
    expect(r.motivos.join(' ')).toMatch(/sts=0/);
    expect(r.motivos.join(' ')).toMatch(/subindo/);
    expect(r.motivos.join(' ')).toMatch(/Q3 incoerente/);
  });
  it('reprova minuto velho', () => {
    expect(portaoMedidor(minuto(), null, PARAMS_PADRAO, agora + 10 * 60_000).motivos[0]).toMatch(/mais de 120 s/);
  });
});

describe('demanda (R3: média projetada nunca acima do contrato)', () => {
  const base = { T: 900, contrato: 300, alvo_pct: 95, t_resposta_s: 60, projAnt: null, aguardando: false, banda_pct: 3, folgaLimitada: 0 };

  it('abaixo do contrato e estável → nada', () => {
    expect(decidirDemanda({ ...base, E_kwh: 30, P_kw: 200, seg: 450, corteMax: 300 }).acao).toBe('nada');
  });

  it('acima do contrato com tempo e corte suficientes → aguarda 1 minuto, depois reduz', () => {
    const a = { ...base, E_kwh: 40, P_kw: 400, seg: 600, corteMax: 400 };
    const p1 = decidirDemanda(a);
    expect(p1.D_proj).toBeGreaterThan(300);
    expect(p1.acao).toBe('aguardar');
    const p2 = decidirDemanda({ ...a, aguardando: true });
    expect(p2.acao).toBe('reduzir');
    // P_perm = (285·900 − 40·3600)/600 = 187,5 kW → cortar 212,5
    expect(p2.dP).toBeCloseTo(212.5);
  });

  it('perto do fechamento não espera: reduz no mesmo minuto', () => {
    const p = decidirDemanda({ ...base, E_kwh: 70, P_kw: 400, seg: 100, corteMax: 400 });
    expect(p.acao).toBe('reduzir');
  });

  it('subindo rumo ao contrato (≥ alvo) também dispara', () => {
    const p = decidirDemanda({ ...base, E_kwh: 50, P_kw: 290, seg: 450, corteMax: 0, projAnt: 280 });
    expect(p.D_proj).toBeGreaterThanOrEqual(285);
    expect(p.acao).toBe('reduzir');   // sem corte disponível não adianta esperar
  });

  it('folga com UFV limitada → libera (até a folga menos a banda)', () => {
    const p = decidirDemanda({ ...base, E_kwh: 10, P_kw: 100, seg: 600, corteMax: 100, folgaLimitada: 50 });
    expect(p.acao).toBe('liberar');
    expect(p.dP).toBe(50);
  });

  it('sem contrato não decide', () => {
    expect(decidirDemanda({ ...base, contrato: null, E_kwh: 0, P_kw: 0, seg: 600, corteMax: 0 }).acao).toBe('sem_contrato');
  });
});

describe('FP horário', () => {
  const base = { janela: 'ind' as const, fp_lim: 0.92, fp_alvo: 0.93, banda_kvar: 3, margem_q3: 0, Q_ufv_atual: 0, Q_disp_total: 500, desdeUltimoAjuste: 9999, t_min_ajuste: 300 };

  it('indutivo demais → compensar ΔQ', () => {
    // 100 kWh e 80 kvarh na hora, 30 min restantes a 200 kW e 150 kvar
    const r = decidirFp({ ...base, E_P_h: 100, E_Q_h: 80, P_hat: 200, Q_med: 150, t_rest_hora: 1800 });
    expect(r.acao).toBe('compensar');
    // tan(acos 0,93) = 0,39522 → Q_perm_alvo = (0,39522·(100+100) − 80)/0,5 = −1,91 kvar
    expect(r.Q_perm_alvo).toBeCloseTo(-1.91, 1);
    expect(r.dQ).toBeCloseTo(151.91, 1);
  });

  it('dentro da banda → nada; ritmo mínimo segura novo ajuste', () => {
    expect(decidirFp({ ...base, E_P_h: 100, E_Q_h: 30, P_hat: 200, Q_med: 0, t_rest_hora: 1800 }).acao).not.toBe('compensar');
    expect(decidirFp({ ...base, E_P_h: 100, E_Q_h: 80, P_hat: 200, Q_med: 150, t_rest_hora: 1800, desdeUltimoAjuste: 60 }).acao).toBe('aguardar_ritmo');
  });

  it('exportando (E_P ≈ 0) mira Q importado ≈ 0', () => {
    const r = decidirFp({ ...base, E_P_h: 0, E_Q_h: 0, P_hat: 0, Q_med: 20, t_rest_hora: 1800 });
    expect(r.Q_perm_alvo).toBeCloseTo(0);
    expect(r.acao).toBe('compensar');
  });

  it('janela capacitiva cadastrada (hora local), bit da SSU prevalece', () => {
    const p = { ...PARAMS_PADRAO, janela_cap_ini: '00:00', janela_cap_fim: '06:00' };
    expect(janelaReativa({ ...minuto(), ts: Date.parse('2026-11-05T05:00:00Z') }, p)).toBe('cap');   // 02:00 em SP
    expect(janelaReativa({ ...minuto(), ts: Date.parse('2026-11-05T15:00:00Z') }, p)).toBe('ind');
    expect(janelaReativa({ ...minuto(), posto_reativo: 1 }, p)).toBe('cap');
  });
});

describe('carta e divisão de Q', () => {
  it('Q disponível respeita Smax com o P atual e o Qmax da carta', () => {
    expect(qDisponivel(inv('a'), 0, false)).toBeCloseTo(66);         // 60 % de 110
    expect(qDisponivel(inv('a'), 100, false)).toBeCloseTo(45.83, 1);  // √(110² − 100²)
    expect(qDisponivel(inv('a'), 50, true)).toBe(0);                  // noite sem Q noturno
  });
  it('divide pelo disponível', () => {
    expect(dividirQ(30, [{ id: 'a', q_disp: 10 }, { id: 'b', q_disp: 20 }])).toEqual({ a: 10, b: 20 });
  });
});

describe('despachante', () => {
  const vivo = (P: Record<string, number>) => Object.fromEntries(Object.entries(P).map(([id, p]) => [id, { id, P_kw: p, disponivel: true }]));

  it('corta primeiro a UFV mais distante e libera primeiro a mais próxima', () => {
    const ufvs = [ufv('perto', 1), ufv('longe', 2)];
    const r = despachar({ ufvs, vivo: vivo({ 'perto-1': 80, 'longe-1': 80 }), atuais: {}, dP_g: 100, dP_c: 0, Q_alvo_total: null, noite: false, tetoPlim: null, degrau_min_pct: 3 });
    const c = Object.fromEntries(r.comandos.map((x) => [x.inversor_id, x]));
    expect(c['longe-1'].p_lim_kw).toBe(0);
    expect(c['perto-1'].p_lim_kw).toBe(60);
    expect(c['longe-1'].muda_p && c['perto-1'].muda_p).toBe(true);

    const atuais = { 'perto-1': { p_lim_kw: 60, q_kvar: 0 }, 'longe-1': { p_lim_kw: 0, q_kvar: 0 } };
    const l = despachar({ ufvs, vivo: vivo({ 'perto-1': 60, 'longe-1': 0 }), atuais, dP_g: -50, dP_c: 0, Q_alvo_total: null, noite: false, tetoPlim: null, degrau_min_pct: 3 });
    const d = Object.fromEntries(l.comandos.map((x) => [x.inversor_id, x]));
    expect(d['perto-1'].p_lim_kw).toBe(100);
    expect(d['longe-1'].p_lim_kw).toBe(10);
  });

  it('R2: sem watchdog nativo o limite não passa do P estático; R4: teto do Σp_lim', () => {
    const ufvs = [ufv('a', 1, [inv('a-1')], { watchdog_nativo: false, p_estatico_kw: 40 }), ufv('b', 2)];
    const r = despachar({ ufvs, vivo: vivo({ 'a-1': 30, 'b-1': 30 }), atuais: {}, dP_g: 0, dP_c: 0, Q_alvo_total: null, noite: false, tetoPlim: 100, degrau_min_pct: 3 });
    const c = Object.fromEntries(r.comandos.map((x) => [x.inversor_id, x]));
    expect(c['a-1'].p_lim_kw + c['b-1'].p_lim_kw).toBeCloseTo(100);
    expect(c['a-1'].p_lim_kw).toBeLessThanOrEqual(40);
  });

  it('Q dividido pelo disponível, preso à carta; degrau mínimo evita escrita miúda', () => {
    const ufvs = [ufv('a', 1, [inv('a-1'), inv('a-2')])];
    const r = despachar({ ufvs, vivo: vivo({ 'a-1': 100, 'a-2': 0 }), atuais: {}, dP_g: 0, dP_c: 0, Q_alvo_total: 80, noite: false, tetoPlim: null, degrau_min_pct: 3 });
    const c = Object.fromEntries(r.comandos.map((x) => [x.inversor_id, x]));
    expect(c['a-1'].q_kvar).toBeLessThanOrEqual(45.9);
    expect(c['a-1'].q_kvar + c['a-2'].q_kvar).toBeCloseTo(80, 0);
    expect(c['a-2'].q_pct).toBeGreaterThan(0);
    const miudo = despachar({ ufvs, vivo: vivo({ 'a-1': 100, 'a-2': 0 }), atuais: { 'a-1': { p_lim_kw: 100, q_kvar: 30 }, 'a-2': { p_lim_kw: 100, q_kvar: 50 } }, dP_g: 0, dP_c: 0, Q_alvo_total: 81, noite: false, tetoPlim: null, degrau_min_pct: 3 });
    expect(miudo.comandos.every((x) => !x.muda_q)).toBe(true);
  });

  it('inversor indisponível fica de fora', () => {
    const ufvs = [ufv('a', 1)];
    const r = despachar({ ufvs, vivo: { 'a-1': { id: 'a-1', P_kw: null, disponivel: false, motivo: 'leitura velha' } }, atuais: {}, dP_g: 50, dP_c: 0, Q_alvo_total: 10, noite: false, tetoPlim: null, degrau_min_pct: 3 });
    expect(r.comandos[0].muda_p || r.comandos[0].muda_q).toBe(false);
    expect(r.comandos[0].motivo).toEqual(['leitura velha']);
  });
});

describe('cadastro (R2/R4)', () => {
  it('teto do Σp_lim pelo pior caso e avisos', () => {
    const p = { ...PARAMS_PADRAO, d_contr_g_kw: 990, alvo_g_pct: 90, t_estagio2_s: 300 };
    const v = validarCadastro(p, [ufv('a', 1, [inv('a-1', 500)], { p_estatico_kw: 400, watchdog_nativo: false })]);
    // folga = (990 − 891)·900 − 0 → teto = 891 + 89100/180 = 1386
    expect(v.tetoPlim).toBeCloseTo(1386);
    expect(v.avisos.join(' ')).toMatch(/watchdog nativo/);
  });
});
