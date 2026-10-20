import { FUSO_OPERACAO } from '../../shared/util/janela-horario';
import { isGlobal, papelCanonico } from '../../core/modules/auth/papeis';

/**
 * Regras do carregador (condomínio) — lógica PURA, testada em carregador.util.spec.ts.
 *
 * Perfis (mockup "Web — Modal do Carregador" + NEXON-20, seção 5):
 *  - analista: Aupus (Admin, analista de automação ou de operação) — edita o valor do kWh e tudo mais;
 *  - proprietario: dono da planta — gerencia moradores, vê todas as recargas, exporta;
 *  - operador: equipamento liberado — libera e para recargas (portaria), lista moradores;
 *    não cadastra morador nem exporta (PER-38); R$ só com "Ver valores em R$";
 *  - morador: usuário ligado a um morador — só as próprias recargas, inicia/para a própria.
 */
export type PapelCarregador = 'analista' | 'proprietario' | 'operador' | 'morador';

export function papelCarregador(role: unknown, temMoradorVinculado: boolean): PapelCarregador {
  const p = papelCanonico(typeof role === 'string' ? role : null);
  if (isGlobal(p)) return 'analista';
  if (p === 'proprietario') return 'proprietario';
  if (temMoradorVinculado) return 'morador';
  if (p === 'operador') return 'operador';
  // Papel sem nome no NexON (cativo, associado...): o escopo por vínculo já
  // recorta as plantas; dentro delas vale como dono (comportamento de antes).
  return 'proprietario';
}

/** Exporta a planilha de recargas (PER-38): proprietário, analistas e Admin. */
export function podeExportarRecargas(papel: PapelCarregador): boolean {
  return papel === 'analista' || papel === 'proprietario';
}

/** Cadastra, altera e remove morador: proprietário, analistas e Admin. */
export function podeGerirMoradores(papel: PapelCarregador): boolean {
  return papel === 'analista' || papel === 'proprietario';
}

/**
 * Morador só vê valores (kWh, R$/kWh) da PRÓPRIA recarga; os demais papéis veem
 * todas (o operador ainda depende de "Ver valores em R$" no carregador).
 */
export function moradorVeValoresDa(papel: PapelCarregador, meuMoradorId: string | null | undefined, moradorDaSessao: string | null | undefined): boolean {
  if (papel !== 'morador') return true;
  const eu = String(meuMoradorId ?? '').trim();
  return !!eu && eu === String(moradorDaSessao ?? '').trim();
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
