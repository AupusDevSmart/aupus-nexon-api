import {
  decidirDemanda, decidirFp, demandaProjetada, despachar, dividirQ, grandezas, janelaReativa, lerMinuto,
  PARAMS_PADRAO, portaoMedidor, qDisponivel, tetoQueda, Ufv, validarCadastro,
} from './controle-med.calc';

/** Núcleo do controle pelo MED Concessionária (docs/IOT-CONTROLE-MED-CONCESSIONARIA-IMPLEMENTACAO.md). */

const minuto = (o: Record<string, unknown> = {}) => lerMinuto({
  NSU: 3, cdo: 15, phf: 0, phr: 0, sts: 1, qhfi: 0, qhfc: 0, qhri: 0, qhrc: 0, ke: 0.001, fmt: 2, q: 2,
  seg: 600, posto: 2, ssu_err: 0, fim: 0, mphf: 0, mphr: 0, mqhfi: 0, mqhfc: 0, mqhri: 0, mqhrc: 0, ...o,
}, Date.parse('2026-11-05T15:00:00Z'))!;

const inv = (id: string, pn = 100) => ({ id, nome: id, pn_kw: pn, smax_kva: pn * 1.1, qmax_pct: 60, sinal_q: 1 as 1 | -1, q_noturno: false });
const ufv = (id: string, ordem: number, invs = [inv(`${id}-1`)], o: Partial<Ufv> = {}): Ufv => ({
  id, nome: id, ordem, p_estatico_kw: 1000, zera_estagio2: false, watchdog_nativo: true, rota: 'internet', inversores: invs, ...o,
});

describe('entrada da SSU', () => {
  it('lê o payload da TON-V2 direta (acumulado em data{}, cdo string)', () => {
    const m = lerMinuto({
      q: 2, ke: 0.009, NSU: 1183, fim: 0, fmt: 2, seg: 119, posto: 0, ssu_err: 1,
      min: { phf: 0, phr: 147, qhfc: 0, qhfi: 0, qhrc: 0, qhri: 0 },
      data: { cdo: '5', phf: 0, phr: 245, sts: 1, qhfc: 0, qhfi: 0, qhrc: 0, qhri: 0 },
    }, Date.parse('2026-11-19T16:53:07Z'))!;
    expect(m).not.toBeNull();
    expect(m.cdo).toBe(5);
    expect(m.sts).toBe(1);
    expect(m.acc.phr).toBe(245);
    const g = grandezas(m);
    expect(g.T).toBe(300);
    expect(g.P_exp).toBeCloseTo(147 * 0.009 * 60, 6);   // 79,4 kW
    expect(g.E_exp).toBeCloseTo(245 * 0.009, 6);
  });

  it('parcial de 30 s ("dur":30): kW = pulsos × ke × 120; sem dur = 60 s', () => {
    const m = minuto({ dur: 30, mphr: 1500 });
    expect(m.dur).toBe(30);
    expect(grandezas(m).P_exp).toBeCloseTo(180);       // 1500 pulsos em 30 s × 0,001 × 120
    expect(minuto({ mphr: 1500 }).dur).toBe(60);
    // lacuna só quando falta mais de 1,5 parcial
    const ant = { nsu: 3, seg: 640, ssu_err: 0, ts: 0 };
    expect(portaoMedidor(minuto({ dur: 30, seg: 610 }), ant, PARAMS_PADRAO, Date.parse('2026-11-05T15:00:00Z')).lacuna).toBe(false);
    expect(portaoMedidor(minuto({ dur: 30, seg: 580 }), ant, PARAMS_PADRAO, Date.parse('2026-11-05T15:00:00Z')).lacuna).toBe(true);
  });

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
    // exportação pura (Q = 0) com quadrante Q1 no último segundo: não reprova
    expect(portaoMedidor(minuto({ mphr: 1000, q: 1 }), null, PARAMS_PADRAO, agora).ok).toBe(true);
    // com reativo, Q1 exportando continua incoerente
    expect(portaoMedidor(minuto({ mphr: 1000, mqhfi: 300, q: 1 }), null, PARAMS_PADRAO, agora).ok).toBe(false);
  });
  it('reprova: sts=0, erro subindo, minuto faltando e quadrante trocado', () => {
    const ant = { nsu: 3, seg: 780, ssu_err: 0, ts: null };
    const r = portaoMedidor(minuto({ sts: 0, ssu_err: 9, seg: 600, mphf: 1000, mqhfi: 300, q: 3 }), ant, PARAMS_PADRAO, agora);
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

  it('sobra de reativo sem nada aplicado nas UFVs → nada (não "devolver")', () => {
    const r = decidirFp({ ...base, E_P_h: 100, E_Q_h: 0, P_hat: 200, Q_med: 0, t_rest_hora: 1800 });
    expect(r.acao).toBe('nada');
    expect(decidirFp({ ...base, E_P_h: 100, E_Q_h: 0, P_hat: 200, Q_med: 0, t_rest_hora: 1800, Q_ufv_atual: 50 }).acao).toBe('devolver');
  });

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
    // o posto do medidor não manda: à tarde é indutivo mesmo com pr=1
    expect(janelaReativa({ ...minuto(), posto_reativo: 1, ts: Date.parse('2026-11-05T15:00:00Z') }, p)).toBe('ind');
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

describe('R4 olhando o medidor (queda de comunicação com consumo zero)', () => {
  const u = (id: string, est: number, zera = false) => ufv(id, 1, [inv(`${id}-1`)], { p_estatico_kw: est, zera_estagio2: zera });
  it('campo: início do intervalo, P estático 45/45 com a B zerando → não limita', () => {
    const t = tetoQueda({ contrato: 100, T: 900, E_kwh: 0, seg: 900, t_val: 60, t_estagio2: 600, ufvs: [u('a', 45), u('b', 45, true)] })!;
    expect(t).toBeCloseTo((90000 - 90 * 600 - 45 * 240) / 60, 6);   // 420 kW
  });
  it('bancada 5 min: aperta no início e mais ainda com o intervalo já gasto', () => {
    const ufvs = [u('a', 45), u('b', 45, true)];
    const ini = tetoQueda({ contrato: 100, T: 300, E_kwh: 0, seg: 300, t_val: 90, t_estagio2: 180, ufvs })!;
    expect(ini).toBeCloseTo((30000 - 90 * 180 - 45 * 30) / 90, 6);   // ≈ 138 kW
    const gasto = tetoQueda({ contrato: 100, T: 300, E_kwh: 100 * 120 / 3600, seg: 180, t_val: 90, t_estagio2: 180, ufvs })!;
    expect(gasto).toBeLessThan(ini);
  });
  it('fazenda consumindo (exportou pouco) → teto alto', () => {
    const t = tetoQueda({ contrato: 100, T: 900, E_kwh: 2, seg: 600, t_val: 60, t_estagio2: 600, ufvs: [u('a', 45), u('b', 45, true)] })!;
    expect(t).toBeGreaterThan(200);
  });
  it('Σ P estático acima do contrato bloqueia o ativo', () => {
    const v = validarCadastro({ ...PARAMS_PADRAO, d_contr_g_kw: 100 }, [u('a', 100), u('b', 100)], 300);
    expect(v.bloqueios.join(' ')).toMatch(/Σ P estático/);
  });
});

describe('despachante', () => {
  const vivo = (P: Record<string, number>) => Object.fromEntries(Object.entries(P).map(([id, p]) => [id, { id, P_kw: p, disponivel: true }]));

  it('reativo prioritário: reduz P para caber o Q na carta e manda os dois; sem prioridade, Q é cortado', () => {
    const inv44 = (id: string) => ({ ...inv(id), qmax_pct: 44 });       // Pn 100, Smax 110 → Q teto 48,4
    const ufvs = [ufv('a', 1, [inv44('a-1')]), ufv('b', 2, [inv44('b-1')])];
    const base = { ufvs, vivo: vivo({ 'a-1': 100, 'b-1': 100 }), atuais: {}, dP_g: 0, dP_c: 0, Q_alvo_total: 120, noite: false, tetoPlim: null, degrau_min_pct: 3, controlaP: false };
    const r = despachar({ ...base, prioridadeQ: true });
    for (const c of r.comandos) {
      expect(c.q_kvar).toBeCloseTo(48.4, 1);                              // teto do equipamento
      expect(c.p_lim_kw).toBeCloseTo(Math.sqrt(110 ** 2 - 48.4 ** 2), 1); // ≈ 98,8 kW
      expect(c.muda_p && c.muda_q && c.p_por_q).toBe(true);
    }
    const s = despachar({ ...base, prioridadeQ: false });
    for (const c of s.comandos) {
      expect(c.q_kvar).toBeCloseTo(Math.sqrt(110 ** 2 - 100 ** 2), 1);    // ≈ 45,8: o P manda
      expect(c.muda_p).toBe(false);
    }
  });

  it('sinal do Q%: inversor com sinal −1 (Sungrow) fornece reativo com percentual negativo', () => {
    const ufvs = [ufv('a', 1, [{ ...inv('a-1'), sinal_q: -1 as 1 | -1 }])];
    const r = despachar({ ufvs, vivo: vivo({ 'a-1': 50 }), atuais: {}, dP_g: 0, dP_c: 0, Q_alvo_total: 30, noite: false, tetoPlim: null, degrau_min_pct: 3, controlaP: false, prioridadeQ: true });
    expect(r.comandos[0].q_kvar).toBe(30);
    expect(r.comandos[0].q_pct).toBe(-30);
  });

  it('corte proporcional (10 % de cada) e liberação proporcional', () => {
    const ufvs = [ufv('perto', 1), ufv('longe', 2)];
    const r = despachar({ ufvs, vivo: vivo({ 'perto-1': 100, 'longe-1': 100 }), atuais: {}, dP_g: 20, dP_c: 0, Q_alvo_total: null, noite: false, tetoPlim: null, degrau_min_pct: 3, pisoTotal: 100 });
    const c = Object.fromEntries(r.comandos.map((x) => [x.inversor_id, x]));
    expect(c['perto-1'].p_lim_kw).toBe(90);
    expect(c['longe-1'].p_lim_kw).toBe(90);
    expect(r.noPiso).toBe(false);
    const atuais = { 'perto-1': { p_lim_kw: 60, q_kvar: 0 }, 'longe-1': { p_lim_kw: 80, q_kvar: 0 } };
    const l = despachar({ ufvs, vivo: vivo({ 'perto-1': 60, 'longe-1': 80 }), atuais, dP_g: -30, dP_c: 0, Q_alvo_total: null, noite: false, tetoPlim: null, degrau_min_pct: 3, pisoTotal: 100 });
    const d = Object.fromEntries(l.comandos.map((x) => [x.inversor_id, x]));
    expect(d['perto-1'].p_lim_kw).toBe(80);   // folga 40 de 60 → 2/3 dos 30
    expect(d['longe-1'].p_lim_kw).toBe(90);   // folga 20 de 60 → 1/3
  });

  it('piso = parte do contrato: nunca abaixo de 50 % (contrato 100, 2 × 100 kW) e avisa', () => {
    const ufvs = [ufv('perto', 1), ufv('longe', 2)];
    const r = despachar({ ufvs, vivo: vivo({ 'perto-1': 100, 'longe-1': 100 }), atuais: {}, dP_g: 150, dP_c: 0, Q_alvo_total: null, noite: false, tetoPlim: null, degrau_min_pct: 3, pisoTotal: 100 });
    const c = Object.fromEntries(r.comandos.map((x) => [x.inversor_id, x]));
    expect(c['perto-1'].p_lim_kw).toBe(50);
    expect(c['longe-1'].p_lim_kw).toBe(50);
    expect(r.noPiso).toBe(true);
    // limite já no piso e P medido alto (inversor/mala não obedeceu): não desce mais
    const de = despachar({ ufvs, vivo: vivo({ 'perto-1': 100, 'longe-1': 100 }), atuais: { 'perto-1': { p_lim_kw: 50, q_kvar: 0 }, 'longe-1': { p_lim_kw: 50, q_kvar: 0 } }, dP_g: 30, dP_c: 0, Q_alvo_total: null, noite: false, tetoPlim: null, degrau_min_pct: 3, pisoTotal: 100 });
    expect(de.comandos.every((x) => x.p_lim_kw === 50 && !x.muda_p)).toBe(true);
    expect(de.noPiso).toBe(true);
  });

  it('teto R4 proporcional e nunca abaixo do contrato', () => {
    const ufvs = [ufv('perto', 1), ufv('longe', 2)];
    const r = despachar({ ufvs, vivo: vivo({ 'perto-1': 100, 'longe-1': 100 }), atuais: {}, dP_g: 0, dP_c: 0, Q_alvo_total: null, noite: false, tetoPlim: 145, degrau_min_pct: 3, pisoTotal: 100 });
    expect(r.comandos.map((x) => x.p_lim_kw)).toEqual([72.5, 72.5]);
    const b = despachar({ ufvs, vivo: vivo({ 'perto-1': 100, 'longe-1': 100 }), atuais: {}, dP_g: 0, dP_c: 0, Q_alvo_total: null, noite: false, tetoPlim: 95, degrau_min_pct: 3, pisoTotal: 100 });
    expect(b.comandos.map((x) => x.p_lim_kw)).toEqual([50, 50]);
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
    // início do intervalo, limite = contrato + 5 %: (1039,5·900 − 400·300 − 400·420) / 180 = 3597,5
    expect(v.tetoPlim).toBeCloseTo(3597.5);
    expect(v.avisos.join(' ')).toMatch(/watchdog nativo/);
  });

  it('R4 desligado: sem teto e avisa quando o pior caso passa da tolerância', () => {
    const ufvs = [ufv('a', 1, [inv('a-1', 110)], { p_estatico_kw: 50 }), ufv('b', 2, [inv('b-1', 110)], { p_estatico_kw: 50, zera_estagio2: true })];
    const base = { ...PARAMS_PADRAO, d_contr_g_kw: 110, t_validade_internet_s: 45, t_estagio2_s: 180 };
    const ok = validarCadastro({ ...base, r4_ativo: 0 }, ufvs, 900);
    expect(ok.tetoPlim).toBeNull();
    expect(ok.avisos.join(' ')).not.toMatch(/R4 desligado/);       // campo (15 min, P estático 50+50): seguro
    const alto = validarCadastro({ ...base, r4_ativo: 0 }, [ufv('a', 1, [inv('a-1', 400)], { p_estatico_kw: 100 })], 900);
    expect(alto.avisos.join(' ')).toMatch(/R4 desligado/);
  });
});

describe('lei proporcional da geração (24/11)', () => {
  const base = { T: 900, contrato: 110, alvo_pct: 100, t_resposta_s: 60, projAnt: null, aguardando: false, banda_pct: 3, corteMax: 220, kp: { min: 0.6, max: 1, reduzir: 1.1 } };

  it('erro > 0: libera Kp·erro, Kp 0,6 no início e 1,0 no fim do intervalo', () => {
    // P_perm = (110·900 − 0)/900 = 110; erro = 110 − 80 = 30
    const ini = decidirDemanda({ ...base, E_kwh: 0, P_kw: 80, seg: 900, folgaLimitada: 100 });
    expect(ini.acao).toBe('liberar');
    expect(ini.kp).toBeCloseTo(0.6);
    expect(ini.dP).toBeCloseTo(18);
    // meio: seg 450, E = 80·450/3600 = 10 → P_perm = (99000 − 36000)/450 = 140; erro 60; Kp 0,8 → 48
    const meio = decidirDemanda({ ...base, E_kwh: 10, P_kw: 80, seg: 450, folgaLimitada: 100 });
    expect(meio.kp).toBeCloseTo(0.8);
    expect(meio.dP).toBeCloseTo(48);
    // nada limitado → nada
    expect(decidirDemanda({ ...base, E_kwh: 0, P_kw: 80, seg: 900, folgaLimitada: 0 }).acao).toBe('nada');
  });

  it('liberação limitada à folga dos inversores', () => {
    expect(decidirDemanda({ ...base, E_kwh: 0, P_kw: 80, seg: 900, folgaLimitada: 5 }).dP).toBeCloseTo(5);
  });

  it('erro < 0: reduz 1,1·|erro| no mesmo ciclo, sem aguardar', () => {
    // P_perm = 110; P = 125 → erro −15 → corta 16,5
    const r = decidirDemanda({ ...base, E_kwh: 0, P_kw: 125, seg: 900, folgaLimitada: 0 });
    expect(r.acao).toBe('reduzir');
    expect(r.dP).toBeCloseTo(16.5);
  });
});

describe('R4 com tolerância e mínimo por UFV (24/11)', () => {
  it('teto usa contrato + tolerância', () => {
    const u = (id: string, est: number, zera = false) => ufv(id, 1, [inv(`${id}-1`)], { p_estatico_kw: est, zera_estagio2: zera });
    const a = { contrato: 110, T: 900, E_kwh: 110 * 780 / 3600, seg: 120, t_val: 45, t_estagio2: 180, ufvs: [u('a', 50), u('b', 50, true)] };
    expect(tetoQueda(a)!).toBeCloseTo((13200 - 100 * 75) / 45, 3);                       // ≈ 126,7
    expect(tetoQueda({ ...a, tol_pct: 5 })!).toBeCloseTo((115.5 * 900 - 110 * 780 - 100 * 75) / 45, 3);   // ≈ 236,7
  });

  it('mínimo configurado por UFV (% de Pn) no lugar da parte do contrato', () => {
    const ufvs = [ufv('a', 1, [inv('a-1')], { piso_pct: 70 }), ufv('b', 2)];
    const vivo = { 'a-1': { id: 'a-1', P_kw: 100, disponivel: true }, 'b-1': { id: 'b-1', P_kw: 100, disponivel: true } };
    const r = despachar({ ufvs, vivo, atuais: {}, dP_g: 150, dP_c: 0, Q_alvo_total: null, noite: false, tetoPlim: null, degrau_min_pct: 3, pisoTotal: 100 });
    const c = Object.fromEntries(r.comandos.map((x) => [x.inversor_id, x]));
    expect(c['a-1'].p_lim_kw).toBe(70);    // mínimo da UFV A
    expect(c['b-1'].p_lim_kw).toBe(50);    // B sem mínimo: parte do contrato
    expect(r.noPiso).toBe(true);
  });
});

describe('capabilidade: FP mínimo do fabricante (Chimarrão, 25/11)', () => {
  const vivo = (P: Record<string, number>) => Object.fromEntries(Object.entries(P).map(([id, p]) => [id, { id, P_kw: p, disponivel: true }]));
  const inv08 = (id: string) => ({ ...inv(id), qmax_pct: 100, fp_min: 0.8 });   // Pn 100, Smax 110, tanφ = 0,75
  const base = (P: number, prio: boolean, Q = 200) => ({
    ufvs: [ufv('a', 1, [inv08('a-1')])], vivo: vivo({ 'a-1': P }), atuais: {}, dP_g: 0, dP_c: 0, Q_alvo_total: Q,
    noite: false, tetoPlim: null, degrau_min_pct: 3, controlaP: false, prioridadeQ: prio,
  });
  const fpDe = (p: number, q: number) => p / Math.hypot(p, q);

  it('Q disponível ≤ P·tan(acos FPmin); P zero → Q zero', () => {
    expect(qDisponivel(inv08('a'), 40, false)).toBeCloseTo(30, 6);
    expect(qDisponivel(inv08('a'), 0, false)).toBe(0);
    expect(qDisponivel(inv('a'), 0, false)).toBeCloseTo(66);         // sem fp_min: comportamento antigo
  });
  it('sem prioridade: Q cortado pelo FP com P baixo', () => {
    const c = despachar(base(20, false)).comandos[0];
    expect(c.q_kvar).toBeCloseTo(15, 6);
    expect(fpDe(20, c.q_kvar)).toBeGreaterThanOrEqual(0.8 - 1e-9);
  });
  it('reativo prioritário nunca passa do FP mínimo nem do Smax, com qualquer P', () => {
    for (const P of [0, 5, 30, 60, 88, 100]) {
      const c = despachar(base(P, true)).comandos[0];
      const pFinal = Math.min(P, c.p_lim_kw);
      expect(Math.abs(c.q_kvar)).toBeLessThanOrEqual(0.75 * pFinal + 1e-6);
      expect(Math.hypot(c.p_lim_kw, c.q_kvar)).toBeLessThanOrEqual(110 + 1e-6);
    }
  });
  it('reativo prioritário com P cheio: Q ≤ S·sen φ (66) e P cabe na carta', () => {
    const c = despachar(base(100, true)).comandos[0];
    expect(c.q_kvar).toBeCloseTo(66, 6);
    expect(c.p_lim_kw).toBeCloseTo(88, 6);
  });
  it('Q pedido negativo também respeita a trava', () => {
    const c = despachar(base(40, false, -200)).comandos[0];
    expect(c.q_kvar).toBeCloseTo(-30, 6);
  });
  it('cadastro avisa inversor sem FP mínimo', () => {
    const v = validarCadastro(PARAMS_PADRAO, [ufv('a', 1)], 900);
    expect(v.avisos.join(' ')).toMatch(/FP mínimo/);
    const w = validarCadastro(PARAMS_PADRAO, [ufv('a', 1, [inv08('a-1')])], 900);
    expect(w.avisos.join(' ')).not.toMatch(/FP mínimo/);
  });
});
