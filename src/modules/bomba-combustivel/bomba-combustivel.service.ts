import { Injectable, Logger, ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService, PermissionScopeService, ScopedUser } from '@aupus/api-shared';
import { MqttService } from '../../shared/mqtt/mqtt.service';

/**
 * Bomba de Combustível — cadastro (RFID autorizados + config da bomba), whitelist
 * (empurrada pro TON por MQTT retido), transações de abastecimento e estado da bomba
 * (pro modal). Owner-scoped por planta (PermissionScopeService). Ingestão MQTT das
 * transações fica no MqttService (`/abastecimento` e `/bomba`).
 */
@Injectable()
export class BombaCombustivelService {
  private readonly logger = new Logger(BombaCombustivelService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: PermissionScopeService,
    private readonly mqtt: MqttService,
  ) {}

  private genId(): string { return randomBytes(13).toString('hex'); }

  private async assertPlantaNoEscopo(user: ScopedUser | undefined, plantaId: string) {
    if (!user || !plantaId) return;
    const escopo = await this.scope.getScope(user);
    if (this.scope.isScoped(escopo) && !escopo.includes(plantaId.trim())) {
      throw new ForbiddenException('Fora do escopo');
    }
  }
  private async plantasDoUsuario(user?: ScopedUser): Promise<string[] | null> {
    if (!user) return null;
    const escopo = await this.scope.getScope(user);
    return this.scope.isScoped(escopo) ? escopo : null;
  }

  // Resolve planta_id da bomba (equipamento → unidade → planta).
  private async plantaDaBomba(bombaId: string): Promise<string | null> {
    const r = await this.prisma.$queryRaw<Array<{ planta_id: string }>>`
      SELECT TRIM(u.planta_id) AS planta_id
      FROM equipamentos e JOIN unidades u ON TRIM(u.id) = TRIM(e.unidade_id)
      WHERE TRIM(e.id) = ${bombaId.trim()} LIMIT 1`;
    return r[0]?.planta_id ?? null;
  }

  // ===== Bombas (equipamentos do tipo bomba) =====
  async listarBombas(user?: ScopedUser): Promise<any[]> {
    const plantas = await this.plantasDoUsuario(user);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT TRIM(e.id) AS id, TRIM(e.nome) AS nome, TRIM(e.unidade_id) AS unidade_id,
             TRIM(u.planta_id) AS planta_id, TRIM(u.nome) AS unidade_nome,
             c.ultimo_estado, c.ultimo_nivel_pct, c.ultima_leitura
      FROM equipamentos e
      JOIN unidades u ON TRIM(u.id) = TRIM(e.unidade_id)
      LEFT JOIN bomba_combustivel_config c ON TRIM(c.equipamento_id) = TRIM(e.id)
      LEFT JOIN tipos_equipamentos te ON TRIM(te.id) = TRIM(e.tipo_equipamento_id)
      WHERE e.deleted_at IS NULL
        AND (e.tipo_equipamento ILIKE '%bomba%combust%' OR e.tipo_equipamento ILIKE '%fuel%pump%'
             OR te.codigo ILIKE '%BOMBA%COMBUST%' OR te.nome ILIKE '%bomba%combust%')
      ORDER BY e.nome`;
    return plantas ? rows.filter((r) => plantas.includes(r.planta_id)) : rows;
  }

  // ===== RFID autorizados =====
  async listarRfid(user?: ScopedUser, bombaId?: string): Promise<any[]> {
    const plantas = await this.plantasDoUsuario(user);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT id, uid, maquina_id, maquina_nome, operador, bomba_id, planta_id, ativo,
             limite_litros_dia, to_char(updated_at,'YYYY-MM-DD HH24:MI') AS updated_at
      FROM rfid_autorizados
      WHERE (${bombaId ?? null}::text IS NULL OR bomba_id = ${bombaId ?? null})
      ORDER BY ativo DESC, maquina_nome NULLS LAST, uid`;
    return plantas ? rows.filter((r) => !r.planta_id || plantas.includes(String(r.planta_id).trim())) : rows;
  }

  async salvarRfid(body: any, user?: ScopedUser): Promise<any> {
    const uid = String(body.uid || '').trim().toUpperCase();
    if (!uid) throw new NotFoundException('UID obrigatório');
    const bombaId = body.bomba_id ? String(body.bomba_id).trim() : null;
    const plantaId = bombaId ? await this.plantaDaBomba(bombaId) : (body.planta_id ?? null);
    await this.assertPlantaNoEscopo(user, plantaId || '');

    const id = body.id ? String(body.id).trim() : this.genId();
    const existe = body.id
      ? (await this.prisma.$queryRaw<any[]>`SELECT 1 FROM rfid_autorizados WHERE id = ${id} LIMIT 1`).length > 0
      : false;

    if (existe) {
      await this.prisma.$executeRaw`
        UPDATE rfid_autorizados SET uid=${uid}, maquina_id=${bombaId ? body.maquina_id ?? null : body.maquina_id ?? null},
          maquina_nome=${body.maquina_nome ?? null}, operador=${body.operador ?? null}, bomba_id=${bombaId},
          planta_id=${plantaId}, ativo=${body.ativo !== false}, limite_litros_dia=${body.limite_litros_dia ?? null},
          updated_at=now() WHERE id=${id}`;
    } else {
      await this.prisma.$executeRaw`
        INSERT INTO rfid_autorizados (id, uid, maquina_id, maquina_nome, operador, bomba_id, planta_id, ativo, limite_litros_dia)
        VALUES (${id}, ${uid}, ${body.maquina_id ?? null}, ${body.maquina_nome ?? null}, ${body.operador ?? null},
                ${bombaId}, ${plantaId}, ${body.ativo !== false}, ${body.limite_litros_dia ?? null})`;
    }
    if (bombaId) await this.publicarWhitelist(bombaId);   // re-sincroniza a bomba afetada
    return { id };
  }

  async removerRfid(id: string, user?: ScopedUser): Promise<{ ok: boolean }> {
    const r = await this.prisma.$queryRaw<any[]>`SELECT bomba_id, planta_id FROM rfid_autorizados WHERE id=${id.trim()} LIMIT 1`;
    if (!r.length) return { ok: true };
    await this.assertPlantaNoEscopo(user, r[0].planta_id || '');
    await this.prisma.$executeRaw`DELETE FROM rfid_autorizados WHERE id=${id.trim()}`;
    if (r[0].bomba_id) await this.publicarWhitelist(String(r[0].bomba_id).trim());
    return { ok: true };
  }

  // ===== Whitelist → TON (MQTT retido) =====
  private async montarWhitelist(bombaId: string): Promise<string[]> {
    const plantaId = await this.plantaDaBomba(bombaId);
    const rows = await this.prisma.$queryRaw<Array<{ uid: string }>>`
      SELECT DISTINCT uid FROM rfid_autorizados
      WHERE ativo = true AND (bomba_id = ${bombaId} OR (bomba_id IS NULL AND planta_id = ${plantaId}))`;
    return rows.map((r) => r.uid);
  }
  async publicarWhitelist(bombaId: string): Promise<{ enviado: boolean; total: number; topic?: string }> {
    const eq = await this.prisma.$queryRaw<Array<{ topico: string }>>`
      SELECT TRIM(topico_mqtt) AS topico FROM equipamentos WHERE TRIM(id) = ${bombaId.trim()} AND mqtt_habilitado = true LIMIT 1`;
    const base = eq[0]?.topico?.replace(/\/+$/, '');
    const uids = await this.montarWhitelist(bombaId);
    if (!base) { this.logger.warn(`[bomba] ${bombaId} sem topico_mqtt — whitelist não enviada`); return { enviado: false, total: uids.length }; }
    const topic = `${base}/cmd/rfid_sync`;
    try {
      await this.mqtt.publish(topic, JSON.stringify({ uids }), { retain: true } as any);
      return { enviado: true, total: uids.length, topic };
    } catch (e) {
      this.logger.error(`[bomba] falha ao publicar whitelist: ${e instanceof Error ? e.message : e}`);
      return { enviado: false, total: uids.length, topic };
    }
  }

  // ===== Config da bomba =====
  async getConfig(equipamentoId: string): Promise<any> {
    const r = await this.prisma.$queryRaw<any[]>`
      SELECT * FROM bomba_combustivel_config WHERE TRIM(equipamento_id) = ${equipamentoId.trim()} LIMIT 1`;
    return r[0] ?? null;
  }
  async salvarConfig(equipamentoId: string, body: any, user?: ScopedUser): Promise<any> {
    const plantaId = await this.plantaDaBomba(equipamentoId);
    await this.assertPlantaNoEscopo(user, plantaId || '');
    const eid = equipamentoId.trim();
    const existe = (await this.prisma.$queryRaw<any[]>`SELECT 1 FROM bomba_combustivel_config WHERE TRIM(equipamento_id)=${eid} LIMIT 1`).length > 0;
    if (existe) {
      await this.prisma.$executeRaw`
        UPDATE bomba_combustivel_config SET nivel_min_pct=${body.nivel_min_pct ?? 5}, timeout_s=${body.timeout_s ?? 600},
          k_fator=${body.k_fator ?? 450}, rfid_mode=${body.rfid_mode ?? 'rs485'}, updated_at=now()
        WHERE TRIM(equipamento_id)=${eid}`;
    } else {
      await this.prisma.$executeRaw`
        INSERT INTO bomba_combustivel_config (id, equipamento_id, nivel_min_pct, timeout_s, k_fator, rfid_mode)
        VALUES (${this.genId()}, ${eid}, ${body.nivel_min_pct ?? 5}, ${body.timeout_s ?? 600}, ${body.k_fator ?? 450}, ${body.rfid_mode ?? 'rs485'})`;
    }
    return this.getConfig(eid);
  }

  // ===== Abastecimentos + estado (modal/relatório) =====
  async listarAbastecimentos(user?: ScopedUser, bombaId?: string, limite = 100): Promise<any[]> {
    const plantas = await this.plantasDoUsuario(user);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT a.id, TRIM(a.equipamento_id) AS equipamento_id, a.uid, a.maquina_nome, a.litros,
             a.nivel_antes, a.nivel_depois, a.status, a.planta_id,
             to_char(a.inicio,'DD/MM HH24:MI') AS inicio, to_char(a.fim,'DD/MM HH24:MI') AS fim,
             to_char(a.created_at,'DD/MM HH24:MI') AS created_at
      FROM abastecimentos a
      WHERE (${bombaId ?? null}::text IS NULL OR TRIM(a.equipamento_id) = ${bombaId ?? null})
      ORDER BY a.created_at DESC LIMIT ${Math.min(Number(limite) || 100, 500)}`;
    return plantas ? rows.filter((r) => !r.planta_id || plantas.includes(String(r.planta_id).trim())) : rows;
  }

  async getEstado(equipamentoId: string, user?: ScopedUser): Promise<any> {
    const plantaId = await this.plantaDaBomba(equipamentoId);
    await this.assertPlantaNoEscopo(user, plantaId || '');
    const cfg = await this.getConfig(equipamentoId);
    const ult = await this.listarAbastecimentos(undefined, equipamentoId.trim(), 5);
    const rfidCount = (await this.montarWhitelist(equipamentoId.trim())).length;
    return {
      estado: cfg?.ultimo_estado ?? 'desconhecido',
      nivel_pct: cfg?.ultimo_nivel_pct ?? null,
      ultima_leitura: cfg?.ultima_leitura ?? null,
      rfid_autorizados: rfidCount,
      ultimos_abastecimentos: ult,
    };
  }
}
