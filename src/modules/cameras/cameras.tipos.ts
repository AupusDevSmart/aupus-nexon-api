import type { ScopedUser } from '@/core';

/** Usuário do JWT (id, role, nome, email) ou resolvido de um token de mídia (`?token=`). */
export type Usuario = ScopedUser & { nome?: string | null; email?: string | null; viaTokenMidia?: boolean };

/** Agente autenticado pelo CameraAgenteGuard (req.agente). Ids sem padding. */
export interface AgenteInfo {
  id: string;
  unidade_id: string;
  planta_id: string;
  nome: string;
}

export interface NomeId {
  id: string;
  nome: string;
}

export interface ContextoUnidade {
  unidade: NomeId | null;
  planta: NomeId | null;
}
