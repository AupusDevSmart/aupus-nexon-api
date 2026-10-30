export type StatusPivo = Partial<Record<'direita' | 'esquerda' | 'desligado' | 'erro', 0 | 1 | null>>;

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Mesmos nomes de ponto que /pivos/:id/estado usa para achar o papel de cada entrada da TON. */
export function papelStatusPivo(nome: string): keyof StatusPivo | null {
  const n = norm(nome);
  if (/erro|falha/.test(n)) return 'erro';
  if (/deslig|parad/.test(n)) return 'desligado';
  if (/esquerd/.test(n)) return 'esquerda';
  if (/direit/.test(n)) return 'direita';
  return null;
}

export const ehPivo = (tipo?: string | null): boolean => /piv[oô]/i.test(tipo ?? '');

/**
 * Status das entradas da TON nos nomes que os apps já leem em `dados` (LeituraPivo). Direita é
 * Avanço e esquerda é Reverso, como no web. Entrada sem leitura não vira campo.
 */
export function camposDoStatusPivo(st: StatusPivo): Record<string, unknown> {
  const lidos = [st.direita, st.esquerda, st.desligado, st.erro].some((v) => v === 0 || v === 1);
  if (!lidos) return {};
  const girando = st.direita === 1 || st.esquerda === 1;
  return {
    irrigando: girando,
    ...(st.direita === 1 ? { sentido: 'Avanço' } : st.esquerda === 1 ? { sentido: 'Reverso' } : {}),
    falha: st.erro === 1,
    painel_energizado: true,
  };
}
