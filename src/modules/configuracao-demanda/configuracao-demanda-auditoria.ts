/**
 * Trilha da Configuração da Demanda (NEXON-19): quem mudou equipamentos do
 * agregado, perdas, demanda contratada de geração/carga, quando e de onde.
 * Grava em auditoria_acessos (acao 'configuracao_demanda'), que aparece em
 * GET /logs-mqtt?tipo=acesso já filtrado pelo escopo de planta.
 */

/** Campos comparados, com o rótulo que vai para a mensagem e para a busca. */
export const CAMPOS_AUDITADOS: Record<string, string> = {
  fonte: 'Fonte',
  mostrar_detalhes: 'Mostrar detalhes',
  intervalo_atualizacao: 'Intervalo de atualização (s)',
  aplicar_perdas: 'Aplicar perdas',
  fator_perdas: 'Fator de perdas (%)',
  valor_contratado: 'Valor contratado (kW)',
  percentual_adicional: 'Percentual adicional (%)',
  demanda_geracao: 'Demanda de geração (kW)',
  demanda_carga: 'Demanda de carga (kW)',
};

export interface AlteracaoCampo {
  campo: string;
  rotulo: string;
  antes: unknown;
  depois: unknown;
}

export interface DiffConfiguracaoDemanda {
  campos: AlteracaoCampo[];
  adicionados: string[];
  removidos: string[];
}

const normalizar = (v: unknown): unknown => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'object' && v !== null && 'toNumber' in (v as any)) return (v as any).toNumber();
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return v;
};

const ids = (lista: unknown): string[] => {
  const arr = typeof lista === 'string' ? (JSON.parse(lista) as unknown[]) : Array.isArray(lista) ? lista : [];
  return Array.from(new Set(arr.map((x) => String(x ?? '').trim()).filter(Boolean)));
};

/**
 * Compara o antes (config + demandas da unidade) com o que veio no PUT. Campo
 * ausente no PUT não mudou; lista de equipamentos vira adicionados/removidos.
 */
export function diffConfiguracaoDemanda(
  antes: Record<string, unknown>,
  depois: Record<string, unknown>,
): DiffConfiguracaoDemanda {
  const campos: AlteracaoCampo[] = [];
  for (const [campo, rotulo] of Object.entries(CAMPOS_AUDITADOS)) {
    if (depois[campo] === undefined) continue;
    const a = normalizar(antes[campo]);
    const d = normalizar(depois[campo]);
    if (a !== d) campos.push({ campo, rotulo, antes: a, depois: d });
  }

  let adicionados: string[] = [];
  let removidos: string[] = [];
  if (depois.equipamentos_ids !== undefined) {
    const idsAntes = ids(antes.equipamentos_ids);
    const idsDepois = ids(depois.equipamentos_ids);
    adicionados = idsDepois.filter((id) => !idsAntes.includes(id));
    removidos = idsAntes.filter((id) => !idsDepois.includes(id));
  }
  return { campos, adicionados, removidos };
}

export const diffVazio = (d: DiffConfiguracaoDemanda) =>
  d.campos.length === 0 && d.adicionados.length === 0 && d.removidos.length === 0;

/** "Demanda de geração (kW): 295 → 300; +2 equipamentos (IV1, IV2)". */
export function resumirDiff(d: DiffConfiguracaoDemanda, nomes: Record<string, string>): string {
  const fmt = (v: unknown) => (v === null ? 'vazio' : typeof v === 'boolean' ? (v ? 'sim' : 'não') : String(v));
  const partes = d.campos.map((c) => `${c.rotulo}: ${fmt(c.antes)} → ${fmt(c.depois)}`);
  const lista = (xs: string[]) => xs.map((id) => nomes[id] ?? id).join(', ');
  if (d.adicionados.length) partes.push(`+${d.adicionados.length} equipamento(s) (${lista(d.adicionados)})`);
  if (d.removidos.length) partes.push(`-${d.removidos.length} equipamento(s) (${lista(d.removidos)})`);
  return partes.join('; ');
}
