/**
 * Lista de equipamentos do gráfico de demanda recortada ao que o operador vê
 * (PER-24): o gráfico soma só os liberados, sem aviso do corte. Aceita os dois
 * formatos gravados em `equipamentos_ids` (id solto ou `{ id, ... }`).
 * `eqScope` null = sem recorte (devolve a lista como veio).
 */
export function recortarEquipamentosIds<T>(lista: T[] | null | undefined, eqScope: string[] | null): T[] {
  if (!Array.isArray(lista)) return [];
  if (!eqScope) return lista;
  const lib = new Set(eqScope.map((x) => x.trim()));
  return lista.filter((item: any) => {
    const id = typeof item === 'string' ? item : item?.id ?? item?.equipamento_id;
    return typeof id === 'string' && lib.has(id.trim());
  });
}
