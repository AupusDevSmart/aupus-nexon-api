import { normalizarTexto } from '../../shared/util/janela-horario';

/**
 * Pontos de status do disjuntor (scs-bundle.status_pontos) — lógica PURA,
 * testada em status-pontos.util.spec.ts.
 */
export const PAPEIS_STATUS = ['aberto', 'fechado', 'mola', 'local', 'remoto'] as const;
export type PapelStatus = (typeof PAPEIS_STATUS)[number];

/**
 * Papel do ponto: o declarado no vínculo (iot_vinculos.papel) quando é um dos
 * cinco conhecidos; senão inferido pelo nome ("Mola carregada" → mola,
 * "DJ aberto" → aberto). Nome ambíguo ("Local/Remoto", "Aberto/Fechado") → null.
 */
export function papelDoPonto(papelVinculo: unknown, nomePonto: unknown): PapelStatus | null {
  const declarado = normalizarTexto(papelVinculo);
  if ((PAPEIS_STATUS as readonly string[]).includes(declarado)) return declarado as PapelStatus;

  const n = normalizarTexto(nomePonto);
  if (!n) return null;
  if (/\bmola\b/.test(n)) return 'mola';
  const remoto = /\bremot[oa]\b/.test(n);
  const local = /\blocal\b/.test(n);
  if (remoto !== local) return remoto ? 'remoto' : 'local';
  if (remoto && local) return null;
  const aberto = /\b(aberto|aberta|abrir|open|opened)\b/.test(n);
  const fechado = /\b(fechado|fechada|fechar|closed|close)\b/.test(n);
  if (aberto !== fechado) return aberto ? 'aberto' : 'fechado';
  return null;
}

/** Bit lido da TON → 0|1|null, com inversão NF (params.invertido). */
export function valorDoBit(raw: unknown, invertido: unknown): 0 | 1 | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const bit = n ? 1 : 0;
  return invertido === true || invertido === 'true' ? ((1 - bit) as 0 | 1) : bit;
}
