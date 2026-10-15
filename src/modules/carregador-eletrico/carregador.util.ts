import { FUSO_OPERACAO } from '../../shared/util/janela-horario';

/**
 * Regras do carregador (condomínio) — lógica PURA, testada em carregador.util.spec.ts.
 *
 * Perfis (mockup "Web — Modal do Carregador"):
 *  - analista: Aupus (super_admin/admin/gerente/analista) — edita o valor do kWh e tudo mais;
 *  - proprietario: dono da planta — gerencia moradores, vê todas as recargas, exporta;
 *  - morador: usuário ligado a um morador — só as próprias recargas, inicia/para a própria.
 */
export type PapelCarregador = 'analista' | 'proprietario' | 'morador';

const ANALISTA = ['super_admin', 'admin', 'gerente', 'analista'];

export function papelCarregador(role: unknown, temMoradorVinculado: boolean): PapelCarregador {
  const r = String(role ?? '').toLowerCase();
  if (ANALISTA.includes(r)) return 'analista';
  if (r === 'proprietario') return 'proprietario';
  return temMoradorVinculado ? 'morador' : 'proprietario';
}

export const TARIFA_MIN = 0.3;
export const TARIFA_MAX = 5;

export function tarifaValida(v: unknown): number | null {
  const n = Number(String(v ?? '').replace(',', '.'));
  if (!Number.isFinite(n) || n < TARIFA_MIN || n > TARIFA_MAX) return null;
  return Math.round(n * 10000) / 10000;
}

/** 'YYYY-MM-DD' de hoje em America/Sao_Paulo. */
export function hojeSP(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: FUSO_OPERACAO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function somarDias(ymd: string, dias: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + dias));
  return t.toISOString().slice(0, 10);
}

/** Validade do acesso: último dia em que o morador ainda pode carregar (inclusive). */
export type SituacaoValidade = 'sem_validade' | 'valido' | 'vence_amanha' | 'vencido';

export function situacaoValidade(validade: string | null | undefined, hoje: string): SituacaoValidade {
  if (!validade) return 'sem_validade';
  const v = String(validade).slice(0, 10);
  if (v < hoje) return 'vencido';
  if (v === hoje || v === somarDias(hoje, 1)) return 'vence_amanha';
  return 'valido';
}

/** Data 'YYYY-MM-DD' aceitável (ou null = sem validade). Inválida → undefined. */
export function validadeDe(v: unknown): string | null | undefined {
  if (v === null || v === '' || v === undefined) return null;
  const s = String(v).trim();
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  const iso = br ? `${br[3]}-${br[2]}-${br[1]}` : s.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return undefined;
  const d = new Date(`${iso}T12:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? undefined : iso;
}

/** "31/12/2026". */
export function dataBR(ymd: string): string {
  const [y, m, d] = ymd.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}
