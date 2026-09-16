import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '@/core';

/**
 * Espelhamento (Fase 3 — dual-write) dos vínculos ponto↔canal para a tabela
 * unificada `iot_vinculos`. As FONTES continuam sendo a verdade e mandando na
 * leitura (ton_bo/ton_bi/ton_ai e o io_config do diagrama); aqui só se replica,
 * em paralelo, para validar a tabela nova antes do flip.
 *
 * Estratégia = RESYNC idempotente (reconstrói a partir da fonte), não upsert
 * linha-a-linha: é self-healing e imune a divergência acumulada. BEST-EFFORT:
 * nunca lança — uma falha do espelho jamais pode derrubar a escrita real.
 *
 * As linhas de espelho são derivadas/descartáveis (hard delete + reinsert).
 */
@Injectable()
export class VinculosMirrorService {
  private readonly logger = new Logger(VinculosMirrorService.name);

  constructor(private readonly prisma: PrismaService) {}

  private novoId(): string {
    return randomBytes(13).toString('hex'); // 26 chars, igual ao ton-bi
  }

  /** Reconstrói os vínculos de um TIPO de canal da TON (ton_bo/ton_bi/ton_ai). */
  async resyncTonCanais(tonEquipId: string, kind: 'ton_bo' | 'ton_bi' | 'ton_ai'): Promise<void> {
    const ton = (tonEquipId ?? '').trim();
    if (!ton) return;
    try {
      // 1) Lê a fonte viva.
      type Fonte = { canal: number; ponto: string | null; params: Record<string, unknown>; ativo: boolean };
      let fonte: Fonte[] = [];

      if (kind === 'ton_bo') {
        const rows = await this.prisma.ton_bo.findMany({
          where: { ton_id: ton, deleted_at: null },
          select: { bo_numero: true, equipamento_ponto_id: true, pulso_ms: true, ativo: true },
        });
        fonte = rows.map((r) => ({
          canal: r.bo_numero, ponto: r.equipamento_ponto_id?.trim() || null,
          params: { pulso_ms: r.pulso_ms }, ativo: r.ativo,
        }));
      } else if (kind === 'ton_bi') {
        const rows = await this.prisma.$queryRaw<Array<{ bi_numero: number; equipamento_ponto_id: string | null; invertido: boolean; ativo: boolean }>>`
          SELECT bi_numero, equipamento_ponto_id, invertido, ativo FROM ton_bi
          WHERE TRIM(ton_id) = ${ton} AND deleted_at IS NULL`;
        fonte = rows.map((r) => ({
          canal: Number(r.bi_numero), ponto: r.equipamento_ponto_id?.trim() || null,
          params: { invertido: !!r.invertido }, ativo: !!r.ativo,
        }));
      } else {
        const rows = await this.prisma.$queryRaw<Array<{ ai_numero: number; equipamento_ponto_id: string | null; mv_0: number; mv_100: number; ativo: boolean }>>`
          SELECT ai_numero, equipamento_ponto_id, mv_0, mv_100, ativo FROM ton_ai
          WHERE TRIM(ton_id) = ${ton} AND deleted_at IS NULL`;
        fonte = rows.map((r) => ({
          canal: Number(r.ai_numero), ponto: r.equipamento_ponto_id?.trim() || null,
          params: { mv_0: Number(r.mv_0), mv_100: Number(r.mv_100) }, ativo: !!r.ativo,
        }));
      }

      // 2) Zera o espelho deste tipo/fonte e reinsere só os canais COM ponto.
      await this.prisma.$executeRaw`
        DELETE FROM iot_vinculos WHERE fonte_equipamento_id = ${ton} AND fonte_tipo = ${kind}`;
      for (const f of fonte) {
        if (!f.ponto) continue;
        await this.prisma.$executeRaw`
          INSERT INTO iot_vinculos (id, equipamento_ponto_id, fonte_tipo, fonte_equipamento_id, canal, params, ativo, origem)
          VALUES (${this.novoId()}, ${f.ponto}, ${kind}, ${ton}, ${f.canal}, ${JSON.stringify(f.params)}::jsonb, ${f.ativo}, 'mirror')`;
      }
    } catch (e) {
      this.logger.warn(`[vinculos-mirror] resync ${kind} da TON ${ton} falhou (espelho ignorado): ${e instanceof Error ? e.message : e}`);
    }
  }

  // ==========================================================================
  // LEITURA de iot_vinculos (Fase 4 usa em SOMBRA; Fase 5 flipa a leitura pra cá).
  // ==========================================================================

  /** Canal ton_bo (comando) vinculado a um ponto. */
  async lookupTonBo(pontoId: string): Promise<{ ton_id: string; canal: number; pulso_ms: number | null } | null> {
    const pid = (pontoId ?? '').trim();
    if (!pid) return null;
    const rows = await this.prisma.$queryRaw<Array<{ ton_id: string; canal: number; pulso_ms: string | null }>>`
      SELECT TRIM(fonte_equipamento_id) AS ton_id, canal, params->>'pulso_ms' AS pulso_ms
      FROM iot_vinculos
      WHERE fonte_tipo = 'ton_bo' AND TRIM(equipamento_ponto_id) = ${pid} AND ativo = true AND deleted_at IS NULL
      LIMIT 1`;
    if (!rows[0]) return null;
    return { ton_id: rows[0].ton_id.trim(), canal: Number(rows[0].canal), pulso_ms: rows[0].pulso_ms == null ? null : Number(rows[0].pulso_ms) };
  }

  /**
   * Coil Modbus (comando via relé) vinculado a um ponto. `sinal` = cmd_id do firmware.
   * ENRIQUECIDO (flip do resolveReleBo): resolve também o COMPONENTE do relé no diagrama
   * — `relay_name` (props.name, que o firmware casa por strcmp), `comp_id` e `projeto_id`
   * (nós de partida do BFS até a TON gateway). O vínculo é a verdade do mapa ponto→(relé,coil);
   * o NOME e a TOPOLOGIA seguem no diagrama (iot_componentes/iot_conexoes, que NÃO se aposenta).
   * `io_config` só entra como desempate determinístico (prefere o componente que ainda o tem)
   * — não como fonte do mapeamento. Retorna null se o relé não tiver props.name (não dá pra
   * comandar sem o device_name do firmware) — mesma regra da fonte antiga.
   */
  async lookupModbusBo(pontoId: string): Promise<{
    relay_equip_id: string;
    relay_name: string;
    sinal: string;
    comp_id: string;
    projeto_id: string;
  } | null> {
    const pid = (pontoId ?? '').trim();
    if (!pid) return null;
    const rows = await this.prisma.$queryRaw<Array<{
      relay_equip_id: string; sinal: string | null; comp_id: string; projeto_id: string | null; relay_name: string | null;
    }>>`
      SELECT TRIM(v.fonte_equipamento_id) AS relay_equip_id,
             v.sinal AS sinal,
             c.id AS comp_id,
             TRIM(c.projeto_id) AS projeto_id,
             c.props->>'name' AS relay_name
      FROM iot_vinculos v
      JOIN iot_componentes c
        ON TRIM(COALESCE(NULLIF(TRIM(c.equipamento_id), ''), c.props->>'equipamento_id')) = TRIM(v.fonte_equipamento_id)
      WHERE v.fonte_tipo = 'modbus_bo' AND TRIM(v.equipamento_ponto_id) = ${pid} AND v.deleted_at IS NULL
      ORDER BY (c.props ? 'io_config') DESC, c.id
      LIMIT 1`;
    const r = rows[0];
    if (!r) return null;
    const relayName = (r.relay_name ?? '').trim();
    if (!relayName) return null;
    return {
      relay_equip_id: r.relay_equip_id.trim(),
      relay_name: relayName,
      sinal: (r.sinal ?? '').trim(),
      comp_id: r.comp_id,
      projeto_id: (r.projeto_id ?? '').trim(),
    };
  }

  /** Fonte de status (aberto/fechado) de um disjuntor, via bit Modbus de relé. */
  async lookupStatusFonte(disjuntorEquipId: string): Promise<{ rele_equipamento_id: string; campo_aberto: string | null; campo_fechado: string | null } | null> {
    const dj = (disjuntorEquipId ?? '').trim();
    if (!dj) return null;
    const rows = await this.prisma.$queryRaw<Array<{ rele_equip_id: string; papel: string | null; sinal: string | null }>>`
      SELECT TRIM(v.fonte_equipamento_id) AS rele_equip_id, v.papel, v.sinal
      FROM iot_vinculos v
      JOIN equipamento_pontos p ON p.id = v.equipamento_ponto_id
      WHERE v.fonte_tipo = 'modbus_bi' AND TRIM(p.equipamento_id) = ${dj} AND v.deleted_at IS NULL`;
    if (!rows.length) return null;
    return {
      rele_equipamento_id: rows[0].rele_equip_id.trim(),
      campo_aberto: rows.find((r) => r.papel === 'aberto')?.sinal ?? null,
      campo_fechado: rows.find((r) => r.papel === 'fechado')?.sinal ?? null,
    };
  }

  /** Loga uma divergência de sombra (Fase 4) de forma padronizada. */
  divergiu(path: string, fonte: unknown, vinculo: unknown): void {
    this.logger.warn(`[vinculos-shadow] divergencia ${path}: fonte=${JSON.stringify(fonte)} vinculo=${JSON.stringify(vinculo)}`);
  }

  /**
   * Reconstrói os vínculos MODBUS_BI (status) dos componentes de um projeto a partir do
   * `iot_componentes.props.io_config.bi`. Best-effort.
   *
   * FASE 6 (inversão da escrita): o `modbus_bo` (COMANDO de relé) NÃO é mais reconstruído
   * daqui — passou a ser ESCRITO DIRETO no vínculo pela UI (DeviceIoConfigModal →
   * `escreverModbusBo`, origem='ui'). Se este resync ainda apagasse/reconstruísse o
   * modbus_bo a partir do props, sobrescreveria a escrita autoritativa da UI. Então aqui
   * só mexemos em modbus_bi (que segue com o props como fonte, enquanto o status não é
   * invertido). O io_config.bo no props permanece como FALLBACK (não é a fonte da verdade).
   */
  async resyncProjetoModbus(projetoId: string): Promise<void> {
    const proj = (projetoId ?? '').trim();
    if (!proj) return;
    try {
      // Equipamentos-fonte deste projeto (os que têm io_config).
      const comps = await this.prisma.$queryRaw<Array<{ equipamento_id: string | null; io_config: any }>>`
        SELECT COALESCE(NULLIF(TRIM(c.equipamento_id), ''), c.props->>'equipamento_id') AS equipamento_id,
               c.props->'io_config' AS io_config
        FROM iot_componentes c
        WHERE TRIM(c.projeto_id) = ${proj} AND c.props ? 'io_config'`;

      const equipIds = [...new Set(comps.map((c) => c.equipamento_id?.trim()).filter(Boolean))] as string[];
      if (equipIds.length) {
        // Zera SÓ o espelho modbus_bi desses equipamentos e reconstrói (modbus_bo é UI).
        await this.prisma.$executeRaw`
          DELETE FROM iot_vinculos
          WHERE fonte_tipo = 'modbus_bi' AND fonte_equipamento_id = ANY(${equipIds})`;
      }

      for (const c of comps) {
        const eq = c.equipamento_id?.trim();
        const io = c.io_config;
        if (!eq || !io || typeof io !== 'object') continue;

        const mapa = io.bi;
        if (!mapa || typeof mapa !== 'object') continue;
        for (const [chave, val] of Object.entries(mapa as Record<string, any>)) {
          const ponto = String(val?.ponto_id ?? '').trim();
          if (!ponto) continue;
          // Ponto precisa existir (FK). Se não existir, pula silenciosamente.
          const existe = await this.prisma.equipamento_pontos.findFirst({ where: { id: ponto, deleted_at: null }, select: { id: true } });
          if (!existe) continue;
          const papel = /aberto/i.test(chave) ? 'aberto' : /fechado/i.test(chave) ? 'fechado' : null;
          const params = { ...val }; delete params.equipamento_id; delete params.ponto_id;
          await this.prisma.$executeRaw`
            INSERT INTO iot_vinculos (id, equipamento_ponto_id, fonte_tipo, fonte_equipamento_id, sinal, papel, params, ativo, origem)
            VALUES (${this.novoId()}, ${ponto}, 'modbus_bi', ${eq}, ${chave}, ${papel}, ${JSON.stringify(params)}::jsonb, true, 'mirror')`;
        }
      }
    } catch (e) {
      this.logger.warn(`[vinculos-mirror] resync modbus_bi do projeto ${proj} falhou (espelho ignorado): ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * FASE 6 — ESCRITA AUTORITATIVA do comando de relé (modbus_bo) direto no vínculo.
   * Substitui TODOS os modbus_bo do relé pelos do `boMap` ({ [sinal]: { coil, func, ...,
   * ponto_id } } — a forma do io_config.bo). origem='ui'. Fonte da verdade do COMANDO passa
   * a ser esta tabela; o props.io_config.bo vira só fallback. Não lança (best-effort do
   * ponto de vista do vínculo), mas retorna a contagem escrita pro chamador validar.
   */
  async escreverModbusBo(relayEquipId: string, boMap: Record<string, any>): Promise<number> {
    const relay = (relayEquipId ?? '').trim();
    if (!relay) return 0;
    // Troca atômica: apaga os modbus_bo do relé e reinsere o mapa da UI. O mapa reflete
    // FIELMENTE o que está na tela (a projeção já traz equipamento_id, então o modal não
    // descarta mais nenhum comando) — logo, mapa vazio = o usuário removeu tudo (limpa).
    await this.prisma.$executeRaw`
      DELETE FROM iot_vinculos WHERE TRIM(fonte_equipamento_id) = ${relay} AND fonte_tipo = 'modbus_bo'`;
    let n = 0;
    for (const [sinal, valRaw] of Object.entries(boMap || {})) {
      const val = valRaw && typeof valRaw === 'object' ? (valRaw as Record<string, unknown>) : {};
      const ponto = String((val as any).ponto_id ?? '').trim();
      if (!ponto) continue;
      const existe = await this.prisma.equipamento_pontos.findFirst({ where: { id: ponto, deleted_at: null }, select: { id: true } });
      if (!existe) continue;
      const params = { ...val };
      delete (params as any).equipamento_id;
      delete (params as any).ponto_id;
      await this.prisma.$executeRaw`
        INSERT INTO iot_vinculos (id, equipamento_ponto_id, fonte_tipo, fonte_equipamento_id, sinal, papel, params, ativo, origem)
        VALUES (${this.novoId()}, ${ponto}, 'modbus_bo', ${relay}, ${sinal}, NULL, ${JSON.stringify(params)}::jsonb, true, 'ui')`;
      n++;
    }
    return n;
  }
}
