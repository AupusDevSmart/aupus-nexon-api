/**
 * Extrai os PRINCIPAIS dados do JSON de cada dispositivo — as grandezas que o instalador
 * confere contra o que o equipamento mostra de verdade, no comissionamento. É o CORE do
 * comissionamento (conferência humana NexON × real), não a validação automática.
 *
 * Só os essenciais por tipo. Valores como o NexON recebeu (com conversão de unidade óbvia,
 * ex.: W→kW), pra bater com o display do medidor/inversor. Ver docs/IOT-NEXON-CONFIABILIDADE.md §3.2.
 */

export interface Grandeza {
  campo: string;    // chave estável (p/ casar a confirmação)
  label: string;    // rótulo humano
  valor: number | string | null; // valor que o NexON recebeu
  unidade: string;  // 'V' | 'A' | 'kW' | 'kWh' | 'Hz' | ''
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Medidor flat (M160/Power Meter): Va/Vb/Vc, Ia/Ib/Ic, Pt/Qt/St, FPa/FPb/FPc. */
function grandezasMedidor(d: any): Grandeza[] {
  const g: Grandeza[] = [];
  const push = (campo: string, label: string, v: number | null, unidade: string, conv?: (x: number) => number) => {
    if (v === null) return;
    g.push({ campo, label, valor: conv ? conv(v) : v, unidade });
  };
  push('Va', 'Tensão A', num(d.Va), 'V', r2);
  push('Vb', 'Tensão B', num(d.Vb), 'V', r2);
  push('Vc', 'Tensão C', num(d.Vc), 'V', r2);
  push('Ia', 'Corrente A', num(d.Ia), 'A', r3);
  push('Ib', 'Corrente B', num(d.Ib), 'A', r3);
  push('Ic', 'Corrente C', num(d.Ic), 'A', r3);
  const pt = num(d.Pt); if (pt !== null) push('Pt', 'Potência ativa', pt, 'kW', (x) => r3(x / 1000));
  const qt = num(d.Qt); if (qt !== null) push('Qt', 'Potência reativa', qt, 'kVAr', (x) => r3(x / 1000));
  // Fator de potência: prefere o FP TOTAL do medidor (FPt) se vier; senão a média das fases.
  const fpt = num(d.FPt);
  if (fpt !== null) {
    g.push({ campo: 'FPt', label: 'Fator de potência (total)', valor: r3(fpt), unidade: '' });
  } else {
    const fps = ['FPa', 'FPb', 'FPc'].map((k) => num(d[k])).filter((x): x is number => x !== null);
    if (fps.length) g.push({ campo: 'FP', label: 'Fator de potência (médio)', valor: r3(fps.reduce((a, b) => a + b, 0) / fps.length), unidade: '' });
  }
  // Frequência (só aparece quando o firmware publicar o campo Freq — M160/PD666).
  const freq = num(d.Freq ?? d.freq);
  if (freq !== null) g.push({ campo: 'Freq', label: 'Frequência', valor: r2(freq), unidade: 'Hz' });
  return g;
}

/** Inversor (aninhado): power.active_total/power_factor/frequency, energy.daily_yield/total_yield. */
function grandezasInversor(d: any): Grandeza[] {
  const g: Grandeza[] = [];
  const p = d.power || {};
  const e = d.energy || {};
  const pa = num(p.active_total); if (pa !== null) g.push({ campo: 'power.active_total', label: 'Potência ativa', valor: r3(pa / 1000), unidade: 'kW' });
  const fp = num(p.power_factor); if (fp !== null) g.push({ campo: 'power.power_factor', label: 'Fator de potência', valor: r3(fp), unidade: '' });
  const fr = num(p.frequency); if (fr !== null) g.push({ campo: 'power.frequency', label: 'Frequência', valor: r2(fr), unidade: 'Hz' });
  const dy = num(e.daily_yield); if (dy !== null) g.push({ campo: 'energy.daily_yield', label: 'Energia hoje', valor: r2(dy), unidade: 'kWh' });
  const ty = num(e.total_yield); if (ty !== null) g.push({ campo: 'energy.total_yield', label: 'Energia total', valor: r2(ty), unidade: 'kWh' });
  return g;
}

/** Gateway A966 (SSU): P_direto/P_rev/Q_liquido/FP_calc (já derivados na ingestão). */
function grandezasA966(d: any): Grandeza[] {
  const g: Grandeza[] = [];
  const map: Array<[string, string, string]> = [
    ['P_direto', 'Potência importada', 'kW'],
    ['P_rev', 'Potência exportada', 'kW'],
    ['Q_liquido', 'Reativo líquido', 'kVAr'],
    ['FP_calc', 'Fator de potência', ''],
  ];
  for (const [campo, label, unidade] of map) {
    const v = num(d[campo]);
    if (v !== null) g.push({ campo, label, valor: r3(v), unidade });
  }
  return g;
}

/** Fallback: primeiros campos numéricos da raiz (até 8). */
function grandezasGenerico(d: any): Grandeza[] {
  const g: Grandeza[] = [];
  for (const [k, v] of Object.entries(d || {})) {
    if (g.length >= 8) break;
    const n = num(v);
    if (n !== null && k !== 'timestamp') g.push({ campo: k, label: k, valor: r3(n), unidade: '' });
  }
  return g;
}

/** Decide a família pelo shape do JSON (mais confiável que o tipo cadastrado). */
export function extrairGrandezas(dados: any, _tipo?: string | null): Grandeza[] {
  if (!dados || typeof dados !== 'object') return [];
  // A966: campos derivados exclusivos (P_direto/P_rev). Vem antes do medidor flat.
  if (dados.P_direto !== undefined || dados.P_rev !== undefined) return grandezasA966(dados);
  if (dados.Va !== undefined || dados.Vb !== undefined || dados.Vc !== undefined || dados.Pt !== undefined) return grandezasMedidor(dados);
  if (dados.power !== undefined || dados.energy !== undefined || dados.dc !== undefined) return grandezasInversor(dados);
  return grandezasGenerico(dados);
}
