import { janelaValida, JanelaComAtivo } from '../../shared/util/janela-horario';

/**
 * Configuração de pivô — lógica PURA, testada em pivo-config.util.spec.ts.
 */

/** Ponta padrão (a maioria das distribuidoras): 18:00–21:00, segunda a sexta. */
export const PONTA_PADRAO: JanelaComAtivo = { ativo: false, inicio: '18:00', fim: '21:00', dias: [1, 2, 3, 4, 5] };
/** Horário reservado (irrigante, REN ANEEL 1000): 21:30–06:00, todos os dias. */
export const RESERVADO_PADRAO: JanelaComAtivo = { ativo: false, inicio: '21:30', fim: '06:00', dias: [1, 2, 3, 4, 5, 6, 7] };

/**
 * JSON gravado → janela completa. Ausente/malformado → padrão (desligado).
 * O bloqueio só vale depois que alguém LIGA e salva: pivô sem config nunca é
 * barrado (comportamento de antes do deploy).
 */
export function janelaOuPadrao(gravado: unknown, padrao: JanelaComAtivo): JanelaComAtivo {
  if (!janelaValida(gravado)) return { ...padrao, dias: [...padrao.dias] };
  const g = gravado as JanelaComAtivo;
  return {
    ativo: g.ativo === true,
    inicio: g.inicio,
    fim: g.fim,
    dias: [...new Set(g.dias.map(Number))].sort((a, b) => a - b),
  };
}

export interface LinhaConjugado {
  pivo_id: string;
  pivo_nome: string;
  motobomba_id: string;
  motobomba_nome: string;
}

export interface GrupoConjugado {
  motobomba: { equipamento_id: string; nome: string };
  pivos: Array<{ equipamento_id: string; nome: string }>;
}

/**
 * Agrupa pivôs pela motobomba. Só vira "sistema conjugado" a motobomba com 2+
 * pivôs (motobomba de um pivô só não é compartilhada). Ordem: nome natural.
 */
export function agruparConjugados(linhas: LinhaConjugado[]): GrupoConjugado[] {
  const grupos = new Map<string, GrupoConjugado>();
  for (const l of linhas) {
    const mid = l.motobomba_id.trim();
    if (!grupos.has(mid)) grupos.set(mid, { motobomba: { equipamento_id: mid, nome: l.motobomba_nome }, pivos: [] });
    const g = grupos.get(mid)!;
    const pid = l.pivo_id.trim();
    if (!g.pivos.some((p) => p.equipamento_id === pid)) g.pivos.push({ equipamento_id: pid, nome: l.pivo_nome });
  }
  const cmp = (a: string, b: string) => a.localeCompare(b, 'pt-BR', { numeric: true, sensitivity: 'base' });
  return [...grupos.values()]
    .filter((g) => g.pivos.length >= 2)
    .map((g) => ({ ...g, pivos: g.pivos.sort((a, b) => cmp(a.nome, b.nome)) }))
    .sort((a, b) => cmp(a.motobomba.nome, b.motobomba.nome));
}
