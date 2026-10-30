import type { PrismaService } from '../../../prisma/prisma.service';

export type StatusPivo = Partial<Record<'direita' | 'esquerda' | 'desligado' | 'erro', 0 | 1 | null>>;

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Mesmos nomes de ponto que /pivos/:id/estado usa para achar o papel de cada entrada da TON. */
export function papelStatusPivo(nome: string): keyof StatusPivo | null {
  const n = norm(nome);
  if (/erro|falha/.test(n)) return 'erro';
  if (/deslig|parad/.test(n)) return 'desligado';
  if (/esquerd/.test(n)) return 'esquerda';
  if (/direit/.test(n)) return 'direita';
  return null;
}

export const ehPivo = (tipo?: string | null): boolean => /piv[oô]/i.test(tipo ?? '');

/**
 * Status das entradas da TON nos nomes que os apps já leem em `dados` (LeituraPivo). Direita é
 * Avanço e esquerda é Reverso, como no web. Entrada sem leitura não vira campo.
 */
export function camposDoStatusPivo(st: StatusPivo): Record<string, unknown> {
  const lidos = [st.direita, st.esquerda, st.desligado, st.erro].some((v) => v === 0 || v === 1);
  if (!lidos) return {};
  const girando = st.direita === 1 || st.esquerda === 1;
  return {
    irrigando: girando,
    ...(st.direita === 1 ? { sentido: 'Avanço' } : st.esquerda === 1 ? { sentido: 'Reverso' } : {}),
    falha: st.erro === 1,
    painel_energizado: true,
  };
}

/**
 * Device que publica a leitura de um equipamento sem leitura própria (medidor vinculado no IoT, ou
 * o que atende vários elementos). Mesma resolução do web (power-meter-by-disjuntor), limitada à
 * instalação do equipamento para um vínculo errado não expor leitura de outro cliente.
 */
export async function deviceVinculado(prisma: PrismaService, id: string): Promise<string | null> {
  const eid = id.trim();
  const fontes = await prisma.$queryRaw<Array<{ fonte: string }>>`
    SELECT src.id AS fonte
    FROM iot_componentes c
    JOIN equipamentos alvo ON alvo.id = ${eid}::bpchar AND alvo.deleted_at IS NULL
    JOIN equipamentos src ON src.id = TRIM(c.props->>'equipamento_id')::bpchar
      AND src.deleted_at IS NULL AND src.unidade_id = alvo.unidade_id
    WHERE c.props->>'disjuntor_equipamento_id' = ${eid}
       OR (jsonb_typeof(c.props->'elementos_extra') = 'array' AND c.props->'elementos_extra' ? ${eid})
    ORDER BY (c.props->>'disjuntor_equipamento_id' = ${eid}) DESC, c.id
    LIMIT 1`;
  return fontes[0]?.fonte ?? null;
}

/** O próprio id se ele tem leitura; senão o device vinculado, se houver. */
export async function idDaLeitura(prisma: PrismaService, id: string): Promise<string> {
  const proprio = await prisma.equipamentos_dados.findFirst({ where: { equipamento_id: id.trim().padEnd(26) }, select: { id: true } });
  if (proprio) return id;
  return (await deviceVinculado(prisma, id)) ?? id;
}
