import { Injectable, Logger, ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService, PermissionScopeService, ScopedUser } from '@/core';
import { MqttService } from '../../shared/mqtt/mqtt.service';

/**
 * Posto de Combustível — cadastro (tags RFID das máquinas + operadores/matrículas +
 * config da bomba), lista de autorizados (empurrada pra TON por MQTT retido, com
 * versão), transações, eventos e estado da bomba (modal/relatório). Owner-scoped
 * por planta (PermissionScopeService). Ingestão MQTT (abastecimento/bomba/evento)
 * e a resposta a `auth/req` ficam no MqttService.
 *
 * Modelo (doc "Posto de Combustível na Fazenda — Como funciona"): a TAG identifica a
 * MÁQUINA (rfid_autorizados) e a MATRÍCULA identifica o OPERADOR (bomba_operadores).
 * `rfid_autorizados.matriculas` (jsonb []) restringe quais operadores podem abastecer
 * aquela máquina (vazio = qualquer operador cadastrado). A lista vai pra TON como
 * {versao, tags:[{uid,mats,limite,maquina}], mats:[...]} — a TON valida offline com ela.
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
  async plantaDaBomba(bombaId: string): Promise<string | null> {
    const r = await this.prisma.$queryRaw<Array<{ planta_id: string }>>`
      SELECT TRIM(u.planta_id) AS planta_id
      FROM equipamentos e JOIN unidades u ON TRIM(u.id) = TRIM(e.unidade_id)
      WHERE TRIM(e.id) = ${bombaId.trim()} LIMIT 1`;
    return r[0]?.planta_id ?? null;
  }
  private async assertBombaNoEscopo(user: ScopedUser | undefined, bombaId: string) {
    const plantaId = await this.plantaDaBomba(bombaId);
    await this.assertPlantaNoEscopo(user, plantaId || '');
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

  // ===== Tags RFID (máquinas) =====
  async listarRfid(user?: ScopedUser, bombaId?: string): Promise<any[]> {
    const plantas = await this.plantasDoUsuario(user);
    const plantaId = bombaId ? await this.plantaDaBomba(bombaId) : null;
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT id, uid, maquina_id, maquina_nome, operador, bomba_id, planta_id, ativo,
             limite_litros_dia, COALESCE(matriculas, '[]'::jsonb) AS matriculas,
             to_char(updated_at,'YYYY-MM-DD HH24:MI') AS updated_at
      FROM rfid_autorizados
      WHERE (${bombaId ?? null}::text IS NULL OR bomba_id = ${bombaId ?? null}
             OR (bomba_id IS NULL AND planta_id = ${plantaId ?? null}))
      ORDER BY ativo DESC, maquina_nome NULLS LAST, uid`;
    return plantas ? rows.filter((r) => !r.planta_id || plantas.includes(String(r.planta_id).trim())) : rows;
  }

  async salvarRfid(body: any, user?: ScopedUser): Promise<any> {
    const uid = String(body.uid || '').trim().toUpperCase();
    if (!uid) throw new NotFoundException('UID obrigatório');
    const bombaId = body.bomba_id ? String(body.bomba_id).trim() : null;
    const plantaId = bombaId ? await this.plantaDaBomba(bombaId) : (body.planta_id ?? null);
    await this.assertPlantaNoEscopo(user, plantaId || '');
    const matriculas = JSON.stringify(
      (Array.isArray(body.matriculas) ? body.matriculas : String(body.matriculas ?? '').split(/[,;\s]+/))
        .map((m: any) => String(m ?? '').trim()).filter(Boolean),
    );
    const limite = body.limite_litros_dia === '' || body.limite_litros_dia == null ? null : Number(body.limite_litros_dia);

    const id = body.id ? String(body.id).trim() : this.genId();
    const existe = body.id
      ? (await this.prisma.$queryRaw<any[]>`SELECT 1 FROM rfid_autorizados WHERE id = ${id} LIMIT 1`).length > 0
      : false;

    if (existe) {
      await this.prisma.$executeRaw`
        UPDATE rfid_autorizados SET uid=${uid}, maquina_id=${body.maquina_id ?? null},
          maquina_nome=${body.maquina_nome ?? null}, operador=${body.operador ?? null}, bomba_id=${bombaId},
          planta_id=${plantaId}, ativo=${body.ativo !== false}, limite_litros_dia=${limite},
          matriculas=${matriculas}::jsonb, updated_at=now() WHERE id=${id}`;
    } else {
      await this.prisma.$executeRaw`
        INSERT INTO rfid_autorizados (id, uid, maquina_id, maquina_nome, operador, bomba_id, planta_id, ativo, limite_litros_dia, matriculas)
        VALUES (${id}, ${uid}, ${body.maquina_id ?? null}, ${body.maquina_nome ?? null}, ${body.operador ?? null},
                ${bombaId}, ${plantaId}, ${body.ativo !== false}, ${limite}, ${matriculas}::jsonb)`;
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

  // ===== Operadores (matrículas) =====
  async listarOperadores(user?: ScopedUser, bombaId?: string): Promise<any[]> {
    const plantas = await this.plantasDoUsuario(user);
    const plantaId = bombaId ? await this.plantaDaBomba(bombaId) : null;
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT id, matricula, nome, bomba_id, planta_id, ativo, to_char(updated_at,'YYYY-MM-DD HH24:MI') AS updated_at
      FROM bomba_operadores
      WHERE (${bombaId ?? null}::text IS NULL OR bomba_id = ${bombaId ?? null}
             OR (bomba_id IS NULL AND planta_id = ${plantaId ?? null}))
      ORDER BY ativo DESC, nome NULLS LAST, matricula`;
    return plantas ? rows.filter((r) => !r.planta_id || plantas.includes(String(r.planta_id).trim())) : rows;
  }
  async salvarOperador(body: any, user?: ScopedUser): Promise<any> {
    const matricula = String(body.matricula || '').trim();
    if (!matricula) throw new NotFoundException('Matrícula obrigatória');
    const bombaId = body.bomba_id ? String(body.bomba_id).trim() : null;
    const plantaId = bombaId ? await this.plantaDaBomba(bombaId) : (body.planta_id ?? null);
    await this.assertPlantaNoEscopo(user, plantaId || '');
    const id = body.id ? String(body.id).trim() : this.genId();
    const existe = body.id
      ? (await this.prisma.$queryRaw<any[]>`SELECT 1 FROM bomba_operadores WHERE id = ${id} LIMIT 1`).length > 0
      : false;
    if (existe) {
      await this.prisma.$executeRaw`
        UPDATE bomba_operadores SET matricula=${matricula}, nome=${body.nome ?? null}, bomba_id=${bombaId},
          planta_id=${plantaId}, ativo=${body.ativo !== false}, updated_at=now() WHERE id=${id}`;
    } else {
      await this.prisma.$executeRaw`
        INSERT INTO bomba_operadores (id, matricula, nome, bomba_id, planta_id, ativo)
        VALUES (${id}, ${matricula}, ${body.nome ?? null}, ${bombaId}, ${plantaId}, ${body.ativo !== false})`;
    }
    if (bombaId) await this.publicarWhitelist(bombaId);
    return { id };
  }
  async removerOperador(id: string, user?: ScopedUser): Promise<{ ok: boolean }> {
    const r = await this.prisma.$queryRaw<any[]>`SELECT bomba_id, planta_id FROM bomba_operadores WHERE id=${id.trim()} LIMIT 1`;
    if (!r.length) return { ok: true };
    await this.assertPlantaNoEscopo(user, r[0].planta_id || '');
    await this.prisma.$executeRaw`DELETE FROM bomba_operadores WHERE id=${id.trim()}`;
    if (r[0].bomba_id) await this.publicarWhitelist(String(r[0].bomba_id).trim());
    return { ok: true };
  }

  // ===== Lista de autorizados → TON (MQTT retido, com versão) =====
  /**
   * {versao, tags:[{uid, mats:[...], limite, maquina}], mats:[...]}
   * versao = epoch (s) da última alteração no cadastro da planta — monotônica, a TON mostra no status.
   */
  async montarLista(bombaId: string): Promise<{ versao: number; tags: any[]; mats: string[] }> {
    const plantaId = await this.plantaDaBomba(bombaId);
    const tags = await this.prisma.$queryRaw<Array<{ uid: string; maquina_nome: string | null; limite: number | null; matriculas: any; updated_at: Date }>>`
      SELECT uid, maquina_nome, limite_litros_dia AS limite, COALESCE(matriculas,'[]'::jsonb) AS matriculas, updated_at
      FROM rfid_autorizados
      WHERE ativo = true AND (bomba_id = ${bombaId} OR (bomba_id IS NULL AND planta_id = ${plantaId}))
      ORDER BY uid`;
    const ops = await this.prisma.$queryRaw<Array<{ matricula: string; updated_at: Date }>>`
      SELECT matricula, updated_at FROM bomba_operadores
      WHERE ativo = true AND (bomba_id = ${bombaId} OR (bomba_id IS NULL AND planta_id = ${plantaId}))
      ORDER BY matricula`;
    let versao = 0;
    for (const r of [...tags, ...ops]) { const t = Math.floor(new Date(r.updated_at).getTime() / 1000); if (t > versao) versao = t; }
    return {
      versao,
      tags: tags.map((t) => ({
        uid: String(t.uid).toUpperCase(),
        mats: Array.isArray(t.matriculas) ? t.matriculas.map((m: any) => String(m)) : [],
        limite: Number(t.limite) > 0 ? Number(t.limite) : 0,
        maquina: t.maquina_nome ?? undefined,
      })),
      mats: ops.map((o) => String(o.matricula)),
    };
  }

  /** TONs que controlam a bomba (donas dos BO amarrados aos pontos dela) → tópico base de cada uma. */
  async tonsDaBomba(bombaId: string): Promise<Array<{ ton_id: string; nome: string; topico: string | null; base: string }>> {
    const rows = await this.prisma.$queryRaw<Array<{ ton_id: string; nome: string; topico: string | null }>>`
      SELECT DISTINCT TRIM(t.id) AS ton_id, TRIM(t.nome) AS nome, NULLIF(TRIM(t.topico_mqtt), '') AS topico
      FROM ton_bo tb
      JOIN equipamento_pontos p ON p.id = tb.equipamento_ponto_id
      JOIN equipamentos t ON TRIM(t.id) = TRIM(tb.ton_id) AND t.deleted_at IS NULL
      WHERE TRIM(p.equipamento_id) = ${bombaId.trim()} AND tb.deleted_at IS NULL`;
    // Sem tópico cadastrado = bancada (firmware 🧪 escuta em TESTE/<nome da TON>)
    return rows.map((r) => ({ ...r, base: (r.topico ?? `TESTE/${r.nome}`).replace(/\/+$/, '') }));
  }

  async publicarWhitelist(bombaId: string): Promise<{ enviado: boolean; total: number; versao: number; topics: string[] }> {
    const lista = await this.montarLista(bombaId);
    const tons = await this.tonsDaBomba(bombaId);
    if (!tons.length) {
      this.logger.warn(`[posto] ${bombaId} sem TON amarrada (ton_bo) — lista não enviada`);
      return { enviado: false, total: lista.tags.length, versao: lista.versao, topics: [] };
    }
    const topics: string[] = [];
    for (const t of tons) {
      const topic = `${t.base}/cmd/rfid_sync`;
      try {
        await this.mqtt.publish(topic, JSON.stringify(lista), { retain: true } as any);
        topics.push(topic);
      } catch (e) {
        this.logger.error(`[posto] falha ao publicar lista em ${topic}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return { enviado: topics.length > 0, total: lista.tags.length, versao: lista.versao, topics };
  }

  // ===== Config da bomba =====
  async getConfig(equipamentoId: string, user?: ScopedUser): Promise<any> {
    if (user) await this.assertBombaNoEscopo(user, equipamentoId);
    const r = await this.prisma.$queryRaw<any[]>`
      SELECT * FROM bomba_combustivel_config WHERE TRIM(equipamento_id) = ${equipamentoId.trim()} LIMIT 1`;
    return r[0] ?? null;
  }
  async salvarConfig(equipamentoId: string, body: any, user?: ScopedUser): Promise<any> {
    await this.assertBombaNoEscopo(user, equipamentoId);
    const eid = equipamentoId.trim();
    const existe = (await this.prisma.$queryRaw<any[]>`SELECT 1 FROM bomba_combustivel_config WHERE TRIM(equipamento_id)=${eid} LIMIT 1`).length > 0;
    if (existe) {
      await this.prisma.$executeRaw`
        UPDATE bomba_combustivel_config SET nivel_min_pct=${body.nivel_min_pct ?? 10}, timeout_s=${body.timeout_s ?? 600},
          k_fator=${body.k_fator ?? 450}, rfid_mode=${body.rfid_mode ?? 'rs485'}, updated_at=now()
        WHERE TRIM(equipamento_id)=${eid}`;
    } else {
      await this.prisma.$executeRaw`
        INSERT INTO bomba_combustivel_config (id, equipamento_id, nivel_min_pct, timeout_s, k_fator, rfid_mode)
        VALUES (${this.genId()}, ${eid}, ${body.nivel_min_pct ?? 10}, ${body.timeout_s ?? 600}, ${body.k_fator ?? 450}, ${body.rfid_mode ?? 'rs485'})`;
    }
    return this.getConfig(eid);
  }

  // ===== Abastecimentos, eventos e estado (modal/relatório) =====
  async listarAbastecimentos(user?: ScopedUser, bombaId?: string, limite = 100): Promise<any[]> {
    const plantas = await this.plantasDoUsuario(user);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT a.id, TRIM(a.equipamento_id) AS equipamento_id, a.uid, a.maquina_nome, a.matricula, a.operador_nome,
             a.litros, a.nivel_antes, a.nivel_depois, a.status, a.fim_motivo, a.validacao, a.planta_id,
             to_char(a.inicio,'DD/MM HH24:MI') AS inicio, to_char(a.fim,'DD/MM HH24:MI') AS fim,
             to_char(a.created_at,'DD/MM HH24:MI') AS created_at, a.created_at AS created_at_raw
      FROM abastecimentos a
      WHERE (${bombaId ?? null}::text IS NULL OR TRIM(a.equipamento_id) = ${bombaId ?? null})
      ORDER BY a.created_at DESC LIMIT ${Math.min(Number(limite) || 100, 1000)}`;
    return plantas ? rows.filter((r) => !r.planta_id || plantas.includes(String(r.planta_id).trim())) : rows;
  }

  async listarEventos(user: ScopedUser | undefined, bombaId: string, limite = 50): Promise<any[]> {
    if (user) await this.assertBombaNoEscopo(user, bombaId);
    return this.prisma.$queryRaw<any[]>`
      SELECT id, tipo, motivo, uid, matricula, seq, to_char(COALESCE(ts, created_at),'DD/MM HH24:MI:SS') AS quando
      FROM bomba_eventos WHERE TRIM(equipamento_id) = ${bombaId.trim()}
      ORDER BY created_at DESC LIMIT ${Math.min(Number(limite) || 50, 500)}`;
  }

  async getEstado(equipamentoId: string, user?: ScopedUser): Promise<any> {
    await this.assertBombaNoEscopo(user, equipamentoId);
    const eid = equipamentoId.trim();
    const cfg = await this.getConfig(eid);
    const ult = await this.listarAbastecimentos(undefined, eid, 8);
    const lista = await this.montarLista(eid);
    const tons = await this.tonsDaBomba(eid);
    let eventos: any[] = [];
    try { eventos = await this.listarEventos(undefined, eid, 12); } catch { /* tabela pode não existir ainda */ }
    const tel = cfg?.ultimo_json ?? null;
    return {
      estado: tel?.estado ?? cfg?.ultimo_estado ?? 'desconhecido',
      nivel_pct: tel?.nivel_pct ?? cfg?.ultimo_nivel_pct ?? null,
      ultima_leitura: cfg?.ultima_leitura ?? null,
      telemetria: tel,
      lista_versao_nexon: lista.versao,
      lista_versao_ton: tel?.lista_versao ?? cfg?.lista_versao ?? null,
      rfid_autorizados: lista.tags.length,
      operadores: lista.mats.length,
      tons,
      ultimos_abastecimentos: ult,
      eventos,
    };
  }
}
