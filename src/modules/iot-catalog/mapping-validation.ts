/**
 * Validacao de shape do `mapeamento` Modbus de iot_device_modelos.
 *
 * NAO valida correctness semantica (ex: offset cabe no bloco) — so estrutura
 * que, se errada, faria o firmware-generator quebrar em runtime no ESP32.
 *
 * Erros sao mensagens em PT-BR pra exibir direto pro admin via toast.
 */

const ALLOWED_DATA_TYPES = new Set([
  'U16',
  'S16',
  'U32',
  'S32',
  'FLOAT',
  'COSFI',
  'U32_SUM3',
]);

const ALLOWED_MODES = new Set(['avg', 'last', 'delta']);
const ALLOWED_FACTORS = new Set(['tp', 'tc', 'tp_tc', 'kd']);

export interface MappingValidationIssue {
  path: string;
  message: string;
}

/**
 * Retorna lista de issues. Vazia = OK.
 * Nao lanca — caller decide se rejeita (BadRequest) ou so loga warning.
 */
export function validateMapeamento(map: unknown): MappingValidationIssue[] {
  const issues: MappingValidationIssue[] = [];

  if (map === null || map === undefined) return issues; // permitido (sera tratado como {})

  if (typeof map !== 'object' || Array.isArray(map)) {
    issues.push({ path: '', message: 'mapeamento deve ser um objeto JSON' });
    return issues;
  }

  const m = map as Record<string, unknown>;

  // ai_blocks: opcional, mas se presente deve ser array de { start, count, func, label? }
  if (m.ai_blocks !== undefined) {
    if (!Array.isArray(m.ai_blocks)) {
      issues.push({ path: 'ai_blocks', message: 'ai_blocks deve ser um array' });
    } else {
      m.ai_blocks.forEach((blk, i) => {
        if (typeof blk !== 'object' || blk === null) {
          issues.push({ path: `ai_blocks[${i}]`, message: 'cada bloco deve ser um objeto' });
          return;
        }
        const b = blk as Record<string, unknown>;
        if (typeof b.start !== 'number') {
          issues.push({ path: `ai_blocks[${i}].start`, message: 'start deve ser numero' });
        }
        if (typeof b.count !== 'number' || b.count <= 0) {
          issues.push({
            path: `ai_blocks[${i}].count`,
            message: 'count deve ser numero positivo',
          });
        }
        if (b.func !== undefined && typeof b.func !== 'number') {
          issues.push({ path: `ai_blocks[${i}].func`, message: 'func deve ser numero (ex: 0x03)' });
        }
      });
    }
  }

  const blocksCount = Array.isArray(m.ai_blocks) ? m.ai_blocks.length : 0;
  const blockMaxByIndex: number[] = Array.isArray(m.ai_blocks)
    ? (m.ai_blocks as Array<Record<string, unknown>>).map((b) =>
        typeof b?.count === 'number' ? b.count : Infinity,
      )
    : [];

  // ai_map / bi_map / bo_map: opcionais, objetos. Cada entrada com block/offset
  // validada contra ai_blocks (block index existente, offset dentro do count).
  for (const key of ['ai_map', 'bi_map', 'bo_map'] as const) {
    const val = m[key];
    if (val === undefined) continue;
    if (typeof val !== 'object' || val === null || Array.isArray(val)) {
      issues.push({ path: key, message: `${key} deve ser um objeto` });
      continue;
    }
    for (const [ptId, raw] of Object.entries(val as Record<string, unknown>)) {
      if (typeof raw !== 'object' || raw === null) {
        issues.push({ path: `${key}.${ptId}`, message: 'entrada deve ser um objeto' });
        continue;
      }
      const entry = raw as Record<string, unknown>;

      // Em ai_map, block/offset/dataType sao tipicos. Em bi_map/bo_map pode ter
      // `register`/`coil` em vez de block/offset — validamos apenas se presente.
      if (entry.block !== undefined) {
        if (typeof entry.block !== 'number') {
          issues.push({
            path: `${key}.${ptId}.block`,
            message: 'block deve ser numero (index em ai_blocks)',
          });
        } else if (blocksCount > 0 && (entry.block < 0 || entry.block >= blocksCount)) {
          issues.push({
            path: `${key}.${ptId}.block`,
            message: `block=${entry.block} fora do range (ai_blocks tem ${blocksCount} blocos)`,
          });
        }
      }
      if (entry.offset !== undefined) {
        if (typeof entry.offset !== 'number' || entry.offset < 0) {
          issues.push({
            path: `${key}.${ptId}.offset`,
            message: 'offset deve ser numero >= 0',
          });
        } else if (
          typeof entry.block === 'number' &&
          entry.block >= 0 &&
          entry.block < blockMaxByIndex.length &&
          entry.offset >= blockMaxByIndex[entry.block]
        ) {
          issues.push({
            path: `${key}.${ptId}.offset`,
            message: `offset=${entry.offset} estoura count=${blockMaxByIndex[entry.block]} do block ${entry.block}`,
          });
        }
      }
      if (entry.scale !== undefined && typeof entry.scale !== 'number') {
        issues.push({ path: `${key}.${ptId}.scale`, message: 'scale deve ser numero' });
      }
      if (entry.dataType !== undefined) {
        if (typeof entry.dataType !== 'string' || !ALLOWED_DATA_TYPES.has(entry.dataType)) {
          issues.push({
            path: `${key}.${ptId}.dataType`,
            message: `dataType invalido. Aceitos: ${Array.from(ALLOWED_DATA_TYPES).join(', ')}`,
          });
        }
      }
      if (entry.mode !== undefined) {
        if (typeof entry.mode !== 'string' || !ALLOWED_MODES.has(entry.mode)) {
          issues.push({
            path: `${key}.${ptId}.mode`,
            message: `mode invalido. Aceitos: ${Array.from(ALLOWED_MODES).join(', ')}`,
          });
        }
      }
      if (entry.apply_factor !== undefined) {
        if (typeof entry.apply_factor !== 'string' || !ALLOWED_FACTORS.has(entry.apply_factor)) {
          issues.push({
            path: `${key}.${ptId}.apply_factor`,
            message: `apply_factor invalido. Aceitos: ${Array.from(ALLOWED_FACTORS).join(', ')}`,
          });
        }
      }
    }
  }

  return issues;
}

/**
 * Helper que monta mensagem unica para BadRequestException quando ha issues.
 */
export function formatMappingIssues(issues: MappingValidationIssue[]): string {
  return issues
    .map((i) => (i.path ? `[${i.path}] ${i.message}` : i.message))
    .join('; ');
}
