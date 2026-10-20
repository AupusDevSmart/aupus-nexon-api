import { ROTULO_CANAL, ROTULO_EVENTO, type CanalNotificacao, type EventoNotificacao } from './regras-notificacao.constants';

/** Campos da regra que entram na trilha (auditoria_acessos, acao 'regra_notificacao'). */
export const CAMPOS_AUDITADOS = [
  'nome',
  'evento',
  'limite_minutos',
  'antecedencia_dias',
  'canais',
  'papeis',
  'planta_ids',
  'usuario_ids',
  'ativo',
] as const;

export interface AlteracaoCampo {
  campo: string;
  antes: unknown;
  depois: unknown;
}

const normalizar = (v: unknown): unknown =>
  Array.isArray(v) ? [...v].map((x) => String(x).trim()).sort() : v === undefined ? null : v;

/** Só o que mudou, campo a campo (arrays comparados sem ordem). */
export function diffRegra(antes: Record<string, unknown>, depois: Record<string, unknown>): AlteracaoCampo[] {
  const out: AlteracaoCampo[] = [];
  for (const campo of CAMPOS_AUDITADOS) {
    if (!(campo in depois)) continue;
    const a = normalizar(antes[campo]);
    const d = normalizar(depois[campo]);
    if (JSON.stringify(a) !== JSON.stringify(d)) out.push({ campo, antes: a, depois: d });
  }
  return out;
}

export function rotuloEvento(evento: string): string {
  return ROTULO_EVENTO[evento as EventoNotificacao] ?? evento;
}

export function rotuloCanais(canais: string[]): string {
  return canais.map((c) => ROTULO_CANAL[c as CanalNotificacao] ?? c).join(', ') || 'sem canal';
}

const ROTULO_CAMPO: Record<string, string> = {
  nome: 'nome',
  evento: 'evento',
  limite_minutos: 'tempo sem comunicação',
  antecedencia_dias: 'antecedência',
  canais: 'canais',
  papeis: 'papéis',
  planta_ids: 'plantas',
  usuario_ids: 'usuários',
  ativo: 'ativa',
};

/** Frase curta para a mensagem da trilha (busca por texto em Logs). */
export function resumirAlteracoes(alteracoes: AlteracaoCampo[]): string {
  if (!alteracoes.length) return 'sem mudança';
  return alteracoes
    .map((a) => {
      if (a.campo === 'ativo') return a.depois ? 'ativada' : 'desativada';
      if (a.campo === 'canais') return `canais: ${rotuloCanais((a.depois as string[]) ?? [])}`;
      if (a.campo === 'evento') return `evento: ${rotuloEvento(String(a.depois))}`;
      if (a.campo === 'nome') return `nome: ${String(a.depois)}`;
      return ROTULO_CAMPO[a.campo] ?? a.campo;
    })
    .join('; ');
}
