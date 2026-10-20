/**
 * Funções puras do resumo diário de `equipamentos_dados` (testadas em agregado-diario.spec.ts).
 * Dia local = 'YYYY-MM-DD' em America/Sao_Paulo (UTC−3, sem horário de verão desde 2019).
 * `timestamp_dados` no banco é UTC sem fuso.
 */

// Frame com potencia >= 1 GW e overflow UINT do Modbus (ex: total_yield=2^32,
// potencia=isso/1000=4.29 GW, daily_yield=2^16/10=6553.5). Nenhum device real
// chega perto de 1 GW, entao descartar a leitura inteira por esse sinal limpa
// os 3 campos de uma vez — sem teto em daily_yield (que teria falso-positivo).
export const CAP_POTENCIA_GLITCH_KW = 1_000_000;

const OFFSET_MS = -3 * 3_600_000;
const pad = (n: number) => String(n).padStart(2, '0');

/** Dia local de um instante. */
export function diaLocal(instante: Date): string {
  const d = new Date(instante.getTime() + OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function somarDias(dia: string, n: number): string {
  const [a, m, d] = dia.split('-').map(Number);
  const x = new Date(Date.UTC(a, m - 1, d + n));
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
}

/** Meia-noite local do dia como timestamp UTC sem fuso ('YYYY-MM-DD HH:MM:SS'), o formato da coluna. */
export function inicioDoDiaUtcSql(dia: string): string {
  const [a, m, d] = dia.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d) - OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}

/** Dias do intervalo [inicio, fim). */
export function diasEntre(inicio: string, fim: string): string[] {
  const dias: string[] = [];
  for (let d = inicio; d < fim; d = somarDias(d, 1)) dias.push(d);
  return dias;
}

/**
 * Divide o intervalo pedido em dias fechados (vêm do resumo guardado) e dias ao vivo
 * (calculados na hora, nunca guardados). Ao vivo = de ontem em diante: o gateway ainda
 * manda leitura de ontem e o dia de hoje está aberto.
 */
export function dividirIntervalo(inicio: string, fim: string, hoje: string) {
  const corte = somarDias(hoje, -1);
  const fechadoFim = fim < corte ? fim : corte;
  const vivoInicio = inicio > corte ? inicio : corte;
  return {
    fechado: inicio < fechadoFim ? { inicio, fim: fechadoFim } : null,
    vivo: vivoInicio < fim ? { inicio: vivoInicio, fim } : null,
  };
}

export interface LinhaDia {
  dia: string;
  equipamento_id: string;
  energia_total: number | null;
  potencia_media: number | null;
  num_leituras: number;
}

/**
 * Dias fechados que faltam no resumo, por equipamento, e o menor intervalo que os cobre
 * (uma consulta só para preencher todos).
 */
export function faltantes(ids: string[], dias: string[], guardadas: Pick<LinhaDia, 'dia' | 'equipamento_id'>[]) {
  const tem = new Set(guardadas.map((g) => `${g.equipamento_id.trim()}|${g.dia}`));
  const porEquipamento = new Map<string, string[]>();
  for (const id of ids) {
    const f = dias.filter((d) => !tem.has(`${id}|${d}`));
    if (f.length) porEquipamento.set(id, f);
  }
  const todos = [...porEquipamento.values()].flat().sort();
  return {
    porEquipamento,
    intervalo: todos.length ? { inicio: todos[0], fim: somarDias(todos[todos.length - 1], 1) } : null,
  };
}

/** Soma os dias por mês (gráfico do ano): energia somada, potência média dos dias com leitura. */
export function agruparPorMes(linhas: LinhaDia[]) {
  const porChave = new Map<string, { mes: string; equipamento_id: string; energia: number; pots: number[]; n: number }>();
  for (const l of linhas) {
    const mes = l.dia.slice(0, 7);
    const chave = `${mes}|${l.equipamento_id}`;
    const g = porChave.get(chave) ?? { mes, equipamento_id: l.equipamento_id, energia: 0, pots: [], n: 0 };
    g.energia += Number(l.energia_total ?? 0);
    if (l.potencia_media != null) g.pots.push(Number(l.potencia_media));
    g.n += l.num_leituras;
    porChave.set(chave, g);
  }
  return [...porChave.values()]
    .sort((a, b) => a.mes.localeCompare(b.mes))
    .map((g) => ({
      mes: g.mes,
      equipamento_id: g.equipamento_id,
      energia_total: g.energia,
      potencia_media: g.pots.length ? g.pots.reduce((a, b) => a + b, 0) / g.pots.length : null,
      num_leituras: g.n,
    }));
}
