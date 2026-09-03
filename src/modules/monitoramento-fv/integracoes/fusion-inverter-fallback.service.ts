import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomBytes } from 'crypto';
import { PrismaService, PermissionScopeService, ScopedUser } from '@aupus/api-shared';
import { FusionSolarService, FusionInverterKpi } from './fusion-solar/fusion-solar.service';

interface MapRow {
  id: string;
  equipamento_id: string;
  unidade_id: string | null;
  plant_code: string;
  device_id: string;
  dev_type_id: number;
  device_esn: string | null;
  device_name: string | null;
}

export interface FallbackResult {
  plantas: number;
  inversores_mapeados: number;
  escritos: number;
  pulados_ton_viva: number;
  erros: string[];
}

/**
 * FALLBACK POR-INVERSOR (nuvem → modal "Dados em Tempo Real").
 *
 * Só **Fusion/Huawei** tem device-level acessível (iSolar Free = E900; Deye
 * device/list = 0). Quando a TON de um inversor mapeado fica obsoleta (sem
 * leitura MQTT há > STALE_MIN), o cron puxa o `getDevRealKpi` do inversor na
 * nuvem e grava uma linha em `equipamentos_dados` (fonte `NUVEM_FUSION`) no
 * MESMO formato JSON do MQTT — o read `obterDadoAtual` (pacote shared) pega a
 * última linha e o modal renderiza, sem tocar no pacote shared.
 *
 * Guarda anti-clobber: se existe leitura MQTT fresca (< STALE_MIN), NÃO grava —
 * a TON viva continua sendo a verdade. Assim nuvem só preenche o buraco.
 */
@Injectable()
export class FusionInverterFallbackService {
  private readonly logger = new Logger(FusionInverterFallbackService.name);
  private readonly STALE_MIN = Number(process.env.FV_INV_FALLBACK_STALE_MIN ?? 40);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fusion: FusionSolarService,
    private readonly scope: PermissionScopeService,
  ) {}

  // A cada 30 min. Barato: 1 getDevRealKpi por planta com inversor OBSOLETO.
  @Cron('0 */30 * * * *', { timeZone: 'America/Sao_Paulo' })
  async cron(): Promise<void> {
    try {
      const r = await this.runFallback();
      if (r.escritos || r.erros.length) {
        this.logger.log(
          `[fv-inv-nuvem] plantas=${r.plantas} escritos=${r.escritos} pulados(TON viva)=${r.pulados_ton_viva}` +
            (r.erros.length ? ` erros=${r.erros.join('; ')}` : ''),
        );
      }
    } catch (e: any) {
      this.logger.error('[fv-inv-nuvem] erro fatal', e?.stack || e?.message);
    }
  }

  /** Percorre os inversores mapeados, grava a nuvem só onde a TON está obsoleta. */
  async runFallback(): Promise<FallbackResult> {
    const maps = await this.prisma.$queryRaw<MapRow[]>`
      SELECT id, TRIM(equipamento_id) AS equipamento_id, unidade_id, plant_code,
             device_id, dev_type_id, device_esn, device_name
      FROM fv_inversor_cloud_map
      WHERE ativo = true AND provedor = 'fusion_solar'`;
    const res: FallbackResult = {
      plantas: 0, inversores_mapeados: maps.length, escritos: 0, pulados_ton_viva: 0, erros: [],
    };
    if (!maps.length) return res;

    const byPlant = new Map<string, MapRow[]>();
    for (const m of maps) {
      if (!byPlant.has(m.plant_code)) byPlant.set(m.plant_code, []);
      byPlant.get(m.plant_code)!.push(m);
    }
    res.plantas = byPlant.size;

    for (const [plantCode, rows] of byPlant) {
      const stale: MapRow[] = [];
      for (const r of rows) {
        if (await this.temMqttFresco(r.equipamento_id)) { res.pulados_ton_viva++; continue; }
        stale.push(r);
      }
      if (!stale.length) continue;
      try {
        const kpis = await this.fusion.getInvertersRealKpi(
          stale.map((s) => s.device_id),
          stale[0].dev_type_id ?? 1,
        );
        const byDev = new Map(kpis.map((k) => [k.devId, k]));
        for (const r of stale) {
          const k = byDev.get(r.device_id);
          if (!k) { res.erros.push(`${r.device_name || r.device_id}: sem realKpi`); continue; }
          await this.gravarLinhaNuvem(r.equipamento_id, k);
          res.escritos++;
        }
      } catch (e: any) {
        res.erros.push(`planta ${plantCode}: ${e?.message || e}`);
      }
    }
    return res;
  }

  /** true se há leitura MQTT (não-nuvem) nos últimos STALE_MIN minutos. */
  private async temMqttFresco(equipamentoId: string): Promise<boolean> {
    const r = await this.prisma.$queryRaw<Array<{ c: number }>>`
      SELECT count(*)::int AS c
      FROM equipamentos_dados
      WHERE TRIM(equipamento_id) = ${equipamentoId}
        AND fonte NOT LIKE 'NUVEM%'
        AND timestamp_dados >= now() - make_interval(mins => ${this.STALE_MIN})`;
    return Number(r[0]?.c ?? 0) > 0;
  }

  /** Grava a telemetria da nuvem no MESMO formato JSON do MQTT do inversor. */
  private async gravarLinhaNuvem(equipamentoId: string, k: FusionInverterKpi): Promise<void> {
    const P_W = k.activePowerKw != null ? Math.round(k.activePowerKw * 1000) : null;
    const Q_var = k.reactivePowerKvar != null ? Math.round(k.reactivePowerKvar * 1000) : null;
    const S_va = P_W != null && Q_var != null ? Math.round(Math.hypot(P_W, Q_var)) : P_W;
    const running = k.runState === 1;
    const dados = {
      power: {
        active_total: P_W,          // W (modal exibe via formatPowerGeneric(...,'W'))
        reactive_total: Q_var,      // Var
        apparent_total: S_va,       // VA
        power_factor: k.powerFactor,
        frequency: k.frequencyHz,
      },
      energy: { daily_yield: k.dayEnergyKwh, total_yield: k.totalEnergyKwh }, // kWh
      temperature: { internal: k.temperatureC },
      status: {
        work_state: running ? 0 : 1,
        work_state_text: running ? 'Run' : k.runState === 0 ? 'Standby' : '—',
      },
      info: { device_type: 'fusion_solar', nominal_power: null },
      // Marca a origem (o modal ignora chaves extras; útil p/ auditar/badge futuro).
      _nuvem: { provedor: 'fusion_solar', device_esn: k.sn, dev_id: k.devId, coletado_em: new Date().toISOString() },
      timestamp: Math.floor(Date.now() / 1000),
    };
    const id = randomBytes(13).toString('hex');
    await this.prisma.$executeRaw`
      INSERT INTO equipamentos_dados
        (id, equipamento_id, dados, fonte, timestamp_dados, potencia_ativa_kw, created_at)
      VALUES (${id}, ${equipamentoId}, ${JSON.stringify(dados)}::jsonb, 'NUVEM_FUSION', now(),
              ${k.activePowerKw ?? null}, now())`;
  }

  // ---------------------------------------------------------------------------
  // Config (UI "configurar em cada inversor")
  // ---------------------------------------------------------------------------

  /** Resolve o plantCode Fusion de uma unidade (via unidade_fv_config). */
  private async plantCodeDaUnidade(unidadeId: string): Promise<string> {
    const r = await this.prisma.$queryRaw<Array<{ plant: string }>>`
      SELECT provedor_planta_id AS plant
      FROM unidade_fv_config
      WHERE TRIM(unidade_id) = ${unidadeId.trim()}
        AND provedor_monitoramento = 'fusion_solar'
        AND COALESCE(provedor_planta_id, '') <> ''
      LIMIT 1`;
    if (!r[0]?.plant) {
      throw new BadRequestException('Unidade não é Fusion/Huawei (ou sem provedor_planta_id).');
    }
    return r[0].plant;
  }

  /**
   * Para a UI: inversores da nuvem (Huawei) + candidatos NexON da unidade +
   * mapa atual. Admin escolhe qual equipamento casa com qual device.
   */
  async listarDispositivos(unidadeId: string, user?: ScopedUser) {
    const uid = unidadeId.trim();
    if (user) await this.scope.assertEntityInScope('unidade', uid, user);
    const plantCode = await this.plantCodeDaUnidade(uid);
    const [huawei, candidatos, mapa] = await Promise.all([
      this.fusion.listInverters(plantCode),
      this.prisma.$queryRaw<Array<{ id: string; nome: string; classificacao: string | null }>>`
        SELECT TRIM(id) AS id, TRIM(nome) AS nome, classificacao
        FROM equipamentos
        WHERE TRIM(unidade_id) = ${uid} AND deleted_at IS NULL
        ORDER BY nome`,
      this.prisma.$queryRaw<MapRow[]>`
        SELECT id, TRIM(equipamento_id) AS equipamento_id, unidade_id, plant_code,
               device_id, dev_type_id, device_esn, device_name
        FROM fv_inversor_cloud_map WHERE TRIM(unidade_id) = ${uid}`,
    ]);
    return { plant_code: plantCode, huawei, candidatos, mapa };
  }

  /** Cria/atualiza o vínculo equipamento → device (valida que o device é da planta). */
  async salvarMapa(equipamentoId: string, deviceId: string, user?: ScopedUser) {
    const eqId = equipamentoId.trim();
    if (user) await this.scope.assertEntityInScope('equipamento', eqId, user);
    const eq = await this.prisma.equipamentos.findFirst({
      where: { id: eqId, deleted_at: null },
      select: { id: true, unidade_id: true },
    });
    if (!eq) throw new NotFoundException(`Equipamento ${eqId} não encontrado`);
    const unidadeId = (eq.unidade_id ?? '').trim();
    if (!unidadeId) throw new BadRequestException('Equipamento sem unidade — não dá pra resolver a planta.');
    const plantCode = await this.plantCodeDaUnidade(unidadeId);
    const dev = (await this.fusion.listInverters(plantCode)).find((d) => d.devId === String(deviceId));
    if (!dev) throw new BadRequestException(`Device ${deviceId} não é um inversor desta planta (${plantCode}).`);

    const id = randomBytes(13).toString('hex');
    await this.prisma.$executeRaw`
      INSERT INTO fv_inversor_cloud_map
        (id, equipamento_id, unidade_id, provedor, plant_code, device_id, device_esn, dev_type_id, device_name, ativo, created_at, updated_at)
      VALUES (${id}, ${eqId}, ${unidadeId}, 'fusion_solar', ${plantCode}, ${dev.devId}, ${dev.esn},
              ${dev.devTypeId}, ${dev.name}, true, now(), now())
      ON CONFLICT (equipamento_id) DO UPDATE SET
        unidade_id = EXCLUDED.unidade_id, plant_code = EXCLUDED.plant_code,
        device_id = EXCLUDED.device_id, device_esn = EXCLUDED.device_esn,
        dev_type_id = EXCLUDED.dev_type_id, device_name = EXCLUDED.device_name,
        ativo = true, updated_at = now()`;
    return { ok: true, equipamento_id: eqId, device_id: dev.devId, device_esn: dev.esn, device_name: dev.name };
  }

  /** Remove (desativa) o vínculo de um inversor. */
  async removerMapa(equipamentoId: string, user?: ScopedUser) {
    const eqId = equipamentoId.trim();
    if (user) await this.scope.assertEntityInScope('equipamento', eqId, user);
    await this.prisma.$executeRaw`
      UPDATE fv_inversor_cloud_map SET ativo = false, updated_at = now()
      WHERE TRIM(equipamento_id) = ${eqId}`;
    return { ok: true, equipamento_id: eqId };
  }
}
