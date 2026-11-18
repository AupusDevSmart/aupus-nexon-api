import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, CurrentUser, PrismaService, PermissionScopeService } from '@/core';
import { OcppService } from './ocpp.service';

/**
 * Central OCPP — visão técnica das estações e transações (diagnóstico). Só leitura,
 * recortada pela planta da estação.
 *
 * Comando a carregador não passa por aqui (NEXON-130): iniciar, parar, limites e os demais
 * estão em `/carregador-eletrico/:id/*`, que conferem papel e escopo e gravam o audit log.
 */
@Controller('ocpp')
@UseGuards(JwtAuthGuard)
export class OcppController {
  constructor(
    private readonly svc: OcppService,
    private readonly prisma: PrismaService,
    private readonly scope: PermissionScopeService,
  ) {}

  /** Estações cadastradas + estado ao vivo (conectada agora). */
  @Get('charge-points')
  async chargePoints(@CurrentUser() user: any) {
    const escopo = await this.scope.getScope(user);
    const scoped = this.scope.isScoped(escopo);
    const rows = await this.prisma.$queryRaw<Array<any>>`
      SELECT charge_point_id, vendor, model, firmware_version, serial_number, ocpp_version,
             status, error_code, conectado, ultimo_boot, ultimo_heartbeat, ultima_conexao,
             TRIM(planta_id) AS planta_id, TRIM(equipamento_id) AS equipamento_id
      FROM ocpp_charge_points WHERE deleted_at IS NULL ORDER BY charge_point_id
    `;
    const vivos = new Set(this.svc.conectados());
    let out = (rows || []).map((r) => ({ ...r, ao_vivo: vivos.has(r.charge_point_id) }));
    if (scoped) {
      const perm = new Set((escopo as string[]).map((x) => String(x).trim()));
      out = out.filter((r) => r.planta_id && perm.has(String(r.planta_id).trim()));
      // Operador: só as estações dos carregadores liberados a ele.
      const eqs = await this.scope.getEquipamentosScope(user);
      if (eqs) out = out.filter((r) => r.equipamento_id && eqs.includes(String(r.equipamento_id).trim()));
    }
    return { data: out };
  }

  /** Transações (registro bruto do carregador) — filtra por chargePointId opcional. */
  @Get('transactions')
  async transactions(
    @Query('chargePointId') cpId: string,
    @Query('limite') limite: string,
    @CurrentUser() user: any,
  ) {
    const n = Math.min(Number(limite) || 100, 500);
    // Mesmo recorte da lista de estações, no SQL e antes do LIMIT.
    const escopo = await this.scope.getScope(user);
    const plantas = this.scope.isScoped(escopo) ? escopo.map((x) => String(x).trim()) : null;
    const eqs = await this.scope.getEquipamentosScope(user);
    const rows = await this.prisma.$queryRaw<Array<any>>`
      SELECT t.transaction_id, t.charge_point_id, t.connector_id, t.id_tag,
             TRIM(t.morador_id) AS morador_id, t.meter_start, t.meter_stop, t.energia_kwh,
             t.inicio, t.fim, t.motivo_fim, t.status, TRIM(cp.planta_id) AS planta_id
      FROM ocpp_transactions t
      LEFT JOIN ocpp_charge_points cp ON cp.charge_point_id = t.charge_point_id
      WHERE (${cpId || null}::text IS NULL OR t.charge_point_id = ${cpId || null})
        AND (${plantas === null}::boolean OR TRIM(cp.planta_id) = ANY(${plantas ?? []}::text[]))
        AND (${eqs === null}::boolean OR TRIM(cp.equipamento_id) = ANY(${eqs ?? []}::text[]))
      ORDER BY t.inicio DESC NULLS LAST
      LIMIT ${n}
    `;
    return { data: rows || [] };
  }
}
