import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { papelDoPonto, valorDoBit } from './status-pontos.util';
import { randomBytes } from 'node:crypto';
import { PrismaService, PermissionScopeService, ScopedUser } from '@/core';
import { Prisma } from '@/core';
import { tonCapsForTipo } from '../../shared/util/ton-caps';
import { VinculosMirrorService } from '../iot-vinculos/vinculos-mirror.service';
import type {
  IotDiagrama,
  IotDiagramaComponent,
  IotProjetoRow,
} from './interfaces/iot-diagrama.interface';

const EMPTY_DIAGRAMA: IotDiagrama = {
  components: [],
  connections: [],
  nextId: 1,
};

const PROJETO_SELECT = {
  id: true,
  unidade_id: true,
  nome: true,
  diagrama: true,
  created_at: true,
  updated_at: true,
} as const;

/**
 * Service de projetos IoT.
 *
 * Persistencia dupla durante transicao (PR1, 2026-05):
 * - Cache JSONB em `iot_projetos.diagrama` — formato consumido pelo frontend
 *   legado iot-diagram.v2.js sem mudancas. Continua sendo a fonte do GET.
 * - Tabelas relacionais `iot_componentes` + `iot_conexoes` — base da
 *   integracao IoT <-> Diagrama Unifilar via FK iot_componentes.equipamento_id.
 *
 * Em PUT, ambos sao escritos juntos numa transacao. JSONB sera deprecated
 * apos 1-2 sprints estaveis.
 *
 * Sobre o sync delete-all+insert-all em syncRelational: simples e atomico
 * mas faz CASCADE em iot_firmwares e SET NULL em iot_dispositivos_online dos
 * componentes. Aceitavel hoje (ambas tabelas sem dados de producao). Quando
 * ganharem, trocar por delta upsert preservando IDs estaveis.
 */
@Injectable()
export class IoTService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopeService: PermissionScopeService,
    private readonly mirror: VinculosMirrorService,
  ) {}

  /** Gera um ID hex de 26 chars compativel com CHAR(26) — preserva o formato dos registros existentes. */
  private generateId(): string {
    return randomBytes(13).toString('hex');
  }

  /** Resolve unidade_id de um projeto IoT. */
  private async unidadeIdDoProjeto(projetoId: string): Promise<string | null> {
    const p = await this.prisma.iot_projetos.findFirst({
      where: { id: projetoId.trim() },
      select: { unidade_id: true },
    });
    return p?.unidade_id?.trim() ?? null;
  }

  async getProjetosByUnidade(unidadeId: string, user?: ScopedUser): Promise<IotProjetoRow[]> {
    if (user) await this.scopeService.assertEntityInScope('unidade', unidadeId.trim(), user);
    const rows = await this.prisma.iot_projetos.findMany({
      where: { unidade_id: unidadeId.trim(), deleted_at: null },
      orderBy: { created_at: 'asc' },
      select: PROJETO_SELECT,
    });
    return rows.map(this.toProjetoRow);
  }

  async getProjetoById(id: string, user?: ScopedUser): Promise<IotProjetoRow | null> {
    const row = await this.prisma.iot_projetos.findFirst({
      where: { id: id.trim(), deleted_at: null },
      select: PROJETO_SELECT,
    });
    if (!row) return null;
    if (user) await this.scopeService.assertEntityInScope('unidade', row.unidade_id.trim(), user);
    return this.toProjetoRow(row);
  }

  /**
   * FASE 6 — projeção `iot_vinculos`(modbus_bo) → io_config.bo dos relés DESTE projeto.
   * Forma: { [relayEquipId]: { [sinal]: { ...params, ponto_id } } } — a MESMA que o gerador
   * consome em props.io_config.bo, mas vinda da tabela unificada. O frontend hidrata o
   * props.io_config.bo antes de gerar o firmware (merge: vínculo sobrescreve por comando,
   * props preenche lacuna) — o gerador fica INTOCADO. Escopado por projeto + dono da unidade.
   * (Byte-idêntico ao props validado no harness tools/fw-regress --from-vinculos.)
   */
  async projetarVinculosBo(
    projetoId: string,
    user?: ScopedUser,
  ): Promise<Record<string, Record<string, unknown>>> {
    const id = (projetoId ?? '').trim();
    if (!id) return {};
    const proj = await this.prisma.iot_projetos.findFirst({
      where: { id, deleted_at: null },
      select: { unidade_id: true },
    });
    if (!proj) return {};
    if (user) await this.scopeService.assertEntityInScope('unidade', proj.unidade_id.trim(), user);

    const rows = await this.prisma.$queryRaw<
      Array<{ relay: string; sinal: string; ponto_id: string; equip_dono: string | null; params: Record<string, unknown> | null }>
    >`
      SELECT TRIM(v.fonte_equipamento_id) AS relay, v.sinal AS sinal,
             TRIM(v.equipamento_ponto_id) AS ponto_id, TRIM(p.equipamento_id) AS equip_dono, v.params AS params
      FROM iot_vinculos v
      JOIN equipamento_pontos p ON p.id = v.equipamento_ponto_id
      WHERE v.fonte_tipo = 'modbus_bo' AND v.ativo = true AND v.deleted_at IS NULL
        AND TRIM(v.fonte_equipamento_id) IN (
          SELECT DISTINCT COALESCE(NULLIF(TRIM(c.equipamento_id), ''), c.props->>'equipamento_id')
          FROM iot_componentes c WHERE TRIM(c.projeto_id) = ${id}
        )
      ORDER BY TRIM(v.fonte_equipamento_id), v.sinal`;

    // equipamento_id (dono do ponto) é re-derivado aqui — o vínculo não o guarda em params,
    // mas o DeviceIoConfigModal PRECISA dele (buildConfig descarta bo sem equipamento_id).
    const out: Record<string, Record<string, unknown>> = {};
    for (const r of rows) {
      (out[r.relay] ||= {})[r.sinal] = {
        ...(r.params || {}),
        ponto_id: r.ponto_id,
        ...(r.equip_dono ? { equipamento_id: r.equip_dono } : {}),
      };
    }
    return out;
  }

  /**
   * FASE 6 (inversão da escrita) — grava o comando de relé (modbus_bo) DIRETO no vínculo,
   * como fonte da verdade. `boMap` = { [sinal]: { coil, func, ..., ponto_id } } (a forma do
   * io_config.bo). Substitui todos os modbus_bo do relé (origem='ui'). Escopado pelo dono do
   * equipamento-relé. O props.io_config.bo continua sendo escrito pela UI como FALLBACK — o
   * resync não reconstrói mais o modbus_bo, então esta escrita é autoritativa.
   */
  async escreverVinculosBo(
    relayEquipId: string,
    boMap: Record<string, unknown>,
    user?: ScopedUser,
  ): Promise<{ escritos: number }> {
    const id = (relayEquipId ?? '').trim();
    if (!id) return { escritos: 0 };
    if (user) await this.scopeService.assertEntityInScope('equipamento', id, user);
    const escritos = await this.mirror.escreverModbusBo(id, (boMap ?? {}) as Record<string, any>);
    return { escritos };
  }

  /**
   * Bundle do sheet do DJ (Fase 6): declaração SCS + PM associado + fonte de status
   * (relé) + comandos (ton_bo). O front monta a tela (Estado/Controles/Status/Medição)
   * e assina a telemetria ao vivo do PM/relé. Escopado por dono.
   */
  async disjuntorScsBundle(disjuntorId: string, user?: ScopedUser) {
    const id = (disjuntorId ?? '').trim();
    if (!id) return null;
    const eqRows = await this.prisma.$queryRaw<Array<{
      id: string; nome: string | null; scs: boolean; scs_comando: boolean; scs_status: boolean; scs_medicao: string;
    }>>`
      SELECT TRIM(id) AS id, TRIM(nome) AS nome, scs, scs_comando, scs_status, scs_medicao
      FROM equipamentos WHERE TRIM(id) = ${id} AND deleted_at IS NULL LIMIT 1`;
    const eq = eqRows[0];
    if (!eq) return null;
    if (user) await this.scopeService.assertEntityInScope('equipamento', id, user);
    const [pm, statusFonte, comandos, statusPontos] = await Promise.all([
      this.powerMeterByDisjuntor(id),
      this.statusFonteDoDisjuntor(id, user),
      this.prisma.$queryRaw<Array<{ ponto: string; ponto_id: string; bo_numero: number; pulso_ms: number; ton_id: string }>>`
        SELECT ep.nome AS ponto, TRIM(ep.id) AS ponto_id, tb.bo_numero, tb.pulso_ms, TRIM(tb.ton_id) AS ton_id
        FROM equipamento_pontos ep
        JOIN ton_bo tb ON TRIM(tb.equipamento_ponto_id) = TRIM(ep.id) AND tb.ativo = true AND tb.deleted_at IS NULL
        WHERE TRIM(ep.equipamento_id) = ${id} AND ep.tipo = 'comando' AND ep.ativo = true AND ep.deleted_at IS NULL`,
      this.statusPontosDoDisjuntor(id),
    ]);
    return {
      equipamento: { id: eq.id, nome: eq.nome },
      scs: { habilitado: eq.scs, comando: eq.scs_comando, status: eq.scs_status, medicao: eq.scs_medicao },
      pm, status_fonte: statusFonte, comandos,
      status_pontos: statusPontos,
    };
  }

  /**
   * Pontos de status do DJ ligados a entradas digitais da TON (iot_vinculos
   * fonte_tipo='ton_bi'): valor = bit d{canal} do último equipamento_io_estado
   * da TON (o mesmo que GET /equipamentos/:tonId/bis/estado), com inversão NF
   * (params.invertido). Papel do vínculo ou inferido pelo nome (aberto/fechado/
   * mola/local/remoto). Espelho vazio → cai no ton_bi. Erro → [] (o sheet segue).
   */
  private async statusPontosDoDisjuntor(disjuntorId: string) {
    type Row = {
      ponto_id: string; nome: string; papel: string | null; invertido: unknown;
      valor_raw: unknown; updated_at: Date | null;
    };
    try {
      let rows = await this.prisma.$queryRaw<Row[]>`
        SELECT TRIM(ep.id) AS ponto_id, TRIM(ep.nome) AS nome, v.papel,
               v.params->>'invertido' AS invertido,
               io.inputs ->> ('d' || v.canal) AS valor_raw, io.updated_at
        FROM iot_vinculos v
        JOIN equipamento_pontos ep ON ep.id = v.equipamento_ponto_id AND ep.deleted_at IS NULL AND ep.ativo = true
        LEFT JOIN equipamento_io_estado io ON io.equipamento_id = v.fonte_equipamento_id
        WHERE v.fonte_tipo = 'ton_bi' AND v.ativo = true AND v.deleted_at IS NULL
          AND ep.equipamento_id = ${disjuntorId}::bpchar
        ORDER BY ep.ordem NULLS LAST, ep.nome`;
      if (rows.length === 0) {
        rows = await this.prisma.$queryRaw<Row[]>`
          SELECT TRIM(ep.id) AS ponto_id, TRIM(ep.nome) AS nome, NULL::text AS papel,
                 b.invertido::text AS invertido,
                 io.inputs ->> ('d' || b.bi_numero) AS valor_raw, io.updated_at
          FROM ton_bi b
          JOIN equipamento_pontos ep ON ep.id = b.equipamento_ponto_id AND ep.deleted_at IS NULL AND ep.ativo = true
          LEFT JOIN equipamento_io_estado io ON io.equipamento_id = b.ton_id
          WHERE b.ativo = true AND b.deleted_at IS NULL AND ep.equipamento_id = ${disjuntorId}::bpchar
          ORDER BY ep.ordem NULLS LAST, ep.nome`;
      }
      return rows.map((r) => ({
        ponto_id: r.ponto_id,
        nome: r.nome,
        papel: papelDoPonto(r.papel, r.nome),
        valor: valorDoBit(r.valor_raw, r.invertido),
        updated_at: r.updated_at ?? null,
      }));
    } catch (e) {
      new Logger(IoTService.name).warn(`[scs-bundle] status_pontos indisponível: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Habilita/configura o SCS de um elemento do unifilar (ex.: disjuntor). Grava as
   * colunas de DECLARAÇÃO (`equipamentos.scs`/`scs_comando`/`scs_status`/`scs_medicao`)
   * — são colunas SQL-cruas (fora do schema Prisma), por isso `$executeRaw`. É o que
   * liga os blocos do sheet e coloca o DJ na lista de elementos SCS da TON. Escopado.
   */
  async setDisjuntorScs(
    disjuntorId: string,
    cfg: { scs?: boolean; scs_comando?: boolean; scs_status?: boolean; scs_medicao?: string },
    user?: ScopedUser,
  ) {
    const id = (disjuntorId ?? '').trim();
    if (!id) throw new NotFoundException('Equipamento não informado');
    const exists = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT TRIM(id) AS id FROM equipamentos WHERE TRIM(id) = ${id} AND deleted_at IS NULL LIMIT 1`;
    if (!exists[0]) throw new NotFoundException('Equipamento não encontrado');
    if (user) await this.scopeService.assertEntityInScope('equipamento', id, user);
    // Desligar o SCS zera comando/status/medição (não deixa órfão declarado sem SCS).
    const on = cfg.scs === true;
    const cmd = on ? cfg.scs_comando === true : false;
    const sts = on ? cfg.scs_status === true : false;
    const med = on && ['pm', 'ied'].includes(String(cfg.scs_medicao)) ? String(cfg.scs_medicao) : 'nenhuma';
    await this.prisma.$executeRaw`
      UPDATE equipamentos
      SET scs = ${on}, scs_comando = ${cmd}, scs_status = ${sts}, scs_medicao = ${med}
      WHERE TRIM(id) = ${id}`;
    return { scs: on, scs_comando: cmd, scs_status: sts, scs_medicao: med };
  }

  /**
   * "Configurações SCS" da TON: lista os dispositivos conectados à TON no diagrama
   * IoT + a associação atual de cada um a um elemento do unifilar com SCS habilitado.
   * v1 foca no PM (associação por `props.disjuntor_equipamento_id`, que o sheet do DJ
   * consome na Medição). Escopado por dono (unidade da TON).
   */
  async tonScsConfig(tonEquipId: string, user?: ScopedUser) {
    const id = (tonEquipId ?? '').trim();
    if (!id) return { devices: [], elementos_scs: [] };
    const tonRows = await this.prisma.$queryRaw<Array<{ comp_id: string; projeto_id: string; unidade_id: string | null }>>`
      SELECT TRIM(c.id) AS comp_id, TRIM(c.projeto_id) AS projeto_id, TRIM(e.unidade_id) AS unidade_id
      FROM iot_componentes c
      LEFT JOIN equipamentos e ON TRIM(e.id) = COALESCE(NULLIF(TRIM(c.equipamento_id), ''), c.props->>'equipamento_id')
      WHERE (TRIM(c.equipamento_id) = ${id} OR c.props->>'equipamento_id' = ${id}) AND c.tipo LIKE 'ton%'
      LIMIT 1`;
    const ton = tonRows[0];
    if (!ton) return { devices: [], elementos_scs: [] };
    if (user && ton.unidade_id) await this.scopeService.assertEntityInScope('unidade', ton.unidade_id, user);
    const devices = await this.prisma.$queryRaw<Array<{ comp_id: string; tipo: string; nome: string; equipamento_id: string | null; assoc_dj_id: string | null; pontos_override: any }>>`
      SELECT TRIM(d.id) AS comp_id,
             CASE WHEN d.tipo = 'medidor_comum' AND x.estilo = 'ssu' THEN 'medidor_ssu' ELSE d.tipo END AS tipo,
             COALESCE(d.props->>'name', '') AS nome,
             COALESCE(NULLIF(TRIM(d.equipamento_id), ''), d.props->>'equipamento_id') AS equipamento_id,
             NULLIF(TRIM(d.props->>'disjuntor_equipamento_id'), '') AS assoc_dj_id,
             d.props->'pontos_override' AS pontos_override
      FROM iot_conexoes x
      JOIN iot_componentes d ON TRIM(d.id) = CASE WHEN TRIM(x.from_comp_id) = ${ton.comp_id} THEN TRIM(x.to_comp_id) ELSE TRIM(x.from_comp_id) END
      WHERE TRIM(x.projeto_id) = ${ton.projeto_id}
        AND (TRIM(x.from_comp_id) = ${ton.comp_id} OR TRIM(x.to_comp_id) = ${ton.comp_id})
        AND d.tipo IN ('inversor', 'power_meter', 'medidor_comum', 'medidor_ssu', 'rele_protecao')`;
    const elementos = ton.unidade_id
      ? await this.prisma.$queryRaw<Array<{ id: string; nome: string }>>`
          SELECT TRIM(id) AS id, TRIM(nome) AS nome FROM equipamentos
          WHERE scs = true AND TRIM(unidade_id) = ${ton.unidade_id} AND deleted_at IS NULL ORDER BY nome`
      : [];
    const elMap = new Map(elementos.map((e) => [e.id, e.nome]));

    // Correspondência de pontos (título ↔ campo JSON) do catálogo: vive na FAMÍLIA
    // (iot_device_tipos.pontos = {ai,bi,bo}). node-type do diagrama → família.
    // ai = medições (Tensão Fase A↔Va), bi = estados, bo = comandos. json cai no id
    // quando o catálogo não define (ex.: relé — só tem label). Editável = lapidação.
    const NODE_FAMILIA: Record<string, string> = {
      power_meter: 'medidor_energia', medidor_comum: 'medidor_energia',
      medidor_ssu: 'gateway_medidor',   // pontos phf/phr/qh*/sts (mesmos do A-966)
      inversor: 'inversor_solar', rele_protecao: 'rele_protecao',
    };
    const familias = [...new Set(devices.map((d) => NODE_FAMILIA[d.tipo]).filter(Boolean))];
    const tipoRows = familias.length
      ? await this.prisma.iot_device_tipos.findMany({ where: { codigo: { in: familias } }, select: { codigo: true, pontos: true } })
      : [];
    // json_default = do catálogo (cai no id quando vazio); json = efetivo (override por-equip vence).
    const pick = (arr: any): Array<{ id: string; label: string; json_default: string }> =>
      (Array.isArray(arr) ? arr : []).map((p: any) => ({ id: p?.id ?? '', label: p?.label ?? p?.id ?? '', json_default: (p?.json && String(p.json).trim()) || p?.id || '' }));
    const pontosPorFamilia = new Map<string, { ai: any[]; bi: any[]; bo: any[] }>();
    for (const t of tipoRows) {
      const pt = (t.pontos as any) ?? {};
      pontosPorFamilia.set(t.codigo, { ai: pick(pt.ai), bi: pick(pt.bi), bo: pick(pt.bo) });
    }

    return {
      devices: devices.map((d) => {
        const base = pontosPorFamilia.get(NODE_FAMILIA[d.tipo]) ?? { ai: [], bi: [], bo: [] };
        const ov = (d.pontos_override && typeof d.pontos_override === 'object') ? d.pontos_override : {};
        const applyOv = (arr: any[]) => arr.map((p) => ({ ...p, json: (ov[p.id] != null && String(ov[p.id]).trim()) ? String(ov[p.id]).trim() : p.json_default }));
        return {
          comp_id: d.comp_id, tipo: d.tipo, nome: d.nome, equipamento_id: d.equipamento_id,
          associado: d.assoc_dj_id ? { equipamento_id: d.assoc_dj_id, nome: elMap.get(d.assoc_dj_id) ?? null } : null,
          pontos: { ai: applyOv(base.ai), bi: applyOv(base.bi), bo: applyOv(base.bo) },
        };
      }),
      elementos_scs: elementos,
    };
  }

  /**
   * Elementos do unifilar (da unidade desta TON) que DECLARARAM comando/status/
   * medição, com seus pontos lógicos. É a lista que as telas de vínculo percorrem:
   * o cadastro diz O QUE o elemento tem; aqui se escolhe DE ONDE vem cada dado.
   * Escopado por dono (unidade da TON).
   */
  async elementosScs(tonEquipId: string, user?: ScopedUser) {
    const id = (tonEquipId ?? '').trim();
    if (!id) return { unidade_id: null, elementos: [] };

    const tonRows = await this.prisma.$queryRaw<Array<{ unidade_id: string | null }>>`
      SELECT TRIM(unidade_id) AS unidade_id FROM equipamentos
      WHERE TRIM(id) = ${id} AND deleted_at IS NULL LIMIT 1`;
    const unidadeId = tonRows[0]?.unidade_id ?? null;
    if (!unidadeId) return { unidade_id: null, elementos: [] };
    if (user) await this.scopeService.assertEntityInScope('unidade', unidadeId, user);

    const elementos = await this.prisma.$queryRaw<Array<{
      equipamento_id: string; tag: string | null; nome: string | null;
      scs_comando: boolean | null; scs_status: boolean | null; scs_medicao: string | null;
    }>>`
      SELECT TRIM(id) AS equipamento_id, tag, nome, scs_comando, scs_status, scs_medicao
      FROM equipamentos
      WHERE scs = true AND TRIM(unidade_id) = ${unidadeId} AND deleted_at IS NULL
      ORDER BY COALESCE(NULLIF(TRIM(tag), ''), nome)`;
    if (!elementos.length) return { unidade_id: unidadeId, elementos: [] };

    const pontos = await this.prisma.equipamento_pontos.findMany({
      where: { equipamento_id: { in: elementos.map((e) => e.equipamento_id) }, deleted_at: null, ativo: true },
      select: { id: true, equipamento_id: true, tipo: true, nome: true },
      orderBy: [{ ordem: 'asc' }, { nome: 'asc' }],
    });
    const porEquip = new Map<string, Array<{ id: string; tipo: string; nome: string }>>();
    for (const p of pontos) {
      const k = p.equipamento_id.trim();
      if (!porEquip.has(k)) porEquip.set(k, []);
      porEquip.get(k)!.push({ id: p.id.trim(), tipo: p.tipo, nome: p.nome.trim() });
    }

    return {
      unidade_id: unidadeId,
      elementos: elementos.map((e) => ({
        equipamento_id: e.equipamento_id,
        rotulo: e.tag?.trim() || e.nome?.trim() || e.equipamento_id,
        scs_comando: !!e.scs_comando,
        scs_status: !!e.scs_status,
        scs_medicao: e.scs_medicao ?? 'nenhuma',
        pontos: porEquip.get(e.equipamento_id) ?? [],
      })),
    };
  }

  /**
   * Elementos com SCS de uma UNIDADE (não de uma TON) + a última telemetria de cada um.
   * Alimenta os cards-ícone da Visão Geral (equipamentos do unifilar com SCS habilitado).
   * Escopado por dono (cliente só vê a própria usina).
   */
  async elementosScsVisaoGeral(unidadeId: string, user?: ScopedUser) {
    const uid = (unidadeId ?? '').trim();
    if (!uid) return { unidade_id: null, elementos: [] };
    if (user) await this.scopeService.assertEntityInScope('unidade', uid, user);

    const elementos = await this.prisma.$queryRaw<Array<{
      equipamento_id: string; tag: string | null; nome: string | null;
      scs_comando: boolean | null; scs_status: boolean | null; scs_medicao: string | null;
      tipo: string | null;
    }>>`
      SELECT TRIM(e.id) AS equipamento_id, e.tag, e.nome, e.scs_comando, e.scs_status, e.scs_medicao,
             te.nome AS tipo
      FROM equipamentos e
      LEFT JOIN tipos_equipamentos te ON TRIM(te.id) = TRIM(e.tipo_equipamento_id)
      WHERE e.scs = true AND TRIM(e.unidade_id) = ${uid} AND e.deleted_at IS NULL
      ORDER BY COALESCE(NULLIF(TRIM(e.tag), ''), e.nome)`;
    if (!elementos.length) return { unidade_id: uid, elementos: [] };

    const ids = elementos.map((e) => e.equipamento_id);
    const dados = await this.prisma.$queryRaw<Array<{ eid: string; dados: any; created_at: Date }>>`
      SELECT DISTINCT ON (TRIM(ed.equipamento_id)) TRIM(ed.equipamento_id) AS eid, ed.dados, ed.created_at
      FROM equipamentos_dados ed
      WHERE TRIM(ed.equipamento_id) IN (${Prisma.join(ids)})
      ORDER BY TRIM(ed.equipamento_id), ed.created_at DESC`;
    const porId = new Map(dados.map((d) => [d.eid, d]));

    return {
      unidade_id: uid,
      elementos: elementos.map((e) => {
        const d = porId.get(e.equipamento_id);
        return {
          equipamento_id: e.equipamento_id,
          rotulo: e.tag?.trim() || e.nome?.trim() || e.equipamento_id,
          tipo: e.tipo ?? null,
          comando: !!e.scs_comando,
          status: !!e.scs_status,
          medicao: !!(e.scs_medicao && e.scs_medicao !== 'nenhuma'),
          dados: d?.dados ?? null,
          ts: d?.created_at ?? null,
        };
      }),
    };
  }

  /**
   * Salva a correspondência editada (título ↔ campo JSON) de um device da TON.
   * `overrides` = { <ponto_id>: <json_key> } — só os que DIFEREM do catálogo (o front
   * já filtra). Substitui o mapa inteiro em `iot_componentes.props.pontos_override`
   * (mandar {} limpa tudo, voltando ao catálogo). Escopado por dono.
   */
  async savePontosOverride(compId: string, overrides: Record<string, string>, user?: ScopedUser) {
    const cid = (compId ?? '').trim();
    if (!cid) throw new NotFoundException('Componente não informado');
    const rows = await this.prisma.$queryRaw<Array<{ props: any; unidade_id: string | null }>>`
      SELECT c.props, TRIM(e.unidade_id) AS unidade_id
      FROM iot_componentes c
      LEFT JOIN equipamentos e ON TRIM(e.id) = COALESCE(NULLIF(TRIM(c.equipamento_id), ''), c.props->>'equipamento_id')
      WHERE TRIM(c.id) = ${cid} LIMIT 1`;
    const row = rows[0];
    if (!row) throw new NotFoundException('Componente não encontrado');
    if (user && row.unidade_id) await this.scopeService.assertEntityInScope('unidade', row.unidade_id, user);
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(overrides ?? {})) {
      if (k && v != null && String(v).trim()) clean[k] = String(v).trim();
    }
    const props = (row.props ?? {}) as Record<string, unknown>;
    if (Object.keys(clean).length) props.pontos_override = clean;
    else delete props.pontos_override;
    await this.prisma.$executeRaw`UPDATE iot_componentes SET props = ${JSON.stringify(props)}::jsonb WHERE TRIM(id) = ${cid}`;
    return { ok: true, count: Object.keys(clean).length };
  }

  /** Associa (ou desassocia, elementoEquipId=null) um device da TON a um elemento SCS do unifilar. */
  async associarScs(compId: string, elementoEquipId: string | null, user?: ScopedUser) {
    const cid = (compId ?? '').trim();
    const rows = await this.prisma.$queryRaw<Array<{ props: any; unidade_id: string | null }>>`
      SELECT c.props, TRIM(e.unidade_id) AS unidade_id
      FROM iot_componentes c
      LEFT JOIN equipamentos e ON TRIM(e.id) = COALESCE(NULLIF(TRIM(c.equipamento_id), ''), c.props->>'equipamento_id')
      WHERE TRIM(c.id) = ${cid} LIMIT 1`;
    const row = rows[0];
    if (!row) throw new NotFoundException('Componente não encontrado');
    if (user && row.unidade_id) await this.scopeService.assertEntityInScope('unidade', row.unidade_id, user);
    const props = (row.props ?? {}) as Record<string, unknown>;
    if (elementoEquipId && elementoEquipId.trim()) props.disjuntor_equipamento_id = elementoEquipId.trim();
    else delete props.disjuntor_equipamento_id;
    await this.prisma.$executeRaw`UPDATE iot_componentes SET props = ${JSON.stringify(props)}::jsonb WHERE TRIM(id) = ${cid}`;
    return { ok: true };
  }

  /**
   * Resolve o Power Meter (só-IoT) associado a um DISJUNTOR do unifilar. O link fica em
   * `iot_componentes.props.disjuntor_equipamento_id` (gravado pelo modal de props do PM).
   * Retorna o `equipamento_id` + nome do PM pra o unifilar abrir o PowerMeterModal ao
   * clicar no disjuntor associado. null se o disjuntor não tem PM associado.
   */
  async powerMeterByDisjuntor(
    disjuntorEquipId: string,
  ): Promise<{ equipamento_id: string; nome: string | null } | null> {
    const id = (disjuntorEquipId ?? '').trim();
    if (!id) return null;
    const rows = await this.prisma.$queryRaw<
      Array<{ equipamento_id: string; nome: string | null }>
    >`
      SELECT c.props->>'equipamento_id' AS equipamento_id,
             c.props->>'name'           AS nome
      FROM iot_componentes c
      WHERE c.props->>'disjuntor_equipamento_id' = ${id}
        AND COALESCE(c.props->>'equipamento_id', '') <> ''
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  /**
   * Fonte do status ABERTO/FECHADO de um disjuntor do unifilar.
   *
   * Quem lê os contatos auxiliares (52a/52b) do DJ é o RELÉ: ele publica os
   * sinais do catálogo (`dj_aberto`/`dj_fechado`) na SUA propria telemetria. O
   * vínculo relé→disjuntor vive no `io_config.bi` do componente do relé
   * (`{ <sinal>: { equipamento_id: <disjuntor>, ponto_id } }`), que hoje só
   * existe como JSON. Este lookup inverte esse mapa: dado o disjuntor, diz de
   * QUEM o front deve assinar a telemetria ao vivo e QUAIS campos ler.
   *
   * ⚠️ RBAC: o disjuntor pertence a uma unidade — escopado por dono.
   */
  async statusFonteDoDisjuntor(
    disjuntorEquipId: string,
    user?: ScopedUser,
  ): Promise<{
    rele_equipamento_id: string;
    rele_nome: string | null;
    campo_aberto: string | null;
    campo_fechado: string | null;
  } | null> {
    const id = (disjuntorEquipId ?? '').trim();
    if (!id) return null;

    if (user) {
      const u = await this.prisma.$queryRaw<Array<{ unidade_id: string | null }>>`
        SELECT TRIM(unidade_id) AS unidade_id FROM equipamentos WHERE TRIM(id) = ${id} LIMIT 1
      `;
      const unidadeId = u[0]?.unidade_id?.trim();
      if (unidadeId) {
        await this.scopeService.assertEntityInScope('unidade', unidadeId, user);
      }
    }

    // ids sao char(26): TRIM dos dois lados (o io_config antigo gravava com padding).
    const rows = await this.prisma.$queryRaw<
      Array<{ rele_equipamento_id: string; rele_nome: string | null; campo: string }>
    >`
      SELECT COALESCE(NULLIF(TRIM(c.equipamento_id), ''), c.props->>'equipamento_id') AS rele_equipamento_id,
             c.props->>'name' AS rele_nome,
             kv.key           AS campo
      FROM iot_componentes c,
           jsonb_each(COALESCE(c.props->'io_config'->'bi', '{}'::jsonb)) AS kv
      WHERE TRIM(COALESCE(kv.value->>'equipamento_id', '')) = ${id}
        AND COALESCE(NULLIF(TRIM(c.equipamento_id), ''), c.props->>'equipamento_id', '') <> ''
    `;
    const campos = rows.map((r) => r.campo);
    const antigo = rows.length === 0 ? null : {
      rele_equipamento_id: rows[0].rele_equipamento_id,
      rele_nome: rows[0].rele_nome,
      campo_aberto: campos.find((c) => /aberto/i.test(c)) ?? null,
      campo_fechado: campos.find((c) => /fechado/i.test(c)) ?? null,
    };

    // Fase 5 (FLIP): iot_vinculos é a fonte primária; o io_config.bi (antigo) vira
    // FALLBACK quando o espelho não tem, e loga divergência. `rele_nome` vem do
    // antigo (o vínculo guarda o equipamento, não o props.name). Reversível.
    const v = await this.mirror.lookupStatusFonte(id);
    if (v && antigo && (v.rele_equipamento_id !== antigo.rele_equipamento_id.trim()
        || v.campo_aberto !== antigo.campo_aberto || v.campo_fechado !== antigo.campo_fechado)) {
      this.mirror.divergiu('flip/statusFonteDoDisjuntor', antigo, v);
    }
    if (v) {
      return {
        rele_equipamento_id: v.rele_equipamento_id,
        rele_nome: antigo?.rele_nome ?? null,
        campo_aberto: v.campo_aberto,
        campo_fechado: v.campo_fechado,
      };
    }
    return antigo;
  }

  async createProjeto(unidadeId: string, nome: string, user?: ScopedUser): Promise<IotProjetoRow> {
    if (user) await this.scopeService.assertEntityInScope('unidade', unidadeId.trim(), user);
    const created = await this.prisma.iot_projetos.create({
      data: {
        id: this.generateId(),
        unidade_id: unidadeId.trim(),
        nome,
        diagrama: EMPTY_DIAGRAMA as unknown as Prisma.InputJsonValue,
      },
      select: PROJETO_SELECT,
    });
    return this.toProjetoRow(created);
  }

  async updateProjeto(
    id: string,
    data: { nome?: string; diagrama?: IotDiagrama },
    user?: ScopedUser,
  ): Promise<IotProjetoRow> {
    const trimmedId = id.trim();
    if (user) {
      const unidadeId = await this.unidadeIdDoProjeto(trimmedId);
      if (unidadeId) await this.scopeService.assertEntityInScope('unidade', unidadeId, user);
    }

    const _projetoRow = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.iot_projetos.findFirst({
        where: { id: trimmedId, deleted_at: null },
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundException(`Projeto IoT ${trimmedId} nao encontrado`);
      }

      const updateData: Prisma.iot_projetosUpdateInput = {};
      if (data.nome !== undefined) updateData.nome = data.nome;
      if (data.diagrama !== undefined) {
        // TON e' dominio IoT: auto-cria/vincula o equipamento de cada TON (idempotente)
        // e carimba equipamento_id no JSON ANTES de salvar (unifilar/OTA/syncRelational usam).
        await this.ensureTonEquipamentos(tx, trimmedId, data.diagrama);
        // Devices Modbus (rele/medidor/inversor) tambem viram equipamento sozinhos —
        // depois da TON, pois o topico deles deriva do topico dela.
        await this.ensureDeviceEquipamentos(tx, trimmedId, data.diagrama);
        // Bomba de combustivel: AUTO-CRIA/associa o equipamento (igual TON/devices),
        // liga automacao e cria os pontos canonicos, pra ela aparecer no Configurar
        // BOs/BIs da TON (mecanismo IO padrao).
        await this.ensureBombaEquipamentos(tx, trimmedId, data.diagrama);
        // Carregador eletrico: mesmo padrao — auto-cria/associa + pontos + config.
        await this.ensureCarregadorEquipamentos(tx, trimmedId, data.diagrama);
        updateData.diagrama = data.diagrama as unknown as Prisma.InputJsonValue;
        updateData.view_pan_x = data.diagrama.pan?.x ?? 0;
        updateData.view_pan_y = data.diagrama.pan?.y ?? 0;
        updateData.view_zoom = data.diagrama.zoom ?? 1;
      }

      if (Object.keys(updateData).length > 0) {
        await tx.iot_projetos.update({
          where: { id: trimmedId },
          data: updateData,
        });
      }

      if (data.diagrama !== undefined) {
        await this.syncRelational(tx, trimmedId, data.diagrama);
      }

      const updated = await tx.iot_projetos.findFirst({
        where: { id: trimmedId, deleted_at: null },
        select: PROJETO_SELECT,
      });
      if (!updated) {
        throw new NotFoundException(
          `Projeto IoT ${trimmedId} desapareceu durante o update`,
        );
      }
      return this.toProjetoRow(updated);
    });

    // Fase 3 (dual-write): espelha os vínculos Modbus (io_config) do projeto para
    // iot_vinculos — DEPOIS do commit (mirror usa this.prisma, não a tx). Best-effort.
    void this.mirror.resyncProjetoModbus(trimmedId);
    return _projetoRow;
  }

  async deleteProjeto(id: string, user?: ScopedUser): Promise<void> {
    const trimmedId = id.trim();
    const existing = await this.prisma.iot_projetos.findFirst({
      where: { id: trimmedId, deleted_at: null },
      select: { id: true, unidade_id: true },
    });
    if (!existing) {
      throw new NotFoundException(`Projeto IoT ${trimmedId} nao encontrado`);
    }
    if (user) await this.scopeService.assertEntityInScope('unidade', existing.unidade_id.trim(), user);
    await this.prisma.iot_projetos.update({
      where: { id: trimmedId },
      data: { deleted_at: new Date() },
    });
  }

  /**
   * Auto-cria (ou re-vincula) o equipamento de cada TON do diagrama que ainda nao
   * tem equipamento_id valido, e CARIMBA o id em comp.props.equipamento_id (muta o
   * diagrama, salvo logo em seguida). TON e' dominio IoT — o equipamento e' criado
   * aqui automaticamente, nao pela tela de cadastro.
   *
   * Idempotente (roda a cada save): (1) se o comp ja tem equipamento_id valido, pula;
   * (2) senao, se existe um equipamento com o mesmo topico_mqtt, REUSA; (3) senao cria.
   */
  private async ensureTonEquipamentos(
    tx: Prisma.TransactionClient,
    projetoId: string,
    diagrama: IotDiagrama,
  ): Promise<void> {
    if (!Array.isArray(diagrama.components)) return;
    const tons = diagrama.components.filter((c) =>
      String((c as { type?: string }).type ?? '').toLowerCase().startsWith('ton'),
    );
    if (tons.length === 0) return;

    const proj = await tx.iot_projetos.findFirst({
      where: { id: projetoId },
      select: { unidade_id: true },
    });
    const unidadeId = proj?.unidade_id?.trim() || null;
    const tipoTon = await tx.tipos_equipamentos.findFirst({
      where: { nome: 'TON' },
      select: { id: true },
    });
    const tipoTonId = tipoTon?.id?.trim() || null;

    for (const comp of tons) {
      const props =
        ((comp as { props?: Record<string, unknown> }).props ?? {}) as Record<
          string,
          unknown
        >;
      const topico = String(props.mqtt_topic_base ?? '').trim();

      // (1) ja vinculado e valido? MANTEM o vinculo; so PROPAGA o topico se ele
      // mudou (usuario preencheu o Topico Base DEPOIS de ja ter o equipamento) —
      // e aí liga o MQTT. Sem isso, preencher o topico depois nunca chegava no ativo.
      const rawEquip = this.rawEquipamentoId(comp);
      if (rawEquip) {
        const ok = await tx.equipamentos.findFirst({
          where: { id: rawEquip, deleted_at: null },
          select: { id: true, topico_mqtt: true },
        });
        if (ok) {
          if (topico && (ok.topico_mqtt ?? '').trim() !== topico) {
            await tx.equipamentos.update({
              where: { id: ok.id },
              data: { topico_mqtt: topico, mqtt_habilitado: true },
            });
          }
          continue;
        }
      }

      const tipo = String((comp as { type?: string }).type ?? '').toLowerCase();
      // Capacidade por DADO, nunca igualdade exata de tipo (briefing TON-V2
      // §4.2: 'ton3v2'/'ton4v2' precisam entrar — lista solta quebra em silêncio).
      const automacao = tonCapsForTipo(tipo)?.comando ?? false;

      let equipId: string;
      // (2) reusa equipamento existente com este topico_mqtt (idempotencia forte).
      //     SO quando ha topico — senao `null` casaria com centenas de equipamentos
      //     sem topico e "reusaria" o ativo errado.
      const existente = topico
        ? await tx.equipamentos.findFirst({
            where: { topico_mqtt: topico, deleted_at: null },
            select: { id: true },
          })
        : null;
      if (existente) {
        equipId = existente.id.trim();
      } else {
        // (3) cria — MESMO SEM topico. A TON e' criada+associada ja no save, igual
        //     aos outros ativos (inversor/medidor via /rapido tambem nascem sem
        //     topico). O Topico Base pode ser preenchido depois: o passo (1) acima
        //     propaga pro ativo no proximo save. Comando/OTA/telemetria so
        //     funcionam com topico (por isso mqtt_habilitado segue o topico), mas a
        //     TON ja aparece ASSOCIADA no dropdown — que era a dor do usuario.
        //     topico_mqtt e' nullable e tem so INDEX (nao unique) — null e' seguro.
        const nome =
          String(props.name ?? props.ota_hostname ?? tipo.toUpperCase()).trim() || 'TON';
        const novo = await tx.equipamentos.create({
          data: {
            id: this.generateId(),
            nome,
            classificacao: 'UC',
            criticidade: '3',
            tipo_equipamento: tipo.toUpperCase(),
            mqtt_habilitado: !!topico,
            automacao,
            topico_mqtt: topico || null,
            ...(unidadeId ? { unidade_id: unidadeId } : {}),
            ...(tipoTonId ? { tipo_equipamento_id: tipoTonId } : {}),
          },
          select: { id: true },
        });
        equipId = novo.id.trim();
      }

      // carimba no JSON (o updateProjeto salva `data.diagrama` logo depois).
      (comp as { props?: Record<string, unknown> }).props = {
        ...props,
        equipamento_id: equipId,
      };
    }
  }

  /**
   * Bomba de combustível: prepara o equipamento da bomba pro mecanismo PADRÃO de
   * IO da TON. A bomba NÃO guarda BO/BI nas props — quem mapeia relé/entrada é a
   * TON (modal da TON → Configurar BOs/BIs → ton_bo/ton_bi), e esses modais só
   * listam equipamentos com `automacao=true` e escolhem entre os PONTOS dele.
   * Então aqui, a cada save (idempotente):
   *   (1) liga `automacao` no equipamento da bomba;
   *   (2) cria os pontos canônicos se faltarem — comando Ligar/Desligar/Solenoide,
   *       status Cartão/Emergência, medição Nível.
   * Os NOMES casam com a resolução por papel do gerador de firmware
   * (`boRole`/`biRole` em iot-diagram.tsx), que lê ton_bo/ton_bi e injeta os
   * números físicos na geração. O nível (AI) não entra aqui: não há `ton_ai`.
   */
  private async ensureBombaEquipamentos(
    tx: Prisma.TransactionClient,
    projetoId: string,
    diagrama: IotDiagrama,
  ): Promise<void> {
    if (!Array.isArray(diagrama.components)) return;
    const comps = diagrama.components as Array<Record<string, any>>;
    const bombas = comps.filter(
      (c) => String(c?.type ?? '').toLowerCase() === 'bomba',
    );
    if (bombas.length === 0) return;

    const proj = await tx.iot_projetos.findFirst({
      where: { id: projetoId },
      select: { unidade_id: true },
    });
    const unidadeId = proj?.unidade_id?.trim() || null;
    // Tipo do catálogo (codigo BOMBA_COMBUSTIVEL) — mesma abordagem do ensureTon
    // (busca por nome='TON'). Fallback pela string se o rel não existir.
    const tipoBomba = await tx.tipos_equipamentos.findFirst({
      where: { codigo: 'BOMBA_COMBUSTIVEL' },
      select: { id: true },
    });
    const tipoBombaId = tipoBomba?.id?.trim() || null;

    // Ids já usados por QUALQUER componente do diagrama — pra não reusar um ativo
    // que outro nó já reivindicou (nem outra bomba irmã).
    const jaReferenciados = new Set<string>(
      comps
        .map((c) =>
          this.rawEquipamentoId(c as unknown as IotDiagramaComponent) ?? '',
        )
        .filter(Boolean),
    );

    // Pontos vêm do CATÁLOGO (iot_device_tipos.pontos da bomba) — configurável por
    // DADO, sem deploy: bo→comando, bi→status, ai→medicao. Adicionar/mudar um papel
    // = editar o catálogo. Fallback pro conjunto canônico se o catálogo vier vazio.
    // Os NOMES batem com a resolução por papel do gerador (boRole/biRole/aiRole em
    // iot-diagram.tsx): "Ligar"→liga (pulso), "Permissão"→permissao (mantida),
    // "Solenoide"→solenoide, "Sinaleiro"→sinaleiro; "Contator"→contator (aux do K1),
    // "Auto/Manual"→automatico, "Emergência"→estop, "Bico"→bico, "Boia mínimo"→boia_min,
    // "Boia alta"→boia_alta; "Nível"→nivel. Doc: "Posto de Combustível — Como funciona".
    type PontoDef = { tipo: string; nome: string; unidade: string | null; ordem: number };
    const FALLBACK_PONTOS: PontoDef[] = [
      { tipo: 'comando', nome: 'Ligar', unidade: null, ordem: 1 },
      { tipo: 'comando', nome: 'Permissão', unidade: null, ordem: 2 },
      { tipo: 'comando', nome: 'Solenoide', unidade: null, ordem: 3 },
      { tipo: 'comando', nome: 'Sinaleiro', unidade: null, ordem: 4 },
      { tipo: 'status', nome: 'Contator', unidade: null, ordem: 1 },
      { tipo: 'status', nome: 'Auto/Manual', unidade: null, ordem: 2 },
      { tipo: 'status', nome: 'Emergência', unidade: null, ordem: 3 },
      { tipo: 'status', nome: 'Bico', unidade: null, ordem: 4 },
      { tipo: 'status', nome: 'Boia mínimo', unidade: null, ordem: 5 },
      { tipo: 'status', nome: 'Boia alta', unidade: null, ordem: 6 },
      { tipo: 'medicao', nome: 'Nível', unidade: '%', ordem: 1 },
    ];
    const catalogo = await tx.iot_device_tipos.findFirst({
      where: { codigo: 'bomba_combustivel' },
      select: { pontos: true },
    });
    const catPontos = (catalogo?.pontos ?? null) as {
      bo?: Array<{ id?: string; label?: string; unit?: string }>;
      bi?: Array<{ id?: string; label?: string; unit?: string }>;
      ai?: Array<{ id?: string; label?: string; unit?: string }>;
    } | null;
    const mapCat = (
      arr: Array<{ id?: string; label?: string; unit?: string }> | undefined,
      tipo: string,
      unidadeDefault: string | null,
    ): PontoDef[] =>
      (arr ?? [])
        .map((p, i) => ({
          tipo,
          nome: String(p.label ?? p.id ?? '').trim(),
          unidade: p.unit ?? unidadeDefault,
          ordem: i + 1,
        }))
        .filter((p) => !!p.nome);
    const doCatalogo: PontoDef[] = [
      ...mapCat(catPontos?.bo, 'comando', null),
      ...mapCat(catPontos?.bi, 'status', null),
      ...mapCat(catPontos?.ai, 'medicao', '%'),
    ];
    const PONTOS: PontoDef[] = doCatalogo.length > 0 ? doCatalogo : FALLBACK_PONTOS;

    for (const comp of bombas) {
      const props = (comp.props ?? {}) as Record<string, unknown>;

      // (1) já vinculado e válido? mantém.
      let equipId = this.rawEquipamentoId(
        comp as unknown as IotDiagramaComponent,
      );
      if (equipId) {
        const ok = await tx.equipamentos.findFirst({
          where: { id: equipId, deleted_at: null },
          select: { id: true },
        });
        if (!ok) equipId = null;
      }

      // (2) não vinculado → REUSA uma bomba existente da unidade ainda não
      // reivindicada por outro nó; senão CRIA (igual aos outros ativos: nasce no
      // save, sem tópico — a telemetria da bomba sai pelo tópico da TON).
      if (!equipId) {
        const reusavel =
          unidadeId
            ? await tx.equipamentos.findFirst({
                where: {
                  unidade_id: unidadeId,
                  deleted_at: null,
                  id: { notIn: Array.from(jaReferenciados) },
                  ...(tipoBombaId
                    ? { tipo_equipamento_id: tipoBombaId }
                    : { tipo_equipamento: 'BOMBA_COMBUSTIVEL' }),
                },
                select: { id: true },
                orderBy: { created_at: 'asc' },
              })
            : null;
        if (reusavel) {
          equipId = reusavel.id.trim();
        } else {
          const nome =
            String(props.name ?? 'Bomba de Combustível').trim() ||
            'Bomba de Combustível';
          const novo = await tx.equipamentos.create({
            data: {
              id: this.generateId(),
              nome,
              classificacao: 'UC',
              criticidade: '3',
              tipo_equipamento: 'BOMBA_COMBUSTIVEL',
              mqtt_habilitado: false, // telemetria sai pelo tópico da TON, não daqui
              automacao: true, // obrigatória: Configurar BOs/BIs só lista automação
              ...(unidadeId ? { unidade_id: unidadeId } : {}),
              ...(tipoBombaId ? { tipo_equipamento_id: tipoBombaId } : {}),
            },
            select: { id: true },
          });
          equipId = novo.id.trim();
        }
        jaReferenciados.add(equipId);
        // carimba no JSON (salvo logo depois pelo updateProjeto).
        (comp as { props?: Record<string, unknown> }).props = {
          ...props,
          equipamento_id: equipId,
        };
      }

      // (3) garante automação ligada (Configurar BOs/BIs exige) + pontos canônicos.
      const eq = await tx.equipamentos.findFirst({
        where: { id: equipId, deleted_at: null },
        select: { id: true, automacao: true },
      });
      if (!eq) continue;
      if (!eq.automacao) {
        await tx.equipamentos.update({
          where: { id: equipId },
          data: { automacao: true },
        });
      }

      for (const pt of PONTOS) {
        // UNIQUE (equipamento_id, nome) inclui soft-deletados — casa por nome e
        // reativa em vez de recriar (evita conflito no unique).
        const ja = await tx.equipamento_pontos.findFirst({
          where: { equipamento_id: equipId, nome: pt.nome },
          select: { id: true, ativo: true, deleted_at: true },
        });
        if (ja) {
          if (!ja.ativo || ja.deleted_at) {
            await tx.equipamento_pontos.update({
              where: { id: ja.id },
              data: {
                tipo: pt.tipo,
                unidade: pt.unidade,
                ordem: pt.ordem,
                ativo: true,
                deleted_at: null,
              },
            });
          }
          continue;
        }
        await tx.equipamento_pontos.create({
          data: {
            equipamento_id: equipId,
            tipo: pt.tipo,
            nome: pt.nome,
            unidade: pt.unidade,
            ordem: pt.ordem,
            ativo: true,
          },
        });
      }

      // (4) Espelha a CONFIG da bomba na tabela bomba_combustivel_config. A fonte da
      // verdade passou a ser as props do IoT (a aba "Config" do unifilar foi removida);
      // listarBombas e a telemetria consomem essa tabela. Sem UNIQUE em equipamento_id
      // (só PK em id) → checa-existência + UPDATE/INSERT (mesmo padrão do service).
      const nivelMin = Number(props.nivel_min_pct ?? 5) || 5;
      const timeoutS = Math.trunc(Number(props.timeout_s ?? 600)) || 600;
      const kFator = Number(props.k_fator ?? 450) || 450;
      const modoLeitor =
        String(props.modo_leitor ?? 'rs485').trim().slice(0, 12) || 'rs485';
      const exigirMat = !(props.exigir_matricula === false || props.exigir_matricula === 'false');
      const matLivre = props.matricula_livre === true || props.matricula_livre === 'true';
      const temCfg =
        (
          await tx.$queryRaw<Array<{ x: number }>>`
            SELECT 1 AS x FROM bomba_combustivel_config
            WHERE TRIM(equipamento_id) = ${equipId} LIMIT 1`
        ).length > 0;
      if (temCfg) {
        await tx.$executeRaw`
          UPDATE bomba_combustivel_config
          SET nivel_min_pct = ${nivelMin}, timeout_s = ${timeoutS},
              k_fator = ${kFator}, rfid_mode = ${modoLeitor},
              exigir_matricula = ${exigirMat}, matricula_livre = ${matLivre}, updated_at = now()
          WHERE TRIM(equipamento_id) = ${equipId}`;
      } else {
        await tx.$executeRaw`
          INSERT INTO bomba_combustivel_config
            (id, equipamento_id, nivel_min_pct, timeout_s, k_fator, rfid_mode, exigir_matricula, matricula_livre)
          VALUES (${this.generateId()}, ${equipId}, ${nivelMin}, ${timeoutS}, ${kFator}, ${modoLeitor}, ${exigirMat}, ${matLivre})`;
      }
    }
  }

  /**
   * Carregador Elétrico: espelha a bomba. Auto-cria/reusa o equipamento, liga
   * automacao, semeia os pontos do catálogo (bo Habilitar/Desabilitar, bi Conectado)
   * pro Configurar BOs/BIs da TON, e sincroniza carregador_config das props do IoT
   * (fonte kWh, tarifa, potência, tópico). Idempotente (roda a cada save).
   */
  private async ensureCarregadorEquipamentos(
    tx: Prisma.TransactionClient,
    projetoId: string,
    diagrama: IotDiagrama,
  ): Promise<void> {
    if (!Array.isArray(diagrama.components)) return;
    const comps = diagrama.components as Array<Record<string, any>>;
    const cars = comps.filter(
      (c) => String(c?.type ?? '').toLowerCase() === 'carregador',
    );
    if (cars.length === 0) return;

    const proj = await tx.iot_projetos.findFirst({
      where: { id: projetoId },
      select: { unidade_id: true },
    });
    const unidadeId = proj?.unidade_id?.trim() || null;
    const tipoCar = await tx.tipos_equipamentos.findFirst({
      where: { codigo: 'CARREGADOR_ELETRICO' },
      select: { id: true },
    });
    const tipoCarId = tipoCar?.id?.trim() || null;

    const jaReferenciados = new Set<string>(
      comps
        .map((c) => this.rawEquipamentoId(c as unknown as IotDiagramaComponent) ?? '')
        .filter(Boolean),
    );

    type PontoDef = { tipo: string; nome: string; unidade: string | null; ordem: number };
    const FALLBACK: PontoDef[] = [
      { tipo: 'comando', nome: 'Habilitar', unidade: null, ordem: 1 },
      { tipo: 'comando', nome: 'Desabilitar', unidade: null, ordem: 2 },
      { tipo: 'status', nome: 'Conectado', unidade: null, ordem: 1 },
    ];
    const cat = await tx.iot_device_tipos.findFirst({
      where: { codigo: 'carregador_eletrico' },
      select: { pontos: true },
    });
    const cp = (cat?.pontos ?? null) as {
      bo?: Array<{ id?: string; label?: string; unit?: string }>;
      bi?: Array<{ id?: string; label?: string; unit?: string }>;
    } | null;
    const mapCat = (
      arr: Array<{ id?: string; label?: string; unit?: string }> | undefined,
      tipo: string,
    ): PontoDef[] =>
      (arr ?? [])
        .map((p, i) => ({ tipo, nome: String(p.label ?? p.id ?? '').trim(), unidade: p.unit ?? null, ordem: i + 1 }))
        .filter((p) => !!p.nome);
    const doCat: PontoDef[] = [...mapCat(cp?.bo, 'comando'), ...mapCat(cp?.bi, 'status')];
    const PONTOS: PontoDef[] = doCat.length > 0 ? doCat : FALLBACK;

    for (const comp of cars) {
      const props = (comp.props ?? {}) as Record<string, unknown>;
      let equipId = this.rawEquipamentoId(comp as unknown as IotDiagramaComponent);
      if (equipId) {
        const ok = await tx.equipamentos.findFirst({
          where: { id: equipId, deleted_at: null },
          select: { id: true },
        });
        if (!ok) equipId = null;
      }
      if (!equipId) {
        const reusavel = unidadeId
          ? await tx.equipamentos.findFirst({
              where: {
                unidade_id: unidadeId,
                deleted_at: null,
                id: { notIn: Array.from(jaReferenciados) },
                ...(tipoCarId
                  ? { tipo_equipamento_id: tipoCarId }
                  : { tipo_equipamento: 'CARREGADOR_ELETRICO' }),
              },
              select: { id: true },
              orderBy: { created_at: 'asc' },
            })
          : null;
        if (reusavel) {
          equipId = reusavel.id.trim();
        } else {
          const nome =
            String(props.name ?? 'Carregador Elétrico').trim() || 'Carregador Elétrico';
          const novo = await tx.equipamentos.create({
            data: {
              id: this.generateId(),
              nome,
              classificacao: 'UC',
              criticidade: '3',
              tipo_equipamento: 'CARREGADOR_ELETRICO',
              mqtt_habilitado: false,
              automacao: true,
              ...(unidadeId ? { unidade_id: unidadeId } : {}),
              ...(tipoCarId ? { tipo_equipamento_id: tipoCarId } : {}),
            },
            select: { id: true },
          });
          equipId = novo.id.trim();
        }
        jaReferenciados.add(equipId);
        (comp as { props?: Record<string, unknown> }).props = {
          ...props,
          equipamento_id: equipId,
        };
      }

      const eq = await tx.equipamentos.findFirst({
        where: { id: equipId, deleted_at: null },
        select: { id: true, automacao: true },
      });
      if (!eq) continue;
      if (!eq.automacao) {
        await tx.equipamentos.update({ where: { id: equipId }, data: { automacao: true } });
      }

      for (const pt of PONTOS) {
        const ja = await tx.equipamento_pontos.findFirst({
          where: { equipamento_id: equipId, nome: pt.nome },
          select: { id: true, ativo: true, deleted_at: true },
        });
        if (ja) {
          if (!ja.ativo || ja.deleted_at) {
            await tx.equipamento_pontos.update({
              where: { id: ja.id },
              data: { tipo: pt.tipo, unidade: pt.unidade, ordem: pt.ordem, ativo: true, deleted_at: null },
            });
          }
          continue;
        }
        await tx.equipamento_pontos.create({
          data: { equipamento_id: equipId, tipo: pt.tipo, nome: pt.nome, unidade: pt.unidade, ordem: pt.ordem, ativo: true },
        });
      }

      // Espelha config nas tabelas (fonte da verdade = props do IoT).
      const fonte =
        String(props.fonte_kwh ?? 'ton').trim() === 'carregador' ? 'carregador' : 'ton';
      const tarifaN = Number(props.tarifa_kwh);
      const tarifaV = Number.isFinite(tarifaN) ? tarifaN : null;
      const potN = Number(props.potencia_kw);
      const potV = Number.isFinite(potN) ? potN : null;
      const topico = String(props.topico_energia ?? '').trim() || null;
      const temCfg =
        (
          await tx.$queryRaw<Array<{ x: number }>>`
            SELECT 1 AS x FROM carregador_config WHERE TRIM(equipamento_id) = ${equipId} LIMIT 1`
        ).length > 0;
      if (temCfg) {
        await tx.$executeRaw`
          UPDATE carregador_config
          SET fonte_kwh = ${fonte}, tarifa_kwh = ${tarifaV}, potencia_kw = ${potV},
              topico_energia = ${topico}, updated_at = now()
          WHERE TRIM(equipamento_id) = ${equipId}`;
      } else {
        await tx.$executeRaw`
          INSERT INTO carregador_config (id, equipamento_id, fonte_kwh, tarifa_kwh, potencia_kw, topico_energia)
          VALUES (${this.generateId()}, ${equipId}, ${fonte}, ${tarifaV}, ${potV}, ${topico})`;
      }
    }
  }

  /**
   * Auto-cria (ou re-vincula) o equipamento de cada DEVICE Modbus do diagrama
   * (rele, medidor, inversor...) que ainda nao tem equipamento_id valido.
   *
   * POR QUE: um componente sem equipamento e' "so desenho" — a telemetria dele
   * nao tem onde pousar no banco e a tela nao tem de quem assinar (foi
   * exatamente o buraco que escondeu o status do disjuntor). Antes isso dependia
   * de um passo MANUAL (dialogo "associar") que dava pra pular em silencio. A TON
   * ja fazia automatico (ensureTonEquipamentos); aqui vale o mesmo pros devices.
   *
   * O topico e' derivado da TON que le o device (BFS nas conexoes do diagrama),
   * no MESMO formato que o firmware publica e que os devices existentes usam:
   *   `<ton.mqtt_topic_base>/<name>_<modbus_address>/data`
   *
   * Idempotente (roda a cada save): (1) equipamento_id valido -> pula;
   * (2) existe equipamento com o mesmo topico -> REUSA; (3) senao cria.
   */
  private async ensureDeviceEquipamentos(
    tx: Prisma.TransactionClient,
    projetoId: string,
    diagrama: IotDiagrama,
  ): Promise<void> {
    if (!Array.isArray(diagrama.components)) return;

    const isTon = (t: unknown) =>
      String(t ?? '')
        .toLowerCase()
        .startsWith('ton');
    const comps = diagrama.components as Array<Record<string, any>>;

    // Device Modbus = tem endereco Modbus e modelo do catalogo (nao e' TON).
    // Medidor SSU (NBR 14522, entrada SU+ da TON-V2) entra sempre: nao e' Modbus e o
    // modelo do catalogo e' opcional (o parser e' generico da norma).
    // Medidor Concessionária ligado DIRETO na TON v2 (cabo SSU) = mesmo papel do medidor_ssu.
    const ligadoPorSsu = new Set<string>();
    for (const cx of (diagrama.connections ?? []) as Array<any>) {
      if (String(cx?.style ?? '') !== 'ssu') continue;
      for (const id of [cx?.from?.componentId, cx?.to?.componentId]) if (id) ligadoPorSsu.add(String(id));
    }
    const ehMedidorSsu = (c: Record<string, any>) =>
      String(c?.type ?? '') === 'medidor_ssu' ||
      (String(c?.type ?? '') === 'medidor_comum' && ligadoPorSsu.has(String(c?.id)));
    const devices = comps.filter((c) => {
      if (isTon(c?.type)) return false;
      if (ehMedidorSsu(c)) return true;
      const p = (c?.props ?? {}) as Record<string, unknown>;
      return (
        String(p.modbus_address ?? '').trim() !== '' &&
        String(p.catalog_id ?? '').trim() !== ''
      );
    });
    if (devices.length === 0) return;

    // Adjacencia pra achar, por topologia, a TON que le cada device.
    const adj = new Map<string, string[]>();
    for (const cx of (diagrama.connections ?? []) as Array<any>) {
      const a = cx?.from?.componentId;
      const b = cx?.to?.componentId;
      if (!a || !b) continue;
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a)!.push(b);
      adj.get(b)!.push(a);
    }
    const byId = new Map<string, Record<string, any>>(comps.map((c) => [String(c?.id), c]));
    const tonTopicDe = (startId: string): string | null => {
      const visto = new Set<string>([startId]);
      const fila: string[] = [startId];
      while (fila.length) {
        const id = fila.shift() as string;
        const c = byId.get(id);
        if (c && id !== startId && isTon(c.type)) {
          const t = String(c.props?.mqtt_topic_base ?? '').trim();
          if (t) return t;
        }
        for (const viz of adj.get(id) ?? []) {
          if (!visto.has(viz)) {
            visto.add(viz);
            fila.push(viz);
          }
        }
      }
      return null;
    };

    const proj = await tx.iot_projetos.findFirst({
      where: { id: projetoId },
      select: { unidade_id: true },
    });
    const unidadeId = proj?.unidade_id?.trim() || null;

    for (const comp of devices) {
      const rawEquip = this.rawEquipamentoId(comp as unknown as IotDiagramaComponent);
      if (rawEquip) {
        const ok = await tx.equipamentos.findFirst({
          where: { id: rawEquip, deleted_at: null },
          select: { id: true, topico_mqtt: true },
        });
        if (ok) {
          // Medidor SSU vinculado a um ativo existente (ex.: o medidor da concessionária do
          // unifilar): o ativo precisa do topico da TON pra o NexON escutar a leitura.
          if (ehMedidorSsu(comp)) {
            const b = tonTopicDe(String(comp.id));
            const pp = (comp.props ?? {}) as Record<string, unknown>;
            const nm = String(pp.name ?? pp.catalog_id ?? comp.type ?? 'Device').trim() || 'Device';
            const ad = String(pp.modbus_address ?? '').trim() || '1';
            const tp = b ? `${b}/${nm}_${ad}/data` : null;
            if (tp && (ok.topico_mqtt ?? '').trim() !== tp) {
              await tx.equipamentos.update({ where: { id: ok.id }, data: { topico_mqtt: tp, mqtt_habilitado: true } });
            }
          }
          continue;
        }
      }

      const props = (comp.props ?? {}) as Record<string, unknown>;
      const base = tonTopicDe(String(comp.id));
      if (!base) continue; // device solto (sem TON conectada) — sem topico derivavel

      const nome =
        String(props.name ?? props.catalog_id ?? comp.type ?? 'Device').trim() || 'Device';
      const addr = String(props.modbus_address ?? '').trim() || '1';
      const topico = `${base}/${nome}_${addr}/data`;
      // Medidor SSU: tipo de equipamento da categoria "Gateway" (o mesmo do A-966) — e' a
      // categoria que liga a ingestao de pulsos (salvarDadosGateway), o dashboard do
      // gateway e o fluxo BIDIRECIONAL na demanda. A TON publica o mesmo JSON do A-966.
      const tipoEquipamentoId =
        String(comp.type ?? '') === 'medidor_ssu' ? 'tipo-ims-a966-001'
        : ehMedidorSsu(comp) ? 'cmsyybblg000jjq1qr1na33zz'   // Medidor Concessionária (EQTL001)
        : undefined;

      let equipId: string;
      const existente = await tx.equipamentos.findFirst({
        where: { topico_mqtt: topico, deleted_at: null },
        select: { id: true },
      });
      if (existente) {
        equipId = existente.id.trim();
      } else {
        const novo = await tx.equipamentos.create({
          data: {
            id: this.generateId(),
            nome,
            classificacao: 'UC',
            criticidade: '3',
            tipo_equipamento: String(comp.type ?? '').toUpperCase(),
            ...(tipoEquipamentoId ? { tipo_equipamento_id: tipoEquipamentoId } : {}),
            mqtt_habilitado: true,
            automacao: false,
            topico_mqtt: topico,
            ...(unidadeId ? { unidade_id: unidadeId } : {}),
          },
          select: { id: true },
        });
        equipId = novo.id.trim();
        console.log(
          `🔧 [IoT] equipamento auto-criado p/ device "${nome}" (${topico}) — antes era so desenho`,
        );
      }

      comp.props = { ...props, equipamento_id: equipId };
    }
  }

  /**
   * Reescreve iot_componentes + iot_conexoes do projeto a partir do diagrama.
   * Chamado dentro da transacao do updateProjeto.
   */
  private async syncRelational(
    tx: Prisma.TransactionClient,
    projetoId: string,
    diagrama: IotDiagrama,
  ): Promise<void> {
    await tx.iot_conexoes.deleteMany({ where: { projeto_id: projetoId } });
    await tx.iot_componentes.deleteMany({ where: { projeto_id: projetoId } });

    if (!Array.isArray(diagrama.components) || diagrama.components.length === 0) {
      return;
    }

    // Pre-resolve equipamento_ids via existence check em equipamentos.
    // Handles CHAR(26) padding e ids invalidos sem quebrar a transacao.
    const requestedEquipIds = new Set<string>();
    for (const comp of diagrama.components) {
      const raw = this.rawEquipamentoId(comp);
      if (raw) requestedEquipIds.add(raw);
    }
    const validEquipIds = new Set<string>();
    if (requestedEquipIds.size > 0) {
      const found = await tx.equipamentos.findMany({
        where: { id: { in: Array.from(requestedEquipIds) }, deleted_at: null },
        select: { id: true },
      });
      for (const e of found) validEquipIds.add(e.id.trim());
    }

    const idMapping = new Map<string, string>();
    for (const comp of diagrama.components) {
      const dbId = this.generateId();
      const localId = String(comp.id);
      idMapping.set(localId, dbId);

      const rawEquip = this.rawEquipamentoId(comp);
      const equipamentoId =
        rawEquip && validEquipIds.has(rawEquip) ? rawEquip : null;

      await tx.iot_componentes.create({
        data: {
          id: dbId,
          projeto_id: projetoId,
          tipo: comp.type,
          x: typeof comp.x === 'number' ? comp.x : 0,
          y: typeof comp.y === 'number' ? comp.y : 0,
          equipamento_id: equipamentoId,
          props: this.extractComponentProps(comp) as unknown as Prisma.InputJsonValue,
        },
      });
    }

    if (!Array.isArray(diagrama.connections)) return;

    for (const conn of diagrama.connections) {
      const fromRef = this.parseConnectionRef(conn.from);
      const toRef = this.parseConnectionRef(conn.to);
      if (!fromRef || !toRef) continue;

      const fromCompId = idMapping.get(fromRef.componentId);
      const toCompId = idMapping.get(toRef.componentId);
      if (!fromCompId || !toCompId) continue;

      await tx.iot_conexoes.create({
        data: {
          id: this.generateId(),
          projeto_id: projetoId,
          from_comp_id: fromCompId,
          from_port: this.truncatePort(fromRef.port),
          to_comp_id: toCompId,
          to_port: this.truncatePort(toRef.port),
          estilo: typeof conn.style === 'string' ? conn.style.slice(0, 20) : 'rs485',
        },
      });
    }
  }

  /**
   * Extrai equipamento_id bruto (texto trimado) do component.
   * NAO valida formato — validacao acontece via SELECT em equipamentos
   * dentro da transacao (lida com CHAR(26) padding e ids garbage).
   * Aceita o id em comp.props.equipamento_id ou no proprio comp.equipamento_id.
   */
  private rawEquipamentoId(comp: IotDiagramaComponent): string | null {
    const props = (comp as Record<string, unknown>).props;
    const fromProps =
      props && typeof props === 'object'
        ? (props as Record<string, unknown>).equipamento_id
        : undefined;
    const fromTop = (comp as Record<string, unknown>).equipamento_id;
    const raw = typeof fromProps === 'string' ? fromProps : fromTop;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return trimmed.length === 0 ? null : trimmed;
  }

  /** Coleta atributos custom do componente (tudo exceto id/type/x/y) para gravar em iot_componentes.props. */
  private extractComponentProps(comp: IotDiagramaComponent): Record<string, unknown> {
    const { id: _id, type: _type, x: _x, y: _y, props, ...rest } = comp;
    const merged: Record<string, unknown> = { ...rest };
    if (props && typeof props === 'object') {
      Object.assign(merged, props as Record<string, unknown>);
    }
    return merged;
  }

  /** Parse das duas formas que `connection.from`/`connection.to` aparecem no JSON. */
  private parseConnectionRef(
    ref: unknown,
  ): { componentId: string; port?: string } | null {
    if (ref === null || ref === undefined) return null;
    if (typeof ref === 'string' || typeof ref === 'number') {
      return { componentId: String(ref) };
    }
    if (typeof ref === 'object') {
      const obj = ref as Record<string, unknown>;
      const compId = obj.componentId ?? obj.id;
      if (compId === undefined || compId === null) return null;
      const port = typeof obj.port === 'string' ? obj.port : undefined;
      return { componentId: String(compId), port };
    }
    return null;
  }

  private truncatePort(port: string | undefined): string {
    if (!port) return '';
    return port.slice(0, 10);
  }

  /** Cast da linha do Prisma para o shape consumido pelo frontend. */
  private toProjetoRow = (row: {
    id: string;
    unidade_id: string;
    nome: string;
    diagrama: Prisma.JsonValue;
    created_at: Date;
    updated_at: Date;
  }): IotProjetoRow => ({
    id: row.id,
    unidade_id: row.unidade_id,
    nome: row.nome,
    diagrama: (row.diagrama ?? EMPTY_DIAGRAMA) as unknown as IotDiagrama,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}
