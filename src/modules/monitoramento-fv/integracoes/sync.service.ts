import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomBytes } from 'crypto';
import { PrismaService, Prisma, PlantaScope } from '@aupus/api-shared';
import { FusionSolarService } from './fusion-solar/fusion-solar.service';
import { IsolarCloudService, IsolarStation } from './isolarcloud/isolarcloud.service';
import { DeyeCloudService } from './deye-cloud/deye-cloud.service';

interface UnidadeFv {
  unidade_id: string;
  nome: string;
  provedor_planta_id: string;
  predicao: number;
}

export interface SyncResult {
  provedor: string;
  ok: boolean;
  atualizadas: number;
  puladas: number;
  erros: string[];
}

/**
 * Sync das APIs de nuvem (Fusion/iSolar/Deye) → grava em `public.geracao_diaria_plantas`
 * (origem='nuvem'). Lê o mapa provedor↔planta de `public.unidade_fv_config`.
 *
 * ⚠️ SEM @Cron aqui de propósito: durante a transição o cron das 21h continua sendo do
 * `bdo-aupus-api` (evita dobrar chamadas às APIs → rate limit). Aqui só há trigger
 * MANUAL (POST /monitoramento-fv/sync). O cron migra pro NexON só na Fase 3.
 */
@Injectable()
export class MonitoramentoSyncService {
  private readonly logger = new Logger(MonitoramentoSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fusion: FusionSolarService,
    private readonly isolar: IsolarCloudService,
    private readonly deye: DeyeCloudService,
  ) {}

  // Cron diário: 21h05 SP (5 min após o do bdo-aupus-api, pra não coincidir). A geração
  // do dia já terminou às 21h → today_energy é o valor final. Grava em geracao_diaria_plantas.
  @Cron('0 0 21 * * *', { timeZone: 'America/Sao_Paulo' }) // 21:00 — precede o envio (21:05)
  async cronDiario(): Promise<void> {
    this.logger.log('[monitoramento-fv] cron diário 21h05 SP — iniciando sync');
    try {
      const res = await this.syncAll();
      for (const r of res) {
        this.logger.log(
          `[monitoramento-fv cron] ${r.provedor}: ${r.ok ? 'OK' : 'FALHA'} atualizadas=${r.atualizadas}` +
            (r.erros.length ? ` erros=${r.erros.join('; ')}` : ''),
        );
      }
    } catch (e: any) {
      this.logger.error('[monitoramento-fv cron] erro fatal', e?.stack || e?.message);
    }
  }

  async syncAll(dataAlvo?: string): Promise<SyncResult[]> {
    const data = dataAlvo && /^\d{4}-\d{2}-\d{2}$/.test(dataAlvo) ? dataAlvo : this.hojeSP();
    this.logger.log(`[monitoramento-fv] syncAll data=${data}`);
    const [f, i, d] = await Promise.all([
      this.syncFusion(data).catch((e) => this.err('fusion_solar', e)),
      this.syncIsolar(data).catch((e) => this.err('isolarcloud', e)),
      this.syncDeye(data).catch((e) => this.err('deye', e)),
    ]);
    return [f, i, d];
  }

  private async unidadesDoProvedor(provedor: string): Promise<UnidadeFv[]> {
    return this.prisma.$queryRaw<UnidadeFv[]>`
      SELECT TRIM(c.unidade_id) AS unidade_id, TRIM(u.nome) AS nome,
             c.provedor_planta_id AS provedor_planta_id,
             -- Meta = CADASTRO da instalacao (unidades.predicao_diaria_kwh). Fallback na
             -- config antiga so' por retrocompat. Fonte unica de meta = a unidade.
             COALESCE(u.predicao_diaria_kwh, c.predicao_diaria_kwh, 0)::float8 AS predicao
      FROM unidade_fv_config c
      JOIN unidades u ON TRIM(u.id) = TRIM(c.unidade_id) AND u.deleted_at IS NULL
      WHERE c.provedor_monitoramento = ${provedor}
        AND COALESCE(c.provedor_planta_id, '') <> ''
        AND c.ativo = true
    `;
  }

  async syncFusion(data: string): Promise<SyncResult> {
    const us = await this.unidadesDoProvedor('fusion_solar');
    if (!us.length) return this.okEmpty('fusion_solar');
    let atualizadas = 0;
    const erros: string[] = [];
    for (const u of us) {
      try {
        const dias = await this.fusion.getKpiDay(u.provedor_planta_id, data);
        const alvo = dias.find((d) => d.date === data);
        if (!alvo) { erros.push(`${u.nome}: sem dado ${data}`); continue; }
        await this.upsert(u.unidade_id, data, alvo.inverterPowerKwh, u.predicao);
        atualizadas++;
      } catch (e: any) {
        erros.push(`${u.nome}: ${e?.message || e}`);
      }
    }
    return { provedor: 'fusion_solar', ok: erros.length === 0, atualizadas, puladas: 0, erros };
  }

  async syncIsolar(data: string): Promise<SyncResult> {
    const us = await this.unidadesDoProvedor('isolarcloud');
    if (!us.length) return this.okEmpty('isolarcloud');
    let stations: IsolarStation[];
    try {
      stations = await this.isolar.listStations();
    } catch (e) {
      return this.err('isolarcloud', e);
    }
    const byId = new Map(stations.map((s) => [s.psId, s]));
    let atualizadas = 0;
    const erros: string[] = [];
    for (const u of us) {
      const s = byId.get(u.provedor_planta_id);
      if (!s) { erros.push(`${u.nome} (ps_id=${u.provedor_planta_id}): nao encontrada no iSolar`); continue; }
      try {
        await this.upsert(u.unidade_id, data, s.todayEnergyKwh, u.predicao);
        atualizadas++;
      } catch (e: any) {
        erros.push(`${u.nome}: ${e?.message || e}`);
      }
    }
    return { provedor: 'isolarcloud', ok: erros.length === 0, atualizadas, puladas: 0, erros };
  }

  async syncDeye(data: string): Promise<SyncResult> {
    const us = await this.unidadesDoProvedor('deye');
    if (!us.length) return this.okEmpty('deye');
    if (!this.deye.isEnabled()) {
      return { provedor: 'deye', ok: false, atualizadas: 0, puladas: us.length, erros: ['Deye nao configurado (env)'] };
    }
    let atualizadas = 0;
    const erros: string[] = [];
    for (const u of us) {
      try {
        const stationId = Number(u.provedor_planta_id);
        if (!Number.isFinite(stationId)) { erros.push(`${u.nome}: provedor_planta_id invalido`); continue; }
        const kwh = await this.deye.getDayEnergy(stationId, data);
        if (kwh == null) { erros.push(`${u.nome}: sem dado ${data}`); continue; }
        await this.upsert(u.unidade_id, data, kwh, u.predicao);
        atualizadas++;
      } catch (e: any) {
        erros.push(`${u.nome}: ${e?.message || e}`);
      }
    }
    return { provedor: 'deye', ok: erros.length === 0, atualizadas, puladas: 0, erros };
  }

  private async upsert(unidadeId: string, data: string, real: number, previsto: number): Promise<void> {
    const id = randomBytes(13).toString('hex');
    await this.prisma.$executeRaw`
      INSERT INTO geracao_diaria_plantas
        (id, unidade_id, data, kwh_realizado, kwh_previsto, origem, created_at, updated_at)
      VALUES (${id}, ${unidadeId}, ${data}::date, ${real}, ${previsto}, 'nuvem', now(), now())
      ON CONFLICT (unidade_id, data) DO UPDATE SET
        kwh_realizado = EXCLUDED.kwh_realizado,
        kwh_previsto = EXCLUDED.kwh_previsto,
        origem = 'nuvem',
        updated_at = now()
      WHERE COALESCE(geracao_diaria_plantas.origem, 'nuvem') NOT IN ('manual', 'bdo', 'ton')
    `;
    await this.prisma.$executeRaw`
      UPDATE unidade_fv_config SET ultima_sync_em = now(), updated_at = now()
      WHERE TRIM(unidade_id) = ${unidadeId}
    `;
  }

  /**
   * Geração consolidada de um dia (realizado × meta × %), por unidade. Fonte pro COA
   * exibir as usinas de nuvem + a coluna Meta/eficiência. Só leitura.
   */
  async listarGeracaoDia(
    dataAlvo?: string,
    scope: PlantaScope = null,
  ): Promise<{ data: string; dados: Array<{ unidade_id: string; nome: string; kwh_realizado: number; kwh_previsto: number; pct: number | null; origem: string }> }> {
    const data = dataAlvo && /^\d{4}-\d{2}-\d{2}$/.test(dataAlvo) ? dataAlvo : this.hojeSP();
    const dados = await this.prisma.$queryRaw<
      Array<{ unidade_id: string; nome: string; kwh_realizado: number; kwh_previsto: number; pct: number | null; origem: string }>
    >(Prisma.sql`
      SELECT TRIM(g.unidade_id) AS unidade_id, TRIM(u.nome) AS nome,
             g.kwh_realizado::float8 AS kwh_realizado,
             g.kwh_previsto::float8  AS kwh_previsto,
             CASE WHEN g.kwh_previsto > 0
                  THEN ROUND(g.kwh_realizado / g.kwh_previsto * 100)::int
                  ELSE NULL END       AS pct,
             g.origem
      FROM geracao_diaria_plantas g
      JOIN unidades u ON TRIM(u.id) = TRIM(g.unidade_id) AND u.deleted_at IS NULL
      WHERE g.data = ${data}::date
      ${this.scopeFrag(scope)}
      ORDER BY g.kwh_realizado DESC
    `);
    return { data, dados };
  }

  /**
   * Resumo do parque FV pro painel do COA: totais de hoje (realizado/meta/eficiência),
   * ranking de usinas de hoje, e a série diária do parque (últimos `dias`) pro gráfico
   * de tendência realizado × meta. Só leitura.
   */
  async getResumo(dias = 30, scope: PlantaScope = null): Promise<{
    data: string;
    hoje: { realizado: number; previsto: number; eficiencia: number | null; usinas: number };
    ranking: Array<{ unidade_id: string; nome: string; kwh_realizado: number; kwh_previsto: number; pct: number | null; origem: string }>;
    serie: Array<{ data: string; realizado: number; previsto: number }>;
  }> {
    const d = Math.min(Math.max(Number(dias) || 30, 1), 180);
    const hoje = this.hojeSP();
    const { dados: ranking } = await this.listarGeracaoDia(hoje, scope);
    const realizado = ranking.reduce((s, r) => s + (Number(r.kwh_realizado) || 0), 0);
    const previsto = ranking.reduce((s, r) => s + (Number(r.kwh_previsto) || 0), 0);
    const eficiencia = previsto > 0 ? Math.round((realizado / previsto) * 100) : null;
    // JOIN em unidades (+ scopeFrag) é OBRIGATÓRIO aqui: sem ele a série somaria TODAS as
    // plantas, vazando geração de usinas de outros donos no gráfico de tendência do COA.
    const serie = await this.prisma.$queryRaw<Array<{ data: string; realizado: number; previsto: number }>>(Prisma.sql`
      SELECT to_char(g.data, 'YYYY-MM-DD') AS data,
             SUM(g.kwh_realizado)::float8  AS realizado,
             SUM(g.kwh_previsto)::float8   AS previsto
      FROM geracao_diaria_plantas g
      JOIN unidades u ON TRIM(u.id) = TRIM(g.unidade_id) AND u.deleted_at IS NULL
      WHERE g.data > (${hoje}::date - ${d}::int) AND g.data <= ${hoje}::date
      ${this.scopeFrag(scope)}
      GROUP BY g.data
      ORDER BY g.data ASC
    `);
    return { data: hoje, hoje: { realizado, previsto, eficiencia, usinas: ranking.length }, ranking, serie };
  }

  /**
   * Registros crus de geração diária (últimos `meses`), por unidade — o front filtra e
   * agrega client-side (usina/ano/mês), como o dashboard do BDO fazia.
   */
  async getRegistros(meses = 12, scope: PlantaScope = null): Promise<
    Array<{ unidade_id: string; nome: string; data: string; kwh_realizado: number; kwh_previsto: number }>
  > {
    const m = Math.min(Math.max(Number(meses) || 12, 1), 36);
    return this.prisma.$queryRaw(Prisma.sql`
      SELECT TRIM(g.unidade_id) AS unidade_id, TRIM(u.nome) AS nome,
             to_char(g.data, 'YYYY-MM-DD') AS data,
             g.kwh_realizado::float8 AS kwh_realizado,
             g.kwh_previsto::float8  AS kwh_previsto
      FROM geracao_diaria_plantas g
      JOIN unidades u ON TRIM(u.id) = TRIM(g.unidade_id) AND u.deleted_at IS NULL
      WHERE g.data > (CURRENT_DATE - (${m}::int * INTERVAL '1 month'))
      ${this.scopeFrag(scope)}
      ORDER BY g.data ASC
    `);
  }

  /**
   * Filtro RBAC por dono, aplicado a TODAS as leituras do painel FV do COA. Espelha o
   * mecanismo do COA (PermissionScopeService.getScope):
   *   - scope === null  → usuário sem restrição (admin/gerente) → vê tudo (sem filtro).
   *   - scope === []    → não tem planta nenhuma → não vê nada (condição impossível).
   *   - scope === [...] → restrito às plantas do dono/operador (u.planta_id ∈ scope).
   * Sem isso, proprietário via COA veria a geração de TODAS as usinas. NÃO pode.
   */
  private scopeFrag(scope: PlantaScope): Prisma.Sql {
    if (!Array.isArray(scope)) return Prisma.empty;
    if (scope.length === 0) return Prisma.sql`AND FALSE`;
    const ids = scope.map((s) => String(s).trim());
    return Prisma.sql`AND TRIM(u.planta_id) = ANY(${ids})`;
  }

  private okEmpty(p: string): SyncResult {
    return { provedor: p, ok: true, atualizadas: 0, puladas: 0, erros: [] };
  }
  private err(p: string, e: any): SyncResult {
    return { provedor: p, ok: false, atualizadas: 0, puladas: 0, erros: [String(e?.message || e)] };
  }
  private hojeSP(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  }
}
