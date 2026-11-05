/**
 * Controle automático pelo MED Concessionária (SSU) — núcleo PURO (sem banco/MQTT).
 * Spec: /var/www/nexon-controle-med-concessionaria (1).md (revisão 28/10) + decisões R1–R12
 * (docs/IOT-CONTROLE-MED-CONCESSIONARIA-DIVERGENCIAS.md §6). Implementação e o que ficou
 * de fora: docs/IOT-CONTROLE-MED-CONCESSIONARIA-IMPLEMENTACAO.md.
 *
 * Unidades: energia kWh, potência kW, reativo kvar, tempo s. Q da UFV positivo = fornece
 * reativo (compensa o indutivo importado); negativo = absorve.
 */

export type Modo = 'desligado' | 'sombra' | 'ativo';
export type Controle = 'fp' | 'demanda_g' | 'demanda_c';
export const CONTROLES: readonly Controle[] = ['demanda_c', 'demanda_g', 'fp'];   // ordem de prioridade
export type Modos = Record<Controle, Modo>;
export const MODOS_PADRAO: Modos = { fp: 'desligado', demanda_g: 'desligado', demanda_c: 'desligado' };

export interface Params {
  d_contr_g_kw: number | null;      // demanda de geração contratada (limite — R3: nunca passar)
  alvo_g_pct: number;               // ritmo de geração planejado (% do contrato)
  d_contr_c_kw: number | null;      // demanda de carga (verde: valor único; azul: fora de ponta)
  d_contr_c_ponta_kw: number | null;
  alvo_c_pct: number;
  fp_lim_ind: number; fp_lim_cap: number;
  fp_alvo_ind: number; fp_alvo_cap: number;
  janela_cap_ini: string;           // "HH:MM" — até a TON publicar o posto reativo da SSU
  janela_cap_fim: string;
  margem_q3_kvar: number;
  banda_pct: number;                // folga antes de devolver Q / liberar P (% do limite)
  t_min_ajuste_fp_s: number;
  t_resposta_s: number;             // nuvem → TON → inversor + rampa
  degrau_min_pct: number;           // menor mudança que vale escrever (% Smax)
  t_validade_internet_s: number;
  t_validade_lora_s: number;
  t_estagio2_s: number;
  n_retomada: number;
  ssu_err_max_min: number;          // erros de leitura da SSU aceitos por minuto
  idade_max_ssu_s: number;
  idade_max_inv_internet_s: number;
  idade_max_inv_lora_s: number;
}

export const PARAMS_PADRAO: Params = {
  d_contr_g_kw: null, alvo_g_pct: 95, d_contr_c_kw: null, d_contr_c_ponta_kw: null, alvo_c_pct: 95,
  fp_lim_ind: 0.92, fp_lim_cap: 0.92, fp_alvo_ind: 0.93, fp_alvo_cap: 0.93,
  janela_cap_ini: '00:00', janela_cap_fim: '06:00', margem_q3_kvar: 0,
  banda_pct: 3, t_min_ajuste_fp_s: 300, t_resposta_s: 60, degrau_min_pct: 3,
  t_validade_internet_s: 180, t_validade_lora_s: 300, t_estagio2_s: 600, n_retomada: 3,
  ssu_err_max_min: 5, idade_max_ssu_s: 120, idade_max_inv_internet_s: 120, idade_max_inv_lora_s: 300,
};

export interface Inversor {
  id: string; nome?: string;
  pn_kw: number; smax_kva: number;
  qmax_pct: number;                 // Q máximo pela carta (% de Smax)
  sinal_q: 1 | -1;                  // sinal do sp_q_pct que FORNECE reativo neste modelo
  q_noturno: boolean;
}
export interface Ufv {
  id: string; nome: string;
  ordem: number;                    // distância ao medidor (1 = mais próxima)
  p_estatico_kw: number;            // P no modo seguro (estágio 1)
  zera_estagio2: boolean;
  watchdog_nativo: boolean;         // validado em campo (R2)
  rota: 'internet' | 'lora';
  inversores: Inversor[];
}

// ------------------------------------------------------------------ entradas

export interface Pulsos { phf: number; phr: number; qhfi: number; qhfc: number; qhri: number; qhrc: number }
/** Minuto (fim=0) ou fechamento (fim=1) do medidor, como a TON publica. */
export interface MinutoSsu {
  ts: number; nsu: number | null; seg: number; cdo: number; ke: number; sts: number | null;
  ssu_err: number | null; q: number | null; posto: number | null; fim: 0 | 1;
  acc: Pulsos;                      // acumulado do intervalo
  min: Pulsos;                      // último minuto
  posto_reativo?: number | null;    // 1 capacitivo, 2 indutivo (quando a TON publicar)
}

const num = (v: unknown, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const pulsos = (o: any): Pulsos => ({
  phf: num(o?.phf), phr: num(o?.phr), qhfi: num(o?.qhfi), qhfc: num(o?.qhfc), qhri: num(o?.qhri), qhrc: num(o?.qhrc),
});

/** Payload da SSU (TON-V2, plano ou com min{}) → MinutoSsu. null = não é minuto do medidor. */
export function lerMinuto(d: any, ts: number): MinutoSsu | null {
  if (!d || typeof d !== 'object' || d.phf === undefined || d.seg === undefined) return null;
  const min = d.min ?? { phf: d.mphf, phr: d.mphr, qhfi: d.mqhfi, qhfc: d.mqhfc, qhri: d.mqhri, qhrc: d.mqhrc };
  const ke = num(d.ke) > 0 ? num(d.ke) : 0.0003;
  return {
    ts, nsu: d.NSU == null ? null : num(d.NSU), seg: Math.max(0, num(d.seg)), cdo: num(d.cdo) > 0 ? num(d.cdo) : 15, ke,
    sts: d.sts == null ? null : num(d.sts), ssu_err: d.ssu_err == null ? null : num(d.ssu_err),
    q: d.q == null ? null : num(d.q), posto: d.posto == null ? null : num(d.posto),
    fim: num(d.fim) === 1 ? 1 : 0, acc: pulsos(d), min: pulsos(min),
    posto_reativo: d.pr == null ? null : num(d.pr),
  };
}

/** Grandezas do minuto (convenção do A-966: indutivo = qhfi+qhri, capacitivo = qhfc+qhrc). */
export function grandezas(m: MinutoSsu) {
  const k = m.ke;
  const T = m.cdo * 60;
  return {
    T,
    E_imp: m.acc.phf * k, E_exp: m.acc.phr * k,                 // kWh no intervalo
    P_imp: m.min.phf * k * 60, P_exp: m.min.phr * k * 60,       // kW (média do minuto)
    Q_ind: (m.min.qhfi + m.min.qhri) * k * 60,
    Q_cap: (m.min.qhfc + m.min.qhrc) * k * 60,
  };
}

/** Média projetada do intervalo (R3): já medido + o minuto atual mantido até o fim. */
export function demandaProjetada(E_kwh: number, P_kw: number, seg: number, T: number): number {
  return (E_kwh * 3600 + P_kw * seg) / T;
}

// ------------------------------------------------------------ portão de qualidade

export interface EstadoAnterior {
  nsu: number | null; seg: number | null; ssu_err: number | null; ts: number | null;
}
export interface Portao { ok: boolean; motivos: string[]; lacuna: boolean }

export function portaoMedidor(m: MinutoSsu, ant: EstadoAnterior | null, p: Params, agora: number): Portao {
  const motivos: string[] = [];
  let lacuna = false;
  if (m.sts === 0) motivos.push('Medidor sinaliza enlace degradado ou formato errado (sts=0)');
  if (agora - m.ts > p.idade_max_ssu_s * 1000) motivos.push(`Minuto do medidor com mais de ${p.idade_max_ssu_s} s`);
  if (ant?.ssu_err != null && m.ssu_err != null && m.ssu_err - ant.ssu_err > p.ssu_err_max_min) {
    motivos.push(`Erros de leitura da SSU subindo (+${m.ssu_err - ant.ssu_err} no minuto)`);
  }
  if (ant && ant.nsu != null && m.nsu != null && ant.seg != null) {
    // mesmo intervalo: o seg cai ~60 por minuto; intervalo novo: o NSU sobe 1
    if (m.nsu === ant.nsu && m.fim === 0 && ant.seg - m.seg > 90) lacuna = true;
    if (m.nsu > ant.nsu + 1) lacuna = true;
  }
  if (lacuna) motivos.push('Faltou minuto do medidor no intervalo (orçamento incerto)');
  const g = grandezas(m);
  // Quadrante coerente com o fluxo: importando → Q1/Q4; exportando → Q2/Q3 (só com fluxo claro).
  if (m.q != null && m.q >= 1 && m.q <= 4) {
    const imp = g.P_imp > 1 && g.P_exp < 0.1 * g.P_imp;
    const exp = g.P_exp > 1 && g.P_imp < 0.1 * g.P_exp;
    if ((imp && (m.q === 2 || m.q === 3)) || (exp && (m.q === 1 || m.q === 4))) {
      motivos.push(`Quadrante Q${m.q} incoerente com o sentido da potência`);
    }
  }
  return { ok: motivos.length === 0, motivos, lacuna };
}

// ------------------------------------------------------------- demanda (R3)

export type AcaoDemanda = 'nada' | 'aguardar' | 'reduzir' | 'liberar' | 'sem_contrato';
export interface PedidoDemanda {
  acao: AcaoDemanda; D_proj: number | null; P_perm: number | null; dP: number; contrato: number | null;
  alvo: number | null; motivo: string;
}

/**
 * Demanda de geração (exportação) ou de carga (importação) — R3:
 *  - D_proj < contrato e não subindo rumo a ele → nada (ou liberar folga, se houver UFV limitada);
 *  - D_proj ≥ contrato (ou ≥ alvo e subindo): se ainda dá para esperar 1 min (o corte máximo
 *    ainda fecha o intervalo ≤ contrato), espera; senão pede a correção no mesmo minuto.
 * `corteMax` = quanto o atuador consegue tirar (geração: P das UFVs; carga: P liberável das UFVs).
 */
export function decidirDemanda(a: {
  E_kwh: number; P_kw: number; seg: number; T: number;
  contrato: number | null; alvo_pct: number; corteMax: number; t_resposta_s: number;
  projAnt: number | null; aguardando: boolean; banda_pct: number; folgaLimitada: number;
}): PedidoDemanda {
  if (!a.contrato || a.contrato <= 0) {
    return { acao: 'sem_contrato', D_proj: null, P_perm: null, dP: 0, contrato: null, alvo: null, motivo: 'Contrato não cadastrado' };
  }
  const alvo = a.contrato * Math.min(100, Math.max(1, a.alvo_pct)) / 100;
  const D_proj = demandaProjetada(a.E_kwh, a.P_kw, a.seg, a.T);
  const P_perm = a.seg > 0 ? (alvo * a.T - a.E_kwh * 3600) / a.seg : 0;
  const banda = a.contrato * a.banda_pct / 100;
  const base = { D_proj, P_perm, contrato: a.contrato, alvo };
  const subindo = a.projAnt != null && D_proj > a.projAnt + 1e-6;
  const gatilho = D_proj >= a.contrato || (D_proj >= alvo && subindo);
  if (!gatilho) {
    if (a.folgaLimitada > 0 && P_perm - a.P_kw > banda) {
      const dP = Math.min(a.folgaLimitada, P_perm - a.P_kw - banda);
      return { acao: 'liberar', ...base, dP, motivo: `Projeção ${fmt(D_proj)} kW com folga: liberar ${fmt(dP)} kW` };
    }
    return { acao: 'nada', ...base, dP: 0, motivo: `Projeção ${fmt(D_proj)} kW abaixo do contrato ${fmt(a.contrato)} kW` };
  }
  // Ainda dá para esperar 1 min? P mantido por 60 s + t_resposta, depois o corte máximo.
  const espera = 60 + a.t_resposta_s;
  const P_pos = Math.max(0, a.P_kw - a.corteMax);
  const podeEsperar = a.seg > espera
    && a.E_kwh * 3600 + a.P_kw * espera + P_pos * (a.seg - espera) <= a.contrato * a.T;
  if (podeEsperar && !a.aguardando) {
    return { acao: 'aguardar', ...base, dP: 0, motivo: `Projeção ${fmt(D_proj)} kW ${D_proj >= a.contrato ? '≥ contrato' : 'subindo'}: aguardando o próximo minuto` };
  }
  const dP = Math.max(0, a.P_kw - P_perm);
  return { acao: 'reduzir', ...base, dP, motivo: `Projeção ${fmt(D_proj)} kW ${D_proj >= a.contrato ? '≥ contrato' : 'subindo'} ${fmt(a.contrato)} kW: reduzir ${fmt(dP)} kW` };
}

// --------------------------------------------------------------------- FP (6.1)

export type Janela = 'ind' | 'cap';
export interface PedidoFp {
  acao: 'nada' | 'compensar' | 'devolver' | 'aguardar_ritmo' | 'sem_atuador' | 'hora_perdida';
  janela: Janela; Q_med: number; Q_perm_alvo: number; Q_perm_lim: number; dQ: number; fp_hora: number | null;
  t_rest_hora: number; motivo: string;
}

/** Janela do reativo: bit da SSU quando houver; senão a janela capacitiva cadastrada (hora local). */
export function janelaReativa(m: MinutoSsu, p: Params, tz = 'America/Sao_Paulo'): Janela {
  if (m.posto_reativo === 1) return 'cap';
  if (m.posto_reativo === 2) return 'ind';
  const hm = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(m.ts));
  const min = (s: string) => { const [h, mm] = s.split(':').map(Number); return (h % 24) * 60 + (mm || 0); };
  const t = min(hm), a = min(p.janela_cap_ini), b = min(p.janela_cap_fim);
  if (a === b) return 'ind';
  return (a < b ? t >= a && t < b : t >= a || t < b) ? 'cap' : 'ind';
}

const tanAcos = (fp: number) => Math.tan(Math.acos(Math.min(1, Math.max(0.01, fp))));

/**
 * FP horário (6.1): E_P/E_Q da hora até agora + P̂ mantido até a virada. Q_perm = reativo médio
 * que ainda cabe no resto da hora sem passar do alvo. ΔQ > 0 → falta compensar.
 */
export function decidirFp(a: {
  janela: Janela; E_P_h: number; E_Q_h: number; P_hat: number; Q_med: number; t_rest_hora: number;
  fp_lim: number; fp_alvo: number; banda_kvar: number; margem_q3: number;
  Q_ufv_atual: number; Q_disp_total: number; desdeUltimoAjuste: number; t_min_ajuste: number;
}): PedidoFp {
  const h = Math.max(60, a.t_rest_hora) / 3600;
  const Q_perm_lim = (tanAcos(a.fp_lim) * (a.E_P_h + a.P_hat * h) - a.E_Q_h) / h;
  // horas de exportação (E_P ≈ 0): Q_perm ≈ 0 → mira Q importado ≈ 0, com a margem
  const Q_perm_alvo = (tanAcos(a.fp_alvo) * (a.E_P_h + a.P_hat * h) - a.E_Q_h) / h - (a.E_P_h < 0.01 ? a.margem_q3 : 0);
  const dQ = a.Q_med - Q_perm_alvo;
  const fp_hora = a.E_P_h > 0 ? a.E_P_h / Math.sqrt(a.E_P_h ** 2 + a.E_Q_h ** 2) : null;
  const base = { janela: a.janela, Q_med: a.Q_med, Q_perm_alvo, Q_perm_lim, dQ, fp_hora, t_rest_hora: a.t_rest_hora };
  // Hora perdida: nem toda a compensação disponível fecha a hora dentro do limite.
  const qMaxPossivel = a.Q_disp_total;
  if (a.Q_med - qMaxPossivel + a.Q_ufv_atual > Q_perm_lim && dQ > 0 && a.t_rest_hora < 600) {
    return { acao: 'hora_perdida', ...base, motivo: `Hora perdida: falta ${fmt(dQ)} kvar e a compensação máxima não fecha o FP da hora` };
  }
  if (Math.abs(dQ) <= a.banda_kvar) return { acao: 'nada', ...base, motivo: `ΔQ ${fmt(dQ)} kvar dentro da banda` };
  if (a.desdeUltimoAjuste < a.t_min_ajuste) {
    return { acao: 'aguardar_ritmo', ...base, motivo: `Ajuste de FP há ${Math.round(a.desdeUltimoAjuste)} s (mínimo ${a.t_min_ajuste} s)` };
  }
  if (dQ > 0) {
    if (a.Q_disp_total - a.Q_ufv_atual <= 0) return { acao: 'sem_atuador', ...base, motivo: `Falta ${fmt(dQ)} kvar e não há Q disponível nas UFVs` };
    return { acao: 'compensar', ...base, motivo: `Janela ${a.janela === 'ind' ? 'indutiva' : 'capacitiva'}: compensar ${fmt(dQ)} kvar` };
  }
  return { acao: 'devolver', ...base, motivo: `Compensação além do necessário: devolver ${fmt(-dQ)} kvar` };
}

// --------------------------------------------------------- capacidade e divisão de Q

/** Q disponível no inversor (5.1): carta de capabilidade com o P atual. */
export function qDisponivel(inv: Inversor, P_kw: number, noite: boolean): number {
  if (noite && !inv.q_noturno) return 0;
  const S = Math.max(0, inv.smax_kva);
  const curva = Math.sqrt(Math.max(0, S * S - P_kw * P_kw));
  return Math.max(0, Math.min(S * inv.qmax_pct / 100, curva));
}

/** Divide Q total entre inversores pelo Q disponível (5.2). */
export function dividirQ(Q_total: number, disp: Array<{ id: string; q_disp: number }>): Record<string, number> {
  const soma = disp.reduce((a, d) => a + d.q_disp, 0);
  const out: Record<string, number> = {};
  for (const d of disp) out[d.id] = soma > 0 ? Math.sign(Q_total) * Math.min(d.q_disp, Math.abs(Q_total) * d.q_disp / soma) : 0;
  return out;
}

// ------------------------------------------------------------- R4: teto do p_lim

/**
 * Pior caso da perda de comunicação (R4): carga zero logo após cair, UFVs no último p_lim até a
 * validade vencer e depois no P_estatico até o estágio 2. Devolve o maior Σp_lim que ainda fecha
 * o intervalo ≤ contrato, e avisos do cadastro.
 */
export function validarCadastro(p: Params, ufvs: Ufv[]) {
  const avisos: string[] = [];
  const bloqueios: string[] = [];   // impedem o modo ativo
  const contrato = p.d_contr_g_kw;
  const somaEst = ufvs.reduce((a, u) => a + Math.max(0, u.p_estatico_kw), 0);
  const somaPn = ufvs.reduce((a, u) => a + u.inversores.reduce((b, i) => b + i.pn_kw, 0), 0);
  const tVal = Math.max(0, ...ufvs.map((u) => (u.rota === 'lora' ? p.t_validade_lora_s : p.t_validade_internet_s)));
  let tetoPlim: number | null = null;
  if (contrato && contrato > 0 && ufvs.length) {
    const alvo = contrato * p.alvo_g_pct / 100;
    const T = 900;
    if (somaEst > contrato) avisos.push(`Σ P estático (${fmt(somaEst)} kW) passa do contrato de geração (${fmt(contrato)} kW): o estágio 2 precisa ser curto o bastante.`);
    const folga = (contrato - alvo) * T - Math.max(0, somaEst - alvo) * p.t_estagio2_s;
    tetoPlim = tVal > 0 ? alvo + folga / tVal : null;
    if (tetoPlim != null && tetoPlim < alvo) {
      bloqueios.push(`Com validade de ${tVal} s e estágio 2 de ${p.t_estagio2_s} s, nem o alvo cabe no pior caso: reduza o P estático ou o estágio 2.`);
      tetoPlim = null;
    }
  }
  for (const u of ufvs) {
    if (!u.watchdog_nativo) avisos.push(`${u.nome}: sem watchdog nativo validado → limite dinâmico fica ≤ P estático (${fmt(u.p_estatico_kw)} kW).`);
    for (const i of u.inversores) {
      if (!(i.pn_kw > 0) || !(i.smax_kva > 0)) bloqueios.push(`${u.nome} · ${i.nome ?? i.id}: informe Pn e Smax.`);
    }
  }
  if (p.fp_alvo_ind < p.fp_lim_ind + 0.005 || p.fp_alvo_cap < p.fp_lim_cap + 0.005) {
    bloqueios.push('Alvo de FP precisa ser pelo menos 0,005 acima do limite.');
  }
  return { tetoPlim, somaEst, somaPn, tVal, avisos, bloqueios };
}

// ------------------------------------------------------------------ despachante

export interface SetpointInv { p_lim_kw: number; q_kvar: number }
export interface InvAoVivo { id: string; P_kw: number | null; disponivel: boolean; motivo?: string }
export interface ComandoInv {
  inversor_id: string; nome: string; ufv: string;
  p_lim_kw: number; p_pct: number; q_kvar: number; q_pct: number;
  muda_p: boolean; muda_q: boolean; motivo: string[];
}

/**
 * Um par P/Q por inversor a partir dos pedidos (4): demanda de carga > geração > FP.
 *  - reduzir geração: corta primeiro a UFV mais distante (maior `ordem`);
 *  - liberar: devolve primeiro a mais próxima;
 *  - R2: UFV sem watchdog nativo validado nunca passa do P estático; R4: Σp_lim ≤ teto;
 *  - Q pela divisão 5.2, dentro da carta (P atual);
 *  - só "muda" o que passou do degrau mínimo (EEPROM) — redução de P sempre muda.
 */
export function despachar(a: {
  ufvs: Ufv[]; vivo: Record<string, InvAoVivo>; atuais: Record<string, SetpointInv>;
  dP_g: number;        // >0 reduzir geração, <0 liberar
  dP_c: number;        // >0 liberar geração para a carga
  Q_alvo_total: number | null;   // null = FP não pede nada (mantém)
  noite: boolean; tetoPlim: number | null; degrau_min_pct: number;
  controlaP?: boolean;           // algum controle de demanda ligado (sem ele, P não é mexido)
}): { comandos: ComandoInv[]; Q_disp_total: number; Q_ufv_atual: number } {
  const invs: Array<{ u: Ufv; i: Inversor; P: number; disp: boolean }> = [];
  for (const u of a.ufvs) for (const i of u.inversores) {
    const v = a.vivo[i.id];
    invs.push({ u, i, P: Math.max(0, v?.P_kw ?? 0), disp: !!v?.disponivel });
  }
  const sp: Record<string, SetpointInv> = {};
  const motivos: Record<string, string[]> = {};
  for (const x of invs) {
    sp[x.i.id] = { ...(a.atuais[x.i.id] ?? { p_lim_kw: x.i.pn_kw, q_kvar: 0 }) };
    motivos[x.i.id] = [];
  }

  // P: corte/liberação por UFV, na ordem de distância
  const ordemDesc = [...a.ufvs].sort((x, y) => y.ordem - x.ordem);
  let corte = Math.max(0, a.dP_g);
  for (const u of ordemDesc) {
    if (corte <= 1e-6) break;
    const doU = invs.filter((x) => x.u.id === u.id && x.disp);
    const P_u = doU.reduce((s, x) => s + x.P, 0);
    if (P_u <= 0) continue;
    const c = Math.min(corte, P_u);
    for (const x of doU) {
      const parte = c * (x.P / P_u);
      sp[x.i.id].p_lim_kw = Math.max(0, x.P - parte);
      motivos[x.i.id].push(`demanda de geração: −${fmt(parte)} kW`);
    }
    corte -= c;
  }
  let libera = Math.max(0, -a.dP_g) + Math.max(0, a.dP_c);
  for (const u of [...ordemDesc].reverse()) {
    if (libera <= 1e-6) break;
    for (const x of invs.filter((y) => y.u.id === u.id && y.disp)) {
      const folga = x.i.pn_kw - sp[x.i.id].p_lim_kw;
      if (folga <= 0 || libera <= 0) continue;
      const l = Math.min(folga, libera);
      sp[x.i.id].p_lim_kw += l;
      libera -= l;
      motivos[x.i.id].push(`${a.dP_c > 0 ? 'demanda de carga' : 'folga'}: +${fmt(l)} kW`);
    }
  }
  // R2 (P estático por UFV sem watchdog nativo) e R4 (teto do Σp_lim) — só com limite dinâmico em uso
  const controlaP = a.controlaP !== false;
  for (const u of controlaP ? a.ufvs : []) {
    if (u.watchdog_nativo) continue;
    const doU = invs.filter((x) => x.u.id === u.id);
    const soma = doU.reduce((s, x) => s + sp[x.i.id].p_lim_kw, 0);
    if (soma > u.p_estatico_kw + 1e-6) {
      const f = soma > 0 ? u.p_estatico_kw / soma : 0;
      for (const x of doU) { sp[x.i.id].p_lim_kw *= f; motivos[x.i.id].push('R2: ≤ P estático (sem watchdog nativo)'); }
    }
  }
  if (controlaP && a.tetoPlim != null && a.tetoPlim >= 0) {
    const soma = invs.reduce((s, x) => s + sp[x.i.id].p_lim_kw, 0);
    if (soma > a.tetoPlim + 1e-6) {
      const f = a.tetoPlim > 0 ? a.tetoPlim / soma : 0;
      for (const x of invs) { sp[x.i.id].p_lim_kw *= f; motivos[x.i.id].push('R4: teto do limite pelo pior caso'); }
    }
  }

  // Q: divisão pelo disponível na carta
  const disp = invs.filter((x) => x.disp).map((x) => ({ id: x.i.id, q_disp: qDisponivel(x.i, Math.min(x.P, sp[x.i.id].p_lim_kw), a.noite) }));
  const Q_disp_total = disp.reduce((s, d) => s + d.q_disp, 0);
  const Q_ufv_atual = invs.reduce((s, x) => s + (a.atuais[x.i.id]?.q_kvar ?? 0), 0);
  if (a.Q_alvo_total != null) {
    const div = dividirQ(a.Q_alvo_total, disp);
    for (const x of invs) {
      const q = div[x.i.id] ?? 0;
      if (Math.abs(q - sp[x.i.id].q_kvar) > 1e-6) motivos[x.i.id].push(`FP: ${fmt(q)} kvar`);
      sp[x.i.id].q_kvar = q;
    }
  }
  for (const x of invs) {   // carta com o P limitado
    const qmax = qDisponivel(x.i, Math.min(x.P, sp[x.i.id].p_lim_kw), a.noite);
    if (Math.abs(sp[x.i.id].q_kvar) > qmax) sp[x.i.id].q_kvar = Math.sign(sp[x.i.id].q_kvar) * qmax;
  }

  const comandos: ComandoInv[] = invs.map((x) => {
    const at = a.atuais[x.i.id] ?? { p_lim_kw: x.i.pn_kw, q_kvar: 0 };
    const novo = sp[x.i.id];
    const degrau = x.i.smax_kva * a.degrau_min_pct / 100;
    const muda_p = controlaP && x.disp && (novo.p_lim_kw < at.p_lim_kw - 0.05 || novo.p_lim_kw - at.p_lim_kw >= degrau);
    const muda_q = x.disp && Math.abs(novo.q_kvar - at.q_kvar) >= degrau;
    return {
      inversor_id: x.i.id, nome: x.i.nome ?? x.i.id, ufv: x.u.nome,
      p_lim_kw: arred(novo.p_lim_kw), p_pct: arred(x.i.pn_kw > 0 ? (novo.p_lim_kw / x.i.pn_kw) * 100 : 100, 1),
      q_kvar: arred(novo.q_kvar), q_pct: arred(x.i.pn_kw > 0 ? (novo.q_kvar / x.i.pn_kw) * 100 * x.i.sinal_q : 0, 1),
      muda_p, muda_q,
      motivo: x.disp ? motivos[x.i.id] : [a.vivo[x.i.id]?.motivo ?? 'indisponível'],
    };
  });
  return { comandos, Q_disp_total, Q_ufv_atual };
}

export function fmt(v: number | null | undefined, d = 1): string {
  return v == null || !Number.isFinite(v) ? '—' : v.toFixed(d).replace('.', ',');
}
function arred(v: number, d = 2) { const k = 10 ** d; return Math.round(v * k) / k; }
