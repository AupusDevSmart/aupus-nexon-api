import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '@aupus/api-shared';
import { formatMappingIssues, validateMapeamento } from './mapping-validation';
import { CreateIotDeviceModeloDto } from './dto/create-iot-device-modelo.dto';
import { CreateIotDeviceTipoDto } from './dto/create-iot-device-tipo.dto';
import {
  IotCatalogResponseDto,
  IotDeviceModeloDto,
  IotDeviceTipoDto,
} from './dto/iot-catalog-response.dto';
import { UpdateIotDeviceModeloDto } from './dto/update-iot-device-modelo.dto';
import { UpdateIotDeviceTipoDto } from './dto/update-iot-device-tipo.dto';

/**
 * IDs char(26) — gera 26 hex chars (padrao "novo" da casa).
 * O DB declara DEFAULT gen_random_uuid()::text mas estoura char(26).
 */
function newId(): string {
  return crypto.randomBytes(13).toString('hex');
}

/**
 * Slug derivado pra catalog_id ausente.
 * Ex: ("Sungrow","SG250CX") -> "sungrow-sg250cx"
 */
function deriveCatalogId(fabricante: string, modelo: string): string {
  return `${fabricante}-${modelo}`
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

@Injectable()
export class IotCatalogService {
  private readonly logger = new Logger(IotCatalogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Carrega o catalogo inteiro do banco e devolve em formato estruturado.
   * Esta eh a base pro endpoint REST JSON e tambem pro JS de compatibilidade.
   *
   * NAO faz cache aqui — o controller cuida disso via Cache-Control + ETag.
   * Caso o catalogo cresca muito, considerar memoization com invalidacao
   * por evento (admin save).
   */
  async getCatalog(): Promise<IotCatalogResponseDto> {
    const [tiposRaw, modelosRaw] = await Promise.all([
      this.prisma.iot_device_tipos.findMany({ orderBy: { codigo: 'asc' } }),
      this.prisma.iot_device_modelos.findMany({ orderBy: [{ fabricante: 'asc' }, { modelo: 'asc' }] }),
    ]);

    // Resolver FK -> codigo do tipo (consumers do catalogo usam codigo, nao id).
    const tipoCodigoById = new Map(tiposRaw.map((t) => [t.id, t.codigo]));

    const tipos: IotDeviceTipoDto[] = tiposRaw.map((t) => ({
      codigo: t.codigo,
      nome: t.nome,
      pontos: (t.pontos as Record<string, unknown>) ?? {},
    }));

    const modelos: IotDeviceModeloDto[] = modelosRaw.map((m) => {
      const map = (m.mapeamento as Record<string, unknown>) ?? {};
      // `catalog_id` foi salvo dentro de mapeamento pelo seed (slug historico).
      // Eleva-se a coluna no DTO. Fallback: slug determinístico de fabricante+modelo.
      const { catalog_id, ...rest } = map;
      const catalogId =
        typeof catalog_id === 'string' && catalog_id.length > 0
          ? catalog_id
          : `${m.fabricante.toLowerCase()}-${m.modelo.toLowerCase()}`;

      return {
        catalog_id: catalogId,
        fabricante: m.fabricante,
        modelo: m.modelo,
        tipo: tipoCodigoById.get(m.tipo_id) ?? '<unknown>',
        protocolo: m.protocolo,
        connection_note: m.connection_note ?? null,
        mapeamento: rest,
      };
    });

    const version = this.computeVersion([
      ...tiposRaw.map((t) => t.updated_at),
      ...modelosRaw.map((m) => m.updated_at),
    ]);

    return { version, tipos, modelos };
  }

  /**
   * Gera o JS legado equivalente ao `iot-device-catalog.v2.js` original.
   *
   * Mantem o contrato com o `iot-firmware-generator.v2.js` (~2473 linhas, sem testes):
   *   - Globais: `var DEVICE_POINTS = {...}`, `var DEVICE_MODELS = {...}`
   *   - Helpers: getCatalogByType(tipo), getCatalogDevice(catalogId),
   *              getDevicePoints(tipo), getResolvedPoints(catalogId)
   *
   * GAMBIARRA EXPLICITA: o cliente em /AupusNexOn vai carregar isso via <script>
   * tag. Quando o firmware-generator for refatorado pra receber catalog como
   * parametro (Fase C do roadmap), este endpoint pode ser deletado.
   */
  async getLegacyJs(): Promise<{ content: string; version: string }> {
    const catalog = await this.getCatalog();

    const devicePoints: Record<string, unknown> = {};
    for (const t of catalog.tipos) {
      // Eleva `label` (= nome) pro topo do objeto pra bater 100% com o JS antigo.
      devicePoints[t.codigo] = { label: t.nome, ...t.pontos };
    }

    const deviceModels: Record<string, unknown> = {};
    for (const m of catalog.modelos) {
      deviceModels[m.catalog_id] = {
        fabricante: m.fabricante,
        modelo: m.modelo,
        tipo: m.tipo,
        protocolo: m.protocolo,
        ...(m.connection_note ? { connection_note: m.connection_note } : {}),
        ...m.mapeamento,
      };
    }

    const content = [
      `// AUTO-GENERATED from DB (iot_device_tipos + iot_device_modelos).`,
      `// Do not edit. Substituicao do antigo /iot-device-catalog.v2.js estatico.`,
      `// version=${catalog.version}`,
      ``,
      `var DEVICE_POINTS = ${JSON.stringify(devicePoints, null, 2)};`,
      ``,
      `var DEVICE_MODELS = ${JSON.stringify(deviceModels, null, 2)};`,
      ``,
      `function getCatalogByType(tipo) {`,
      `  return Object.entries(DEVICE_MODELS)`,
      `    .filter(function(e) { return e[1].tipo === tipo; })`,
      `    .map(function(e) { var m = e[1]; var o = { id: e[0] }; for (var k in m) { o[k] = m[k]; } return o; });`,
      `}`,
      ``,
      `function getCatalogDevice(catalogId) {`,
      `  return DEVICE_MODELS[catalogId] || null;`,
      `}`,
      ``,
      `function getDevicePoints(tipo) {`,
      `  return DEVICE_POINTS[tipo] || null;`,
      `}`,
      ``,
      `function getResolvedPoints(catalogId) {`,
      `  var model = DEVICE_MODELS[catalogId]; if (!model) return null;`,
      `  var points = DEVICE_POINTS[model.tipo]; if (!points) return null;`,
      `  var resolve = function(arr, mapName) {`,
      `    return (arr || []).map(function(p) {`,
      `      var mapping = (model[mapName] && model[mapName][p.id]) || null;`,
      `      var out = { mapping: mapping, mapped: !!mapping };`,
      `      for (var k in p) { out[k] = p[k]; }`,
      `      out.mapping = mapping; out.mapped = !!mapping;`,
      `      return out;`,
      `    });`,
      `  };`,
      `  return {`,
      `    ai: resolve(points.ai, 'ai_map'),`,
      `    bi: resolve(points.bi, 'bi_map'),`,
      `    bo: resolve(points.bo, 'bo_map'),`,
      `  };`,
      `}`,
      ``,
    ].join('\n');

    return { content, version: catalog.version };
  }

  /**
   * Calcula version determinística do catálogo (max updated_at em ms).
   * Usado como ETag pelo controller e como cache key no client.
   */
  private computeVersion(dates: Date[]): string {
    if (dates.length === 0) return '"empty"';
    const maxMs = Math.max(...dates.map((d) => d.getTime()));
    return `"${maxMs}-${dates.length}"`;
  }

  // ==========================================================================
  // CRUD tipos
  // ==========================================================================

  async listTipos() {
    return this.prisma.iot_device_tipos.findMany({
      orderBy: { codigo: 'asc' },
    });
  }

  async findTipo(id: string) {
    const tipo = await this.prisma.iot_device_tipos.findUnique({
      where: { id: id.trim() },
    });
    if (!tipo) throw new NotFoundException(`Tipo ${id} nao encontrado`);
    return tipo;
  }

  async createTipo(dto: CreateIotDeviceTipoDto) {
    const existing = await this.prisma.iot_device_tipos.findUnique({
      where: { codigo: dto.codigo },
    });
    if (existing) {
      throw new ConflictException(`Tipo com codigo "${dto.codigo}" ja existe`);
    }
    return this.prisma.iot_device_tipos.create({
      data: {
        id: newId(),
        codigo: dto.codigo,
        nome: dto.nome,
        pontos: (dto.pontos as object) ?? { ai: [], bi: [], bo: [] },
      },
    });
  }

  async updateTipo(id: string, dto: UpdateIotDeviceTipoDto) {
    await this.findTipo(id);

    if (dto.codigo) {
      const conflict = await this.prisma.iot_device_tipos.findFirst({
        where: { codigo: dto.codigo, NOT: { id: id.trim() } },
      });
      if (conflict) {
        throw new ConflictException(`Codigo "${dto.codigo}" ja em uso por outro tipo`);
      }
    }

    return this.prisma.iot_device_tipos.update({
      where: { id: id.trim() },
      data: {
        ...(dto.codigo !== undefined ? { codigo: dto.codigo } : {}),
        ...(dto.nome !== undefined ? { nome: dto.nome } : {}),
        ...(dto.pontos !== undefined ? { pontos: dto.pontos as object } : {}),
      },
    });
  }

  async removeTipo(id: string) {
    await this.findTipo(id);
    // Cascade deleta modelos linkados (FK ON DELETE CASCADE).
    return this.prisma.iot_device_tipos.delete({ where: { id: id.trim() } });
  }

  // ==========================================================================
  // CRUD modelos
  // ==========================================================================

  async listModelos(tipoCodigo?: string) {
    if (tipoCodigo) {
      const tipo = await this.prisma.iot_device_tipos.findUnique({
        where: { codigo: tipoCodigo },
      });
      if (!tipo) return [];
      return this.prisma.iot_device_modelos.findMany({
        where: { tipo_id: tipo.id },
        orderBy: [{ fabricante: 'asc' }, { modelo: 'asc' }],
      });
    }
    return this.prisma.iot_device_modelos.findMany({
      orderBy: [{ fabricante: 'asc' }, { modelo: 'asc' }],
    });
  }

  async findModelo(id: string) {
    const m = await this.prisma.iot_device_modelos.findUnique({
      where: { id: id.trim() },
    });
    if (!m) throw new NotFoundException(`Modelo ${id} nao encontrado`);
    return m;
  }

  async createModelo(dto: CreateIotDeviceModeloDto) {
    const tipo = await this.prisma.iot_device_tipos.findUnique({
      where: { codigo: dto.tipo },
    });
    if (!tipo) {
      throw new NotFoundException(
        `Tipo "${dto.tipo}" nao encontrado. Crie o tipo antes de cadastrar o modelo.`,
      );
    }

    const existing = await this.prisma.iot_device_modelos.findUnique({
      where: { fabricante_modelo: { fabricante: dto.fabricante, modelo: dto.modelo } },
    });
    if (existing) {
      throw new ConflictException(
        `Modelo ${dto.fabricante}/${dto.modelo} ja existe`,
      );
    }

    // Valida shape do mapeamento (block/offset/dataType/etc.) antes de gravar.
    // Erros aqui evitam firmware quebrado em runtime no ESP32.
    if (dto.mapeamento) {
      const issues = validateMapeamento(dto.mapeamento);
      if (issues.length > 0) {
        throw new BadRequestException(
          `Mapeamento invalido: ${formatMappingIssues(issues)}`,
        );
      }
    }

    const catalogId = dto.catalog_id ?? deriveCatalogId(dto.fabricante, dto.modelo);
    const mapeamento = {
      catalog_id: catalogId,
      ...(dto.mapeamento ?? {}),
    };

    return this.prisma.iot_device_modelos.create({
      data: {
        id: newId(),
        tipo_id: tipo.id,
        fabricante: dto.fabricante,
        modelo: dto.modelo,
        protocolo: dto.protocolo,
        connection_note: dto.connection_note ?? null,
        mapeamento: mapeamento as object,
      },
    });
  }

  async updateModelo(id: string, dto: UpdateIotDeviceModeloDto) {
    const current = await this.findModelo(id);

    let tipoId = current.tipo_id;
    if (dto.tipo) {
      const tipo = await this.prisma.iot_device_tipos.findUnique({
        where: { codigo: dto.tipo },
      });
      if (!tipo) throw new NotFoundException(`Tipo "${dto.tipo}" nao encontrado`);
      tipoId = tipo.id;
    }

    // Unique (fabricante, modelo) — checar conflito se mudou algum dos dois.
    if (dto.fabricante !== undefined || dto.modelo !== undefined) {
      const fab = dto.fabricante ?? current.fabricante;
      const mod = dto.modelo ?? current.modelo;
      const conflict = await this.prisma.iot_device_modelos.findFirst({
        where: { fabricante: fab, modelo: mod, NOT: { id: id.trim() } },
      });
      if (conflict) {
        throw new ConflictException(`Modelo ${fab}/${mod} ja em uso por outro registro`);
      }
    }

    // Valida shape do mapeamento se informado (mesma protecao do create).
    if (dto.mapeamento) {
      const issues = validateMapeamento(dto.mapeamento);
      if (issues.length > 0) {
        throw new BadRequestException(
          `Mapeamento invalido: ${formatMappingIssues(issues)}`,
        );
      }
    }

    // Preservar catalog_id existente se nao informado — eh referenciado
    // por firmware compilado e nao deve mudar silenciosamente.
    const currentMap = (current.mapeamento as Record<string, unknown>) ?? {};
    const newMapeamentoCore = dto.mapeamento ?? currentMap;
    const { catalog_id: _, ...mapWithoutCatalogId } = newMapeamentoCore as Record<string, unknown>;
    const finalCatalogId =
      dto.catalog_id ?? (currentMap.catalog_id as string | undefined) ?? deriveCatalogId(
        dto.fabricante ?? current.fabricante,
        dto.modelo ?? current.modelo,
      );

    return this.prisma.iot_device_modelos.update({
      where: { id: id.trim() },
      data: {
        tipo_id: tipoId,
        ...(dto.fabricante !== undefined ? { fabricante: dto.fabricante } : {}),
        ...(dto.modelo !== undefined ? { modelo: dto.modelo } : {}),
        ...(dto.protocolo !== undefined ? { protocolo: dto.protocolo } : {}),
        ...(dto.connection_note !== undefined
          ? { connection_note: dto.connection_note }
          : {}),
        mapeamento: { catalog_id: finalCatalogId, ...mapWithoutCatalogId } as object,
      },
    });
  }

  async removeModelo(id: string) {
    await this.findModelo(id);
    return this.prisma.iot_device_modelos.delete({ where: { id: id.trim() } });
  }

  /**
   * Duplica modelo existente (cria copia com sufixo " (copia)" no modelo,
   * mesmo tipo, mesmo mapeamento). Util pro fluxo Sungrow CX (SG250CX -> SG110CX
   * mexendo so num_mppts).
   */
  async duplicateModelo(id: string) {
    const src = await this.findModelo(id);
    const tipo = await this.prisma.iot_device_tipos.findUnique({
      where: { id: src.tipo_id },
    });
    if (!tipo) throw new NotFoundException('Tipo do modelo origem nao encontrado');

    // Acha primeiro sufixo livre
    let n = 1;
    let novoModelo = `${src.modelo} (copia)`;
    while (
      await this.prisma.iot_device_modelos.findUnique({
        where: { fabricante_modelo: { fabricante: src.fabricante, modelo: novoModelo } },
      })
    ) {
      n++;
      novoModelo = `${src.modelo} (copia ${n})`;
    }

    const novoCatalogId = deriveCatalogId(src.fabricante, novoModelo);
    const currentMap = (src.mapeamento as Record<string, unknown>) ?? {};
    const { catalog_id: _, ...mapWithoutCatalogId } = currentMap;

    return this.prisma.iot_device_modelos.create({
      data: {
        id: newId(),
        tipo_id: src.tipo_id,
        fabricante: src.fabricante,
        modelo: novoModelo,
        protocolo: src.protocolo,
        connection_note: src.connection_note,
        mapeamento: { catalog_id: novoCatalogId, ...mapWithoutCatalogId } as object,
      },
    });
  }
}
