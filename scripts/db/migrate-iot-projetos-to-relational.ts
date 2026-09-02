/**
 * MIGRATION (one-shot): converte iot_projetos.diagrama JSONB em linhas
 * relacionais em iot_componentes + iot_conexoes, e move pan/zoom para as
 * colunas view_pan_x/y/zoom de iot_projetos.
 *
 * Idempotente: skipa projetos que ja tem iot_componentes populadas.
 *
 * Preserva o cache JSONB em iot_projetos.diagrama — nao limpa nem mexe.
 * O frontend continua lendo do JSONB; as tabelas relacionais sao a base
 * para a integracao IoT <-> Diagrama Unifilar e ficam em paralelo ate
 * deprecacao do cache (1-2 sprints).
 *
 * Como rodar (em prod):
 *   cd /var/www/service-nexon/aupus-nexon-api
 *   pnpm exec ts-node scripts/db/migrate-iot-projetos-to-relational.ts
 *
 * Esperado:
 *   [info]  Encontrados N projetos IoT nao-deletados
 *   [migrating] <id> (<nome>): X components, Y connections
 *   [ok]    <id>: inseriu A componentes + B conexoes
 *   ...
 *   [done]  N processados (M migrados, K skipped)
 */

import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@/core';
import type { Prisma } from '@/core';

interface RawComponent {
  id: string | number;
  type: string;
  x: number;
  y: number;
  props?: Record<string, unknown>;
  equipamento_id?: string;
  [k: string]: unknown;
}

interface RawConnectionRef {
  componentId?: string | number;
  id?: string | number;
  port?: string;
}

interface RawConnection {
  id?: string | number;
  from: string | number | RawConnectionRef;
  to: string | number | RawConnectionRef;
  style?: string;
  estilo?: string;
  [k: string]: unknown;
}

interface RawDiagrama {
  components?: RawComponent[];
  connections?: RawConnection[];
  pan?: { x?: number; y?: number };
  zoom?: number;
  nextId?: number;
}

const generateId = (): string => randomBytes(13).toString('hex');

function rawEquipamentoId(comp: RawComponent): string | null {
  const fromProps =
    comp.props && typeof comp.props === 'object'
      ? (comp.props as Record<string, unknown>).equipamento_id
      : undefined;
  const raw =
    typeof fromProps === 'string' ? fromProps : comp.equipamento_id;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function extractComponentProps(comp: RawComponent): Record<string, unknown> {
  const { id: _id, type: _type, x: _x, y: _y, props, ...rest } = comp;
  const merged: Record<string, unknown> = { ...rest };
  if (props && typeof props === 'object') {
    Object.assign(merged, props);
  }
  return merged;
}

function parseRef(
  ref: string | number | RawConnectionRef | undefined,
): { componentId: string; port?: string } | null {
  if (ref === null || ref === undefined) return null;
  if (typeof ref === 'string' || typeof ref === 'number') {
    return { componentId: String(ref) };
  }
  const compId = ref.componentId ?? ref.id;
  if (compId === undefined || compId === null) return null;
  return { componentId: String(compId), port: ref.port };
}

const truncate = (s: string | undefined, max: number): string =>
  s ? s.slice(0, max) : '';

async function main() {
  const prisma = new PrismaClient();
  let migrated = 0;
  let skipped = 0;
  let totalComps = 0;
  let totalConns = 0;
  let orphanConns = 0;

  try {
    const projetos = await prisma.iot_projetos.findMany({
      where: { deleted_at: null },
      select: { id: true, nome: true, diagrama: true },
      orderBy: { created_at: 'asc' },
    });

    console.log(`[info]  Encontrados ${projetos.length} projetos IoT nao-deletados\n`);

    for (const projeto of projetos) {
      const existingCount = await prisma.iot_componentes.count({
        where: { projeto_id: projeto.id },
      });
      const diagrama = (projeto.diagrama ?? {}) as RawDiagrama;
      const comps = Array.isArray(diagrama.components) ? diagrama.components : [];
      const conns = Array.isArray(diagrama.connections) ? diagrama.connections : [];

      if (existingCount > 0) {
        console.log(
          `[skip]  ${projeto.id} (${projeto.nome}): ja tem ${existingCount} componentes em iot_componentes — provavelmente migrado.`,
        );
        skipped += 1;
        continue;
      }

      if (comps.length === 0) {
        // projeto sem componentes no JSON — popular so o viewport e contar como skip
        await prisma.iot_projetos.update({
          where: { id: projeto.id },
          data: {
            view_pan_x: typeof diagrama.pan?.x === 'number' ? diagrama.pan.x : 0,
            view_pan_y: typeof diagrama.pan?.y === 'number' ? diagrama.pan.y : 0,
            view_zoom: typeof diagrama.zoom === 'number' ? diagrama.zoom : 1,
          },
        });
        console.log(
          `[skip]  ${projeto.id} (${projeto.nome}): JSON sem components — viewport sincronizado, nada a migrar.`,
        );
        skipped += 1;
        continue;
      }

      console.log(
        `[migrating] ${projeto.id} (${projeto.nome}): ${comps.length} components, ${conns.length} connections`,
      );

      // Pre-resolve equipamento_ids requisitados pelos components do projeto.
      const requestedEquipIds = new Set<string>();
      for (const comp of comps) {
        const raw = rawEquipamentoId(comp);
        if (raw) requestedEquipIds.add(raw);
      }
      const validEquipIds = new Set<string>();
      if (requestedEquipIds.size > 0) {
        const found = await prisma.equipamentos.findMany({
          where: { id: { in: Array.from(requestedEquipIds) }, deleted_at: null },
          select: { id: true },
        });
        for (const e of found) validEquipIds.add(e.id.trim());
        const missing = Array.from(requestedEquipIds).filter(
          (id) => !validEquipIds.has(id),
        );
        if (missing.length > 0) {
          console.log(
            `        [warn] ${missing.length} equipamento_id(s) nao encontrado(s): ${missing.join(', ')}`,
          );
        }
      }

      await prisma.$transaction(async (tx) => {
        // viewport pan/zoom
        await tx.iot_projetos.update({
          where: { id: projeto.id },
          data: {
            view_pan_x: typeof diagrama.pan?.x === 'number' ? diagrama.pan.x : 0,
            view_pan_y: typeof diagrama.pan?.y === 'number' ? diagrama.pan.y : 0,
            view_zoom: typeof diagrama.zoom === 'number' ? diagrama.zoom : 1,
          },
        });

        const idMapping = new Map<string, string>();
        for (const comp of comps) {
          if (!comp || typeof comp.type !== 'string') continue;
          const dbId = generateId();
          idMapping.set(String(comp.id), dbId);

          const rawEquip = rawEquipamentoId(comp);
          const equipamentoId =
            rawEquip && validEquipIds.has(rawEquip) ? rawEquip : null;

          await tx.iot_componentes.create({
            data: {
              id: dbId,
              projeto_id: projeto.id,
              tipo: comp.type,
              x: typeof comp.x === 'number' ? comp.x : 0,
              y: typeof comp.y === 'number' ? comp.y : 0,
              equipamento_id: equipamentoId,
              props: extractComponentProps(comp) as unknown as Prisma.InputJsonValue,
            },
          });
        }

        let insertedConns = 0;
        for (const conn of conns) {
          const fromRef = parseRef(conn.from);
          const toRef = parseRef(conn.to);
          if (!fromRef || !toRef) {
            orphanConns += 1;
            continue;
          }
          const fromCompId = idMapping.get(fromRef.componentId);
          const toCompId = idMapping.get(toRef.componentId);
          if (!fromCompId || !toCompId) {
            orphanConns += 1;
            continue;
          }

          const estilo =
            typeof conn.style === 'string'
              ? conn.style
              : typeof conn.estilo === 'string'
                ? conn.estilo
                : 'rs485';

          await tx.iot_conexoes.create({
            data: {
              id: generateId(),
              projeto_id: projeto.id,
              from_comp_id: fromCompId,
              from_port: truncate(fromRef.port, 10),
              to_comp_id: toCompId,
              to_port: truncate(toRef.port, 10),
              estilo: estilo.slice(0, 20),
            },
          });
          insertedConns += 1;
        }

        totalComps += idMapping.size;
        totalConns += insertedConns;
        console.log(
          `[ok]    ${projeto.id}: inseriu ${idMapping.size} componentes + ${insertedConns} conexoes`,
        );
      });

      migrated += 1;
    }

    console.log(
      `\n[done]  ${projetos.length} processados (${migrated} migrados, ${skipped} skipped)`,
    );
    console.log(
      `        ${totalComps} componentes inseridos, ${totalConns} conexoes inseridas, ${orphanConns} conexoes orfas descartadas`,
    );
  } catch (err) {
    console.error('[error] Migracao falhou:', err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
