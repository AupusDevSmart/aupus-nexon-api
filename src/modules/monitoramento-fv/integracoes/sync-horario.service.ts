import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomBytes } from 'crypto';
import { PrismaService } from '@/core';
import { IsolarCloudService } from './isolarcloud/isolarcloud.service';
import { DeyeCloudService } from './deye-cloud/deye-cloud.service';

interface UnidadeFv {
  unidade_id: string;
  nome: string;
  provedor_planta_id: string;
}

export interface SyncHorarioResult {
  hora: string;
  provedor: string;
  ok: boolean;
  atualizadas: number;
  erros: string[];
}

/**
 * FALLBACK HORÁRIO (Fase 1 — coleta). Fotografa de hora em hora o `today_energy`
 * (kWh ACUMULADO do dia) de cada planta de nuvem e grava em `geracao_horaria_plantas`.
 * A geração de cada hora é o DELTA entre snapshots consecutivos do mesmo dia — reconstrói
 * a curva horária mesmo com o plano Free (que só expõe o acumulado).
 *
 * Provedores:
 *   - iSolarCloud: 1 chamada/hora para TODAS as plantas (listStations) → barato (24/dia).
 *   - Deye: 1 chamada/planta/hora (getDayEnergy do dia corrente).
 *   - Fusion: NÃO entra aqui (limite 30/h apertado) — continua só no diário.
 *
 * A Fase 2 (servir esses dados quando a TON fica > 1h obsoleta) é separada; aqui só coleta.
 */
@Injectable()
export class MonitoramentoSyncHorarioService {
  private readonly logger = new Logger(MonitoramentoSyncHorarioService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly isolar: IsolarCloudService,
    private readonly deye: DeyeCloudService,
  ) {}

  // Todo início de hora cheia (minuto 0). SP.
  @Cron('0 0 * * * *', { timeZone: 'America/Sao_Paulo' })
  async cronHorario(): Promise<void> {
    const hora = this.horaSP();
    this.logger.log(`[fv-horario] snapshot hora=${hora} — iniciando`);
    try {
      const res = await this.snapshotTodos();
      for (const r of res) {
        this.logger.log(
          `[fv-horario] ${r.provedor}: ${r.ok ? 'OK' : 'FALHA'} atualizadas=${r.atualizadas}` +
            (r.erros.length ? ` erros=${r.erros.join('; ')}` : ''),
        );
      }
    } catch (e: any) {
      this.logger.error('[fv-horario] erro fatal', e?.stack || e?.message);
    }
  }

  /** Dispara o snapshot de todos os provedores horários. Também exposto p/ trigger manual. */
  async snapshotTodos(): Promise<SyncHorarioResult[]> {
    const hora = this.horaSP();
    const [i, d] = await Promise.all([
      this.snapshotIsolar(hora).catch((e) => this.err('isolarcloud', hora, e)),
      this.snapshotDeye(hora).catch((e) => this.err('deye', hora, e)),
    ]);
    return [i, d];
  }

  private async snapshotIsolar(hora: string): Promise<SyncHorarioResult> {
    const us = await this.unidadesDoProvedor('isolarcloud');
    if (!us.length) return this.okEmpty('isolarcloud', hora);
    const stations = await this.isolar.listStations();
    const byId = new Map(stations.map((s) => [s.psId, s]));
    let atualizadas = 0;
    const erros: string[] = [];
    for (const u of us) {
      const s = byId.get(u.provedor_planta_id);
      if (!s) { erros.push(`${u.nome} (ps_id=${u.provedor_planta_id}): nao encontrada`); continue; }
      try {
        await this.upsertSnapshot(u.unidade_id, hora, s.todayEnergyKwh);
        atualizadas++;
      } catch (e: any) {
        erros.push(`${u.nome}: ${e?.message || e}`);
      }
    }
    return { provedor: 'isolarcloud', hora, ok: erros.length === 0, atualizadas, erros };
  }

  private async snapshotDeye(hora: string): Promise<SyncHorarioResult> {
    const us = await this.unidadesDoProvedor('deye');
    if (!us.length) return this.okEmpty('deye', hora);
    if (!this.deye.isEnabled()) {
      return { provedor: 'deye', hora, ok: false, atualizadas: 0, erros: ['Deye nao configurado (env)'] };
    }
    const hoje = this.hojeSP();
    let atualizadas = 0;
    const erros: string[] = [];
    for (const u of us) {
      try {
        const stationId = Number(u.provedor_planta_id);
        if (!Number.isFinite(stationId)) { erros.push(`${u.nome}: provedor_planta_id invalido`); continue; }
        const kwh = await this.deye.getDayEnergy(stationId, hoje);
        if (kwh == null) { erros.push(`${u.nome}: sem dado hoje`); continue; }
        await this.upsertSnapshot(u.unidade_id, hora, kwh);
        atualizadas++;
      } catch (e: any) {
        erros.push(`${u.nome}: ${e?.message || e}`);
      }
    }
    return { provedor: 'deye', hora, ok: erros.length === 0, atualizadas, erros };
  }

  /**
   * Grava o snapshot do acumulado na hora e calcula o delta (geração da hora) vs. o
   * último snapshot do MESMO dia. Se o acumulado caiu (virada de dia/reset), delta = acumulado.
   */
  private async upsertSnapshot(unidadeId: string, hora: string, acumulado: number): Promise<void> {
    const prev = await this.prisma.$queryRaw<Array<{ kwh_acumulado: number | null }>>`
      SELECT kwh_acumulado::float8 AS kwh_acumulado
      FROM geracao_horaria_plantas
      WHERE TRIM(unidade_id) = ${unidadeId}
        AND hora::date = ${hora}::timestamp::date
        AND hora < ${hora}::timestamp
      ORDER BY hora DESC
      LIMIT 1
    `;
    const prevAcum = prev[0]?.kwh_acumulado;
    const kwhHora =
      prevAcum == null ? acumulado : Math.max(0, Number((acumulado - prevAcum).toFixed(3)));
    const id = randomBytes(13).toString('hex');
    await this.prisma.$executeRaw`
      INSERT INTO geracao_horaria_plantas
        (id, unidade_id, hora, kwh_acumulado, kwh_hora, origem, created_at, updated_at)
      VALUES (${id}, ${unidadeId}, ${hora}::timestamp, ${acumulado}, ${kwhHora}, 'nuvem', now(), now())
      ON CONFLICT (unidade_id, hora) DO UPDATE SET
        kwh_acumulado = EXCLUDED.kwh_acumulado,
        kwh_hora = EXCLUDED.kwh_hora,
        origem = 'nuvem',
        updated_at = now()
    `;
    // Reflete a frescura horária na tela de Controle de sync (coluna "Última sync").
    await this.prisma.$executeRaw`
      UPDATE unidade_fv_config SET ultima_sync_em = now(), updated_at = now()
      WHERE TRIM(unidade_id) = ${unidadeId}
    `;
  }

  /**
   * Só as plantas marcadas como SUB-DIÁRIAS (frequencia_min < 1440) entram no snapshot
   * horário — honra a periodicidade escolhida na tela de Controle de sync. As "Diária"
   * ficam de fora (recebem só o cron das 21h). Evita poll horário à toa (relevante no Deye,
   * que é 1 chamada/planta).
   */
  private async unidadesDoProvedor(provedor: string): Promise<UnidadeFv[]> {
    return this.prisma.$queryRaw<UnidadeFv[]>`
      SELECT TRIM(c.unidade_id) AS unidade_id, TRIM(u.nome) AS nome,
             c.provedor_planta_id AS provedor_planta_id
      FROM unidade_fv_config c
      JOIN unidades u ON TRIM(u.id) = TRIM(c.unidade_id) AND u.deleted_at IS NULL
      WHERE c.provedor_monitoramento = ${provedor}
        AND COALESCE(c.provedor_planta_id, '') <> ''
        AND c.ativo = true
        AND COALESCE(c.frequencia_min, 1440) < 1440
    `;
  }

  private okEmpty(p: string, hora: string): SyncHorarioResult {
    return { provedor: p, hora, ok: true, atualizadas: 0, erros: [] };
  }
  private err(p: string, hora: string, e: any): SyncHorarioResult {
    return { provedor: p, hora, ok: false, atualizadas: 0, erros: [String(e?.message || e)] };
  }

  /** 'YYYY-MM-DD HH:00:00' na hora cheia atual de São Paulo. */
  private horaSP(): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
    const hh = g('hour') === '24' ? '00' : g('hour');
    return `${g('year')}-${g('month')}-${g('day')} ${hh}:00:00`;
  }

  private hojeSP(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  }
}
