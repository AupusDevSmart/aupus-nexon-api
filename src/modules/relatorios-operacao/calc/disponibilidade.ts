/**
 * Disponibilidade e dias parados (NEXON-33) — lógica PURA, testada em disponibilidade.spec.ts.
 */

export interface Intervalo {
  ini: number; // ms
  fim: number; // ms
}

/** Une intervalos sobrepostos (ordena; descarta vazios). */
export function unirIntervalos(ints: Intervalo[]): Intervalo[] {
  const ord = ints.filter((i) => Number.isFinite(i.ini) && Number.isFinite(i.fim) && i.fim > i.ini).sort((a, b) => a.ini - b.ini);
  const out: Intervalo[] = [];
  for (const i of ord) {
    const u = out[out.length - 1];
    if (u && i.ini <= u.fim) u.fim = Math.max(u.fim, i.fim);
    else out.push({ ...i });
  }
  return out;
}

/** Soma (ms) dos intervalos dentro de [ini, fim), sem contar sobreposição duas vezes. */
export function duracaoDentro(ints: Intervalo[], ini: number, fim: number): number {
  let s = 0;
  for (const i of unirIntervalos(ints)) {
    const a = Math.max(i.ini, ini);
    const b = Math.min(i.fim, fim);
    if (b > a) s += b - a;
  }
  return s;
}

/**
 * Início do monitoramento de comunicação (alarmes de comunicação em logs_mqtt, SQL
 * 2026-10-13_alarmes_comunicacao): antes disso não há como provar indisponibilidade.
 */
export const MONITOR_COMUNICACAO_DESDE = Date.UTC(2026, 9, 13, 3, 0, 0); // 13/10/2026 00:00 BRT

/**
 * Disponibilidade (%) no período = tempo sem alarme de comunicação aberto ÷ tempo monitorado.
 * O período é cortado no início do monitoramento; nada monitorado → null.
 */
export function disponibilidadePct(indisponivel: Intervalo[], ini: number, fim: number, desde = MONITOR_COMUNICACAO_DESDE): number | null {
  const a = Math.max(ini, desde);
  if (fim <= a) return null;
  const fora = duracaoDentro(indisponivel, a, fim);
  return arred(Math.max(0, Math.min(100, ((fim - a - fora) / (fim - a)) * 100)), 1);
}

/** Média simples das disponibilidades conhecidas (null se nenhuma). */
export function mediaDisponibilidade(valores: Array<number | null>): number | null {
  const v = valores.filter((x): x is number => x !== null && Number.isFinite(x));
  return v.length ? arred(v.reduce((s, x) => s + x, 0) / v.length, 1) : null;
}

export function mediana(v: number[]): number | null {
  const s = v.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Dias em que cada inversor ficou parado. `energia[inv][dia]` = kWh do dia (ausente = sem
 * leitura). Só entram os `dias` pedidos (dias já fechados, a partir do primeiro com leitura).
 *
 * Regra (por inversor, energia normalizada pela própria mediana dos dias com geração):
 *  - sem leitura ou ≤ 0 → parado;
 *  - com outros inversores: abaixo de 10% da própria mediana enquanto algum outro passou de
 *    30% da dele (dia nublado derruba todos juntos e não conta);
 *  - inversor único: abaixo de 5% da própria mediana.
 */
export function diasParados(
  energia: Map<string, Map<string, number>>,
  inversores: string[],
  dias: string[],
): { porInversor: Map<string, string[]>; semLeitura: Map<string, number>; diasComParado: number } {
  const med = new Map<string, number | null>();
  for (const inv of inversores) {
    med.set(inv, mediana([...(energia.get(inv)?.values() ?? [])].filter((x) => x > 0)));
  }
  const porInversor = new Map<string, string[]>(inversores.map((i) => [i, []]));
  const semLeitura = new Map<string, number>(inversores.map((i) => [i, 0]));
  const diasCom = new Set<string>();
  for (const dia of dias) {
    const norm = new Map<string, number | null>();
    for (const inv of inversores) {
      const e = energia.get(inv)?.get(dia);
      const m = med.get(inv);
      norm.set(inv, e === undefined || !m ? null : e / m);
    }
    for (const inv of inversores) {
      const e = energia.get(inv)?.get(dia);
      let parado = false;
      if (e === undefined || e <= 0) {
        parado = true;
        if (e === undefined) semLeitura.set(inv, (semLeitura.get(inv) ?? 0) + 1);
      } else {
        const n = norm.get(inv);
        if (n !== null && n !== undefined) {
          if (inversores.length > 1) {
            const outrosOk = inversores.some((o) => o !== inv && (norm.get(o) ?? 0) >= 0.3);
            parado = n < 0.1 && outrosOk;
          } else {
            parado = n < 0.05;
          }
        }
      }
      if (parado) {
        porInversor.get(inv)!.push(dia);
        diasCom.add(dia);
      }
    }
  }
  return { porInversor, semLeitura, diasComParado: diasCom.size };
}

export function arred(v: number, casas = 1): number {
  const f = 10 ** casas;
  return Math.round(v * f) / f;
}
