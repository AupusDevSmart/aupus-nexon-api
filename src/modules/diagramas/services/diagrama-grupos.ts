/**
 * Agrupamentos do unifilar (NEXON-31): normalização antes de gravar em
 * `configuracoes.grupos` e o diff que vai para a trilha de auditoria.
 */

export interface GrupoDiagrama {
  id: string;
  nome: string;
  equipamentoIds: string[];
  cor?: string | null;
  recolhido?: boolean;
  posicaoX?: number | null;
  posicaoY?: number | null;
}

export interface DiffGrupos {
  criados: GrupoDiagrama[];
  removidos: GrupoDiagrama[];
  renomeados: { id: string; de: string; para: string }[];
  recoloridos: { id: string; nome: string; de: string | null; para: string | null }[];
  membrosAlterados: { id: string; nome: string; entraram: string[]; sairam: string[] }[];
}

/**
 * Deixa a lista de grupos consistente com o layout salvo:
 * - membro que não está no diagrama sai do grupo;
 * - um equipamento fica em um grupo só (vale o primeiro);
 * - grupo sem membro some; nome vazio vira "Grupo N"; id repetido é descartado.
 */
export function normalizarGrupos(grupos: GrupoDiagrama[], equipamentosNoDiagrama: Iterable<string>): GrupoDiagrama[] {
  const noDiagrama = new Set(Array.from(equipamentosNoDiagrama, (id) => id.trim()));
  const usados = new Set<string>();
  const ids = new Set<string>();
  const saida: GrupoDiagrama[] = [];

  for (const g of grupos) {
    const id = g.id?.trim();
    if (!id || ids.has(id)) continue;
    const membros: string[] = [];
    for (const raw of g.equipamentoIds ?? []) {
      const eq = raw?.trim();
      if (!eq || !noDiagrama.has(eq) || usados.has(eq)) continue;
      usados.add(eq);
      membros.push(eq);
    }
    if (membros.length === 0) continue;
    ids.add(id);
    saida.push({
      id,
      nome: g.nome?.trim() || `Grupo ${saida.length + 1}`,
      equipamentoIds: membros,
      cor: g.cor ?? null,
      recolhido: g.recolhido ?? true,
      posicaoX: Number.isFinite(g.posicaoX) ? g.posicaoX : null,
      posicaoY: Number.isFinite(g.posicaoY) ? g.posicaoY : null,
    });
  }
  return saida;
}

/** Lê `configuracoes.grupos` tolerando lixo (config antiga, campo ausente). */
export function gruposDaConfiguracao(configuracoes: unknown): GrupoDiagrama[] {
  const grupos = (configuracoes as { grupos?: unknown } | null)?.grupos;
  if (!Array.isArray(grupos)) return [];
  return grupos.filter(
    (g): g is GrupoDiagrama => !!g && typeof g.id === 'string' && Array.isArray(g.equipamentoIds),
  );
}

export function diffGrupos(antes: GrupoDiagrama[], depois: GrupoDiagrama[]): DiffGrupos {
  const porIdAntes = new Map(antes.map((g) => [g.id, g]));
  const porIdDepois = new Map(depois.map((g) => [g.id, g]));
  const diff: DiffGrupos = { criados: [], removidos: [], renomeados: [], recoloridos: [], membrosAlterados: [] };

  for (const g of depois) {
    const velho = porIdAntes.get(g.id);
    if (!velho) {
      diff.criados.push(g);
      continue;
    }
    if (velho.nome !== g.nome) diff.renomeados.push({ id: g.id, de: velho.nome, para: g.nome });
    if ((velho.cor ?? null) !== (g.cor ?? null)) {
      diff.recoloridos.push({ id: g.id, nome: g.nome, de: velho.cor ?? null, para: g.cor ?? null });
    }
    const a = new Set(velho.equipamentoIds);
    const d = new Set(g.equipamentoIds);
    const entraram = g.equipamentoIds.filter((e) => !a.has(e));
    const sairam = velho.equipamentoIds.filter((e) => !d.has(e));
    if (entraram.length || sairam.length) {
      diff.membrosAlterados.push({ id: g.id, nome: g.nome, entraram, sairam });
    }
  }
  for (const g of antes) if (!porIdDepois.has(g.id)) diff.removidos.push(g);
  return diff;
}

export function gruposMudaram(diff: DiffGrupos): boolean {
  return !!(
    diff.criados.length ||
    diff.removidos.length ||
    diff.renomeados.length ||
    diff.recoloridos.length ||
    diff.membrosAlterados.length
  );
}

/** Uma linha legível para a mensagem do log ("criado X (5); renomeado Y → Z"). */
export function resumirGrupos(diff: DiffGrupos): string {
  const partes: string[] = [];
  for (const g of diff.criados) partes.push(`grupo criado "${g.nome}" (${g.equipamentoIds.length} equip.)`);
  for (const r of diff.renomeados) partes.push(`grupo renomeado "${r.de}" → "${r.para}"`);
  for (const c of diff.recoloridos) partes.push(`cor do grupo "${c.nome}" ${c.de ?? 'padrão'} → ${c.para ?? 'padrão'}`);
  for (const m of diff.membrosAlterados) {
    const mud = [m.entraram.length ? `+${m.entraram.length}` : '', m.sairam.length ? `-${m.sairam.length}` : '']
      .filter(Boolean)
      .join(' ');
    partes.push(`grupo "${m.nome}" ${mud} equip.`);
  }
  for (const g of diff.removidos) partes.push(`grupo desfeito "${g.nome}"`);
  return partes.join('; ');
}
