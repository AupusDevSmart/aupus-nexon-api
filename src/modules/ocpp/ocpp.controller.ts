import { Body, Controller, ForbiddenException, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, CurrentUser, PrismaService, PermissionScopeService } from '@aupus/api-shared';
import { OcppService } from './ocpp.service';

/**
 * CSMS OCPP — visão e comando das estações. Listagem owner-scoped por planta do CP
 * (CP sem planta atribuída = só admin). Comandos remotos (start/stop/reset): admin.
 */
@Controller('ocpp')
@UseGuards(JwtAuthGuard)
export class OcppController {
  constructor(
    private readonly svc: OcppService,
    private readonly prisma: PrismaService,
    private readonly scope: PermissionScopeService,
  ) {}

  private assertAdmin(user: any) {
    const role = String(user?.role || '').toLowerCase();
    if (!['super_admin', 'admin', 'gerente'].includes(role)) {
      throw new ForbiddenException('Apenas administradores comandam estações OCPP.');
    }
  }

  /** Estações registradas + estado ao vivo (conectado agora). */
  @Get('charge-points')
  async chargePoints(@CurrentUser() user: any) {
    const escopo = await this.scope.getScope(user);
    const scoped = this.scope.isScoped(escopo);
    const rows = await this.prisma.$queryRaw<Array<any>>`
      SELECT charge_point_id, vendor, model, firmware_version, serial_number, ocpp_version,
             status, conectado, ultimo_boot, ultimo_heartbeat, TRIM(planta_id) AS planta_id
      FROM ocpp_charge_points ORDER BY charge_point_id
    `;
    const vivos = new Set(this.svc.conectados());
    let out = (rows || []).map((r) => ({ ...r, ao_vivo: vivos.has(r.charge_point_id) }));
    if (scoped) {
      const perm = new Set((escopo as string[]).map((x) => String(x).trim()));
      out = out.filter((r) => r.planta_id && perm.has(String(r.planta_id).trim()));
    }
    return { data: out };
  }

  /** Transações (sessões) — filtra por chargePointId opcional. */
  @Get('transactions')
  async transactions(
    @Query('chargePointId') cpId: string,
    @Query('limite') limite: string,
    @CurrentUser() user: any,
  ) {
    const n = Math.min(Number(limite) || 100, 500);
    const rows = await this.prisma.$queryRaw<Array<any>>`
      SELECT t.transaction_id, t.charge_point_id, t.connector_id, t.id_tag,
             TRIM(t.morador_id) AS morador_id, t.meter_start, t.meter_stop, t.energia_kwh,
             t.inicio, t.fim, t.motivo_fim, t.status
      FROM ocpp_transactions t
      WHERE (${cpId || null}::text IS NULL OR t.charge_point_id = ${cpId || null})
      ORDER BY t.inicio DESC NULLS LAST
      LIMIT ${n}
    `;
    return { data: rows || [] };
  }

  /** Inicia recarga remotamente (CSMS → carregador). */
  @Post(':cpId/remote-start')
  async remoteStart(@Param('cpId') cpId: string, @Body() body: any, @CurrentUser() user: any) {
    this.assertAdmin(user);
    return { data: await this.svc.remoteStart(cpId, String(body?.idTag || ''), body?.connectorId ? Number(body.connectorId) : undefined) };
  }

  /** Para recarga remotamente. */
  @Post(':cpId/remote-stop')
  async remoteStop(@Param('cpId') cpId: string, @Body() body: any, @CurrentUser() user: any) {
    this.assertAdmin(user);
    return { data: await this.svc.remoteStop(cpId, Number(body?.transactionId)) };
  }

  /** Reinicia a estação (Soft/Hard). */
  @Post(':cpId/reset')
  async reset(@Param('cpId') cpId: string, @Body() body: any, @CurrentUser() user: any) {
    this.assertAdmin(user);
    return { data: await this.svc.reset(cpId, body?.type === 'Hard' ? 'Hard' : 'Soft') };
  }
}
