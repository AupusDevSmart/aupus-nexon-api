import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, PermissionScopeService, CurrentUser, ScopedUser } from '@/core';
import { MonitoramentoSyncService } from './sync.service';
import { MonitoramentoSyncHorarioService } from './sync-horario.service';

/**
 * Sync manual das APIs de nuvem → `geracao_diaria_plantas`. SÓ trigger manual (sem cron
 * — o cron das 21h ainda é do bdo-aupus-api durante a transição). Lê das nuvens e grava
 * na nossa tabela; NÃO envia nada.
 *
 * ⚠️ RBAC: as leituras do painel FV (geracao-dia/resumo/registros) SÃO escopadas por dono
 * via PermissionScopeService — proprietário só vê as usinas dele. Sem isso vaza geração de
 * todas as plantas (mesmo mecanismo do COA principal: coa.service + getScope).
 */
@ApiTags('Monitoramento FV — Sync')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('monitoramento-fv')
export class MonitoramentoController {
  constructor(
    private readonly sync: MonitoramentoSyncService,
    private readonly syncHorario: MonitoramentoSyncHorarioService,
    private readonly scope: PermissionScopeService,
  ) {}

  @Post('sync')
  @ApiOperation({ summary: 'Dispara sync das nuvens → geracao_diaria_plantas (manual, ?data=YYYY-MM-DD)' })
  async syncManual(@Query('data') data?: string) {
    return { data: await this.sync.syncAll(data) };
  }

  @Post('sync-horario')
  @ApiOperation({ summary: 'Dispara snapshot horário do acumulado → geracao_horaria_plantas (manual)' })
  async syncHorarioManual() {
    return { data: await this.syncHorario.snapshotTodos() };
  }

  @Get('geracao-dia')
  @ApiOperation({ summary: 'Geração consolidada do dia (realizado × meta × %) por unidade, p/ o COA' })
  async geracaoDia(@Query('data') data?: string, @CurrentUser() user?: ScopedUser) {
    const scope = await this.scope.getScope(user);
    return { data: await this.sync.listarGeracaoDia(data, scope) };
  }

  @Get('resumo')
  @ApiOperation({ summary: 'Resumo do parque FV (KPIs hoje + ranking + série diária) p/ o painel do COA' })
  async resumo(@Query('dias') dias?: string, @CurrentUser() user?: ScopedUser) {
    const scope = await this.scope.getScope(user);
    return { data: await this.sync.getResumo(dias ? Number(dias) : 30, scope) };
  }

  @Get('registros')
  @ApiOperation({ summary: 'Registros diários crus (por unidade, últimos N meses) p/ filtro/agregação no front' })
  async registros(@Query('meses') meses?: string, @CurrentUser() user?: ScopedUser) {
    const scope = await this.scope.getScope(user);
    return { data: await this.sync.getRegistros(meses ? Number(meses) : 12, scope) };
  }
}
