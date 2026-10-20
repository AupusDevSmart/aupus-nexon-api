import { Prisma } from '@/core';

/** Texto do JSON → numeric só quando for número (um "N/A" não pode derrubar a consulta). */
export function sqlNum(expr: string): Prisma.Sql {
  return Prisma.raw(`(CASE WHEN (${expr}) ~ '^\\s*-?[0-9]+(\\.[0-9]+)?([eE][-+]?[0-9]+)?\\s*$' THEN (${expr})::numeric END)`);
}
