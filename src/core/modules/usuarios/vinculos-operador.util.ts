/**
 * Vínculo do operador (spec NEXON-20, seção 4) — lógica PURA, testada em
 * vinculos-operador.util.spec.ts.
 *
 * O vínculo guarda só a LISTA EXPLÍCITA de equipamentos (PER-21d): chips por
 * tipo e checkbox de instalação são atalhos da tela, não regra salva.
 */

export interface ItemVinculo {
  equipamentoId: string;
  verRs: boolean;
}

export interface EstadoVinculo {
  validade: string | null;
  equipamentos: ItemVinculo[];
  /** Instalações com "Ver geração". */
  unidadesGeracao: string[];
}

export interface DiffVinculo {
  entram: string[];
  saem: string[];
  verRsLigado: string[];
  verRsDesligado: string[];
  geracaoLigada: string[];
  geracaoDesligada: string[];
  validadeAntes: string | null;
  validadeDepois: string | null;
  mudou: boolean;
}

export function diffVinculo(antes: EstadoVinculo | null, depois: EstadoVinculo): DiffVinculo {
  const a = new Map((antes?.equipamentos ?? []).map((e) => [e.equipamentoId, e.verRs]));
  const d = new Map(depois.equipamentos.map((e) => [e.equipamentoId, e.verRs]));
  const ga = new Set(antes?.unidadesGeracao ?? []);
  const gd = new Set(depois.unidadesGeracao);
  const r: DiffVinculo = {
    entram: [...d.keys()].filter((k) => !a.has(k)),
    saem: [...a.keys()].filter((k) => !d.has(k)),
    verRsLigado: [...d].filter(([k, v]) => v && !a.get(k)).map(([k]) => k),
    verRsDesligado: [...a].filter(([k, v]) => v && d.has(k) && !d.get(k)).map(([k]) => k),
    geracaoLigada: [...gd].filter((u) => !ga.has(u)),
    geracaoDesligada: [...ga].filter((u) => !gd.has(u)),
    validadeAntes: antes?.validade ?? null,
    validadeDepois: depois.validade,
    mudou: false,
  };
  r.mudou = r.entram.length + r.saem.length + r.verRsLigado.length + r.verRsDesligado.length
    + r.geracaoLigada.length + r.geracaoDesligada.length > 0 || r.validadeAntes !== r.validadeDepois;
  return r;
}

/**
 * "Ver geração" ligado numa instalação libera TODOS os inversores dela de uma
 * vez (PER-15). Devolve a lista final, sem duplicar.
 */
export function comInversoresDaGeracao(
  itens: ItemVinculo[],
  unidadesGeracao: string[],
  inversoresPorUnidade: Map<string, string[]>,
): ItemVinculo[] {
  const porId = new Map(itens.map((i) => [i.equipamentoId, i]));
  for (const u of unidadesGeracao) {
    for (const inv of inversoresPorUnidade.get(u) ?? []) {
      if (!porId.has(inv)) porId.set(inv, { equipamentoId: inv, verRs: false });
    }
  }
  return [...porId.values()];
}

/** Tipos que a tela de acesso não lista: gateway/comunicação (o operador não vê comunicação). */
export const TIPOS_FORA_DA_ARVORE: readonly string[] = ['TON1', 'TON2', 'TON3', 'TON4', 'IMS_A966', 'GATEWAY'];

/** Tipos com a chave "Ver R$" (PER-15). */
export const TIPOS_COM_VER_RS: readonly string[] = ['PIVO', 'CARREGADOR_ELETRICO'];

/** Selo "Novo" (PER-21g): cadastrado nos últimos 30 dias e ainda não liberado. */
export function ehNovo(criadoEm: Date | string | null | undefined, liberado: boolean, agora = new Date()): boolean {
  if (liberado || !criadoEm) return false;
  const t = new Date(criadoEm).getTime();
  return Number.isFinite(t) && agora.getTime() - t <= 30 * 24 * 3600 * 1000;
}

/** Resumo do rodapé: "2 usinas · 14 inversores" a partir dos códigos de tipo liberados. */
export function resumoVinculo(codigos: string[], usinas: number): string {
  const n = new Map<string, number>();
  for (const c of codigos) n.set(c, (n.get(c) ?? 0) + 1);
  const partes: string[] = [];
  if (usinas) partes.push(`${usinas} ${usinas === 1 ? 'usina' : 'usinas'}`);
  const rot: Array<[string, string, string]> = [
    ['INVERSOR', 'inversor', 'inversores'],
    ['PIVO', 'pivô', 'pivôs'],
    ['CARREGADOR_ELETRICO', 'carregador', 'carregadores'],
    ['DISJUNTOR', 'disjuntor', 'disjuntores'],
    ['MOTOR', 'motor', 'motores'],
  ];
  let conhecidos = 0;
  for (const [c, um, varios] of rot) {
    const q = n.get(c) ?? 0;
    conhecidos += q;
    if (q) partes.push(`${q} ${q === 1 ? um : varios}`);
  }
  const outros = codigos.length - conhecidos;
  if (outros > 0) partes.push(`${outros} ${outros === 1 ? 'outro equipamento' : 'outros equipamentos'}`);
  return partes.join(' · ') || 'nenhum equipamento';
}
