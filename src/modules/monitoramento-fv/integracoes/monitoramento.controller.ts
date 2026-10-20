import { Body, Controller, Delete, ForbiddenException, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, Permissions, PermissionScopeService, CurrentUser, ScopedUser } from '@/core';
import { MonitoramentoSyncService } from './sync.service';
import { MonitoramentoSyncHorarioService } from './sync-horario.service';
import { FusionInverterFallbackService } from './fusion-inverter-fallback.service';
import { isGlobal, papelCanonico } from '@/core/modules/auth/papeis';

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
    private readonly invFallback: FusionInverterFallbackService,
    private readonly scope: PermissionScopeService,
  ) {}

  /** Operador (PER-40): geração só das instalações com "Ver geração". `null` = sem recorte. */
  private async unidadesGeracao(user?: ScopedUser): Promise<string[] | null> {
    const a = await this.scope.acessoPorEquipamento(user);
    return a ? [...a.verGeracao] : null;
  }

  /** Sync mexe em todas as usinas: só equipe Aupus dispara. */
  private exigirEquipe(user?: ScopedUser) {
    if (user && !isGlobal(papelCanonico(user.role))) throw new ForbiddenException('Recurso fora do escopo do usuario');
  }

  @Post('sync')
  @ApiOperation({ summary: 'Dispara sync das nuvens → geracao_diaria_plantas (manual, ?data=YYYY-MM-DD)' })
  async syncManual(@Query('data') data?: string, @CurrentUser() user?: ScopedUser) {
    this.exigirEquipe(user);
    return { data: await this.sync.syncAll(data) };
  }

  @Post('sync-horario')
  @ApiOperation({ summary: 'Dispara snapshot horário do acumulado → geracao_horaria_plantas (manual)' })
  async syncHorarioManual(@CurrentUser() user?: ScopedUser) {
    this.exigirEquipe(user);
    return { data: await this.syncHorario.snapshotTodos() };
  }

  @Get('geracao-dia')
  @ApiOperation({ summary: 'Geração consolidada do dia (realizado × meta × %) por unidade, p/ o COA' })
  async geracaoDia(@Query('data') data?: string, @CurrentUser() user?: ScopedUser) {
    const scope = await this.scope.getScope(user);
    return { data: await this.sync.listarGeracaoDia(data, scope, await this.unidadesGeracao(user)) };
  }

  @Get('resumo')
  @ApiOperation({ summary: 'Resumo do parque FV (KPIs hoje + ranking + série diária) p/ o painel do COA' })
  async resumo(@Query('dias') dias?: string, @CurrentUser() user?: ScopedUser) {
    const scope = await this.scope.getScope(user);
    return { data: await this.sync.getResumo(dias ? Number(dias) : 30, scope, await this.unidadesGeracao(user)) };
  }

  @Get('registros')
  @ApiOperation({ summary: 'Registros diários crus (por unidade, últimos N meses) p/ filtro/agregação no front' })
  async registros(@Query('meses') meses?: string, @CurrentUser() user?: ScopedUser) {
    const scope = await this.scope.getScope(user);
    return { data: await this.sync.getRegistros(meses ? Number(meses) : 12, scope, await this.unidadesGeracao(user)) };
  }

  // --- Fallback por-inversor (nuvem Fusion → modal "Dados em Tempo Real") ---

  @Post('inversores-nuvem/sync')
  @Permissions('equipamentos.manage')
  @ApiOperation({ summary: 'Dispara o fallback por-inversor Fusion (grava nuvem onde a TON está obsoleta)' })
  async syncInversoresNuvem() {
    return { data: await this.invFallback.runFallback() };
  }

  @Get('inversores-nuvem/dispositivos')
  @Permissions('equipamentos.manage')
  @ApiOperation({ summary: 'Lista inversores Huawei da planta + candidatos NexON + mapa atual (config, ?unidadeId=)' })
  async dispositivos(@Query('unidadeId') unidadeId: string, @CurrentUser() user?: ScopedUser) {
    return { data: await this.invFallback.listarDispositivos(unidadeId, user) };
  }

  @Post('inversores-nuvem/mapa')
  @Permissions('equipamentos.manage')
  @ApiOperation({ summary: 'Vincula um inversor (equipamento) a um device Huawei { equipamentoId, deviceId }' })
  async salvarMapa(
    @Body() body: { equipamentoId: string; deviceId: string },
    @CurrentUser() user?: ScopedUser,
  ) {
    return { data: await this.invFallback.salvarMapa(body.equipamentoId, body.deviceId, user) };
  }

  @Delete('inversores-nuvem/mapa')
  @Permissions('equipamentos.manage')
  @ApiOperation({ summary: 'Remove o vínculo nuvem de um inversor (?equipamentoId=)' })
  async removerMapa(@Query('equipamentoId') equipamentoId: string, @CurrentUser() user?: ScopedUser) {
    return { data: await this.invFallback.removerMapa(equipamentoId, user) };
  }
}
