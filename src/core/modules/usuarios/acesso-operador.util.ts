/**
 * Permissão por instalação do operador (usuario_unidade_permissoes) — lógica
 * PURA, testada em acesso-operador.util.spec.ts.
 */

export interface LinhaPermissaoUnidade {
  unidade_id: string;
  comandar: boolean;
  relatorios: boolean;
}

export interface ResumoAcesso {
  unidade_ids: string[];
  permissoes: { visualizar: true; comandar: boolean; relatorios: boolean };
  excecoes: Array<{ unidade_id: string; comandar: boolean; relatorios: boolean }>;
}

/**
 * Expande o formulário do app (permissão geral + exceções por instalação) em
 * uma linha por unidade. Exceção de unidade fora da seleção é ignorada.
 */
export function expandirPermissoes(
  unidadeIds: string[],
  geral: { comandar: boolean; relatorios: boolean },
  excecoes: Array<{ unidade_id: string; comandar: boolean; relatorios: boolean }> = [],
): LinhaPermissaoUnidade[] {
  const porUnidade = new Map(excecoes.map((e) => [e.unidade_id.trim(), e]));
  const vistos = new Set<string>();
  const linhas: LinhaPermissaoUnidade[] = [];
  for (const bruto of unidadeIds) {
    const id = bruto.trim();
    if (!id || vistos.has(id)) continue;
    vistos.add(id);
    const ex = porUnidade.get(id);
    linhas.push({
      unidade_id: id,
      comandar: ex ? !!ex.comandar : !!geral.comandar,
      relatorios: ex ? !!ex.relatorios : !!geral.relatorios,
    });
  }
  return linhas;
}

/**
 * Caminho inverso (GET /usuarios/:id/acesso): a permissão "geral" é a
 * combinação mais comum; as linhas que diferem dela viram exceções. Empate →
 * a combinação mais permissiva (comandar antes de relatórios).
 */
export function resumirPermissoes(linhas: LinhaPermissaoUnidade[]): ResumoAcesso {
  if (linhas.length === 0) {
    return { unidade_ids: [], permissoes: { visualizar: true, comandar: false, relatorios: false }, excecoes: [] };
  }
  const chave = (l: { comandar: boolean; relatorios: boolean }) => `${l.comandar ? 1 : 0}${l.relatorios ? 1 : 0}`;
  const contagem = new Map<string, number>();
  for (const l of linhas) contagem.set(chave(l), (contagem.get(chave(l)) ?? 0) + 1);
  const [base] = [...contagem.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0];
  const geral = { comandar: base[0] === '1', relatorios: base[1] === '1' };
  return {
    unidade_ids: linhas.map((l) => l.unidade_id),
    permissoes: { visualizar: true, ...geral },
    excecoes: linhas
      .filter((l) => chave(l) !== base)
      .map((l) => ({ unidade_id: l.unidade_id, comandar: l.comandar, relatorios: l.relatorios })),
  };
}
