import { Body, Controller, ForbiddenException, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, CurrentUser, PrismaService, PermissionScopeService } from '@/core';
import { OcppService } from './ocpp.service';
import { isGlobal, papelCanonico } from '../../core/modules/auth/papeis';

/**
 * CSMS OCPP — visão e comando das estações. Listagem owner-scoped por planta do CP
 * (CP sem planta atribuída = só a equipe Aupus).
 *
 * NEXON-20 (6.2): iniciar/parar recarga = Admin, analistas e o proprietário da
 * planta do CP. O operador fica de fora: o CP não é equipamento do cadastro, então
 * não há como saber se foi liberado a ele. Reset da estação é técnico (equipe Aupus).
 */
@Controller('ocpp')
@UseGuards(JwtAuthGuard)
export class OcppController {
  constructor(
    private readonly svc: OcppService,
    private readonly prisma: PrismaService,
    private readonly scope: PermissionScopeService,
  ) {}

  /** Equipe Aupus (Admin e analistas, inclusive os papéis novos do NEXON-20). */
  private assertAdmin(user: any) {
    if (!isGlobal(papelCanonico(user?.role))) {
      throw new ForbiddenException('Apenas administradores comandam estações OCPP.');
    }
  }

  /** Iniciar/parar recarga: equipe Aupus ou o proprietário, só em CP com planta no escopo dele. */
  private async assertComandoRecarga(user: any, cpId: string) {
    const papel = papelCanonico(user?.role);
    if (isGlobal(papel)) return;
    if (papel !== 'proprietario') throw new ForbiddenException('Sem permissão para comandar esta estação.');
    const cp = await this.prisma.$queryRaw<Array<{ planta_id: string | null }>>`
      SELECT TRIM(planta_id) AS planta_id FROM ocpp_charge_points WHERE charge_point_id = ${String(cpId ?? '').trim()} LIMIT 1`;
    const plantaId = cp[0]?.planta_id;
    if (!plantaId) throw new ForbiddenException('Estação sem planta atribuída: só a equipe Aupus comanda.');
    await this.scope.assertEntityInScope('planta', plantaId, user);
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
    // Mesmo recorte da lista de estações: escopado só vê transação de CP da planta
    // dele. O filtro vai no SQL, antes do LIMIT (depois, a lista vinha curta ou vazia).
    const escopo = await this.scope.getScope(user);
    const plantas = this.scope.isScoped(escopo) ? escopo.map((x) => String(x).trim()) : null;
    const rows = await this.prisma.$queryRaw<Array<any>>`
      SELECT t.transaction_id, t.charge_point_id, t.connector_id, t.id_tag,
             TRIM(t.morador_id) AS morador_id, t.meter_start, t.meter_stop, t.energia_kwh,
             t.inicio, t.fim, t.motivo_fim, t.status, TRIM(cp.planta_id) AS planta_id
      FROM ocpp_transactions t
      LEFT JOIN ocpp_charge_points cp ON cp.charge_point_id = t.charge_point_id
      WHERE (${cpId || null}::text IS NULL OR t.charge_point_id = ${cpId || null})
        AND (${plantas === null}::boolean OR TRIM(cp.planta_id) = ANY(${plantas ?? []}::text[]))
      ORDER BY t.inicio DESC NULLS LAST
      LIMIT ${n}
    `;
    return { data: rows || [] };
  }

  /** Inicia recarga remotamente (CSMS → carregador). */
  @Post(':cpId/remote-start')
  async remoteStart(@Param('cpId') cpId: string, @Body() body: any, @CurrentUser() user: any) {
    await this.assertComandoRecarga(user, cpId);
    return { data: await this.svc.remoteStart(cpId, String(body?.idTag || ''), body?.connectorId ? Number(body.connectorId) : undefined) };
  }

  /** Para recarga remotamente. */
  @Post(':cpId/remote-stop')
  async remoteStop(@Param('cpId') cpId: string, @Body() body: any, @CurrentUser() user: any) {
    await this.assertComandoRecarga(user, cpId);
    return { data: await this.svc.remoteStop(cpId, Number(body?.transactionId)) };
  }

  /** Reinicia a estação (Soft/Hard). */
  @Post(':cpId/reset')
  async reset(@Param('cpId') cpId: string, @Body() body: any, @CurrentUser() user: any) {
    this.assertAdmin(user);
    return { data: await this.svc.reset(cpId, body?.type === 'Hard' ? 'Hard' : 'Soft') };
  }
}
