import { Body, Controller, Delete, ForbiddenException, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, PermissionScopeService, PrismaService, CurrentUser, ScopedUser } from '@aupus/api-shared';
import { NotificacaoService } from './notificacao.service';
import { EnvioAdminService, ConfigInput, DestinatarioInput } from './envio-admin.service';
import { NotificacaoDispatcherService } from './dispatcher.service';
import { WhatsappService } from './whatsapp.service';

/**
 * Notificações (Monitoramento FV) — FASE 0. Só leitura: lista de tipos + PREVIEW do
 * texto. NENHUM endpoint de envio existe aqui (envio real é Fase 2, com autorização).
 *
 * ⚠️ RBAC: o preview é por unidade/planta ALVO — antes de montar o texto, exige que o
 * usuário tenha escopo sobre esse alvo (assertEntityInScope). Sem isso um proprietário
 * poderia pré-visualizar a geração de usina de OUTRO dono. Admin/gerente (sem escopo)
 * passam direto.
 */
@ApiTags('Monitoramento FV — Notificações')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('monitoramento-fv/notificacao')
export class NotificacaoController {
  constructor(
    private readonly service: NotificacaoService,
    private readonly scope: PermissionScopeService,
    private readonly admin: EnvioAdminService,
    private readonly dispatcher: NotificacaoDispatcherService,
    private readonly whats: WhatsappService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('tipos')
  @ApiOperation({ summary: 'Lista os tipos de notificação registrados' })
  tipos() {
    return { data: this.service.listarTipos() };
  }

  @Get('preview')
  @ApiOperation({ summary: 'Preview do texto de um tipo (NÃO envia)' })
  async preview(
    @Query('tipo') tipo: string,
    @CurrentUser() user?: ScopedUser,
    @Query('unidadeId') unidadeId?: string,
    @Query('plantaId') plantaId?: string,
    @Query('proprietarioId') proprietarioId?: string,
    @Query('data') data?: string,
  ) {
    // RBAC: só pode pré-visualizar alvo que está no escopo do usuário.
    if (unidadeId?.trim()) await this.scope.assertEntityInScope('unidade', unidadeId.trim(), user);
    if (plantaId?.trim()) await this.scope.assertEntityInScope('planta', plantaId.trim(), user);
    // Boletim por dono: proprietário só pode ver o próprio; staff (escopo nulo) vê qualquer um.
    if (proprietarioId?.trim() && user?.role === 'proprietario' && proprietarioId.trim() !== user?.id) {
      throw new ForbiddenException('Você só pode pré-visualizar o boletim das suas próprias usinas.');
    }
    return { data: await this.service.preview(tipo, { unidadeId, plantaId, proprietarioId, data }) };
  }

  // ===== Envio (config + destinatários + disparo) — admin =====

  @Get('envio/config')
  @ApiOperation({ summary: 'Config do envio de boletim (admin)' })
  async getConfig(@CurrentUser() user?: ScopedUser) {
    this.admin.assertAdmin(user);
    return { data: await this.admin.getConfig() };
  }

  @Put('envio/config')
  @ApiOperation({ summary: 'Atualiza config do envio (admin)' })
  async putConfig(@Body() body: ConfigInput, @CurrentUser() user?: ScopedUser) {
    this.admin.assertAdmin(user);
    return { data: await this.admin.updateConfig(body) };
  }

  @Get('envio/grupos')
  @ApiOperation({ summary: 'Lista grupos de WhatsApp disponíveis (admin)' })
  async grupos(@CurrentUser() user?: ScopedUser) {
    this.admin.assertAdmin(user);
    return { data: await this.whats.listarGrupos() };
  }

  @Get('envio/unidades')
  @ApiOperation({ summary: 'Usinas cadastradas no sync (com provedor) p/ vincular destinatários (admin)' })
  async unidades(@CurrentUser() user?: ScopedUser) {
    this.admin.assertAdmin(user);
    // Só as usinas registradas pra sync (unidade_fv_config): o que não está em nenhuma
    // API/monitoramento não tem geração pra enviar.
    const rows = await this.prisma.$queryRaw`
      SELECT TRIM(c.unidade_id) AS id, TRIM(u.nome) AS nome,
             c.provedor_monitoramento AS provedor, c.ativo AS sync_ativo
      FROM unidade_fv_config c
      JOIN unidades u ON TRIM(u.id) = TRIM(c.unidade_id) AND u.deleted_at IS NULL
      ORDER BY u.nome
    `;
    return { data: rows };
  }

  @Get('envio/destinatarios')
  @ApiOperation({ summary: 'Lista destinatários do envio individual (admin)' })
  async listarDest(@CurrentUser() user?: ScopedUser) {
    this.admin.assertAdmin(user);
    return { data: await this.admin.listarDestinatarios() };
  }

  @Post('envio/destinatarios')
  @ApiOperation({ summary: 'Cria destinatário (admin)' })
  async criarDest(@Body() body: DestinatarioInput, @CurrentUser() user?: ScopedUser) {
    this.admin.assertAdmin(user);
    return { data: await this.admin.criarDestinatario(body) };
  }

  @Put('envio/destinatarios/:id')
  @ApiOperation({ summary: 'Atualiza destinatário (admin)' })
  async atualizarDest(@Param('id') id: string, @Body() body: DestinatarioInput, @CurrentUser() user?: ScopedUser) {
    this.admin.assertAdmin(user);
    return { data: await this.admin.atualizarDestinatario(id, body) };
  }

  @Delete('envio/destinatarios/:id')
  @ApiOperation({ summary: 'Remove destinatário (admin)' })
  async removerDest(@Param('id') id: string, @CurrentUser() user?: ScopedUser) {
    this.admin.assertAdmin(user);
    return { data: await this.admin.removerDestinatario(id) };
  }

  @Post('envio/disparar')
  @ApiOperation({ summary: 'Dispara o boletim. dryRun=true (default) só monta+audita; dryRun=false ENVIA de verdade (admin)' })
  async disparar(
    @Query('dryRun') dryRun?: string,
    @Query('data') data?: string,
    @CurrentUser() user?: ScopedUser,
  ) {
    this.admin.assertAdmin(user);
    const isDry = dryRun !== 'false'; // só envia real com dryRun=false explícito
    const alvo = data && /^\d{4}-\d{2}-\d{2}$/.test(data) ? data : this.hojeSP();
    return { data: await this.dispatcher.dispatch(alvo, { dryRun: isDry }) };
  }

  private hojeSP(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  }
}
