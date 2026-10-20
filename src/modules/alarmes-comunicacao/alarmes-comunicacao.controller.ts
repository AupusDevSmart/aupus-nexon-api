import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser, ScopedUser } from '@/core';
import { AlarmesComunicacaoService, ConfigAlarmes } from './alarmes-comunicacao.service';

/** Config dos alarmes de comunicação (admin): limiares, janela do inversor, resumo diário, destinatários por usina. */
@ApiTags('Alarmes de comunicação')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('alarmes-comunicacao')
export class AlarmesComunicacaoController {
  constructor(private readonly svc: AlarmesComunicacaoService) {}

  @Get('config')
  @ApiOperation({ summary: 'Config dos alarmes de comunicação (admin)' })
  async getConfig(@CurrentUser() user?: ScopedUser) {
    this.svc.assertEquipe(user);
    return { data: await this.svc.getConfig() };
  }

  @Put('config')
  @ApiOperation({ summary: 'Atualiza a config (admin)' })
  async putConfig(@Body() body: Partial<ConfigAlarmes>, @CurrentUser() user?: ScopedUser) {
    this.svc.assertAdmin(user);
    return { data: await this.svc.updateConfig(body ?? {}) };
  }

  @Get('destinatarios')
  @ApiOperation({ summary: 'E-mails que recebem os alarmes de cada usina (admin)' })
  async listar(@CurrentUser() user?: ScopedUser) {
    this.svc.assertEquipe(user);
    return { data: await this.svc.listarDestinatarios() };
  }

  @Post('destinatarios')
  @ApiOperation({ summary: 'Adiciona e-mail a uma usina (admin)' })
  async adicionar(@Body() body: { planta_id: string; email: string; nome?: string }, @CurrentUser() user?: ScopedUser) {
    this.svc.assertAdmin(user);
    return { data: await this.svc.adicionarDestinatario(body?.planta_id, body?.email, body?.nome) };
  }

  @Delete('destinatarios/:id')
  @ApiOperation({ summary: 'Remove um destinatário (admin)' })
  async remover(@Param('id') id: string, @CurrentUser() user?: ScopedUser) {
    this.svc.assertAdmin(user);
    return { data: await this.svc.removerDestinatario(id) };
  }

  @Get('unidades-desativadas')
  @ApiOperation({ summary: 'Unidades fora do monitoramento de comunicação (admin)' })
  async unidadesDesativadas(@CurrentUser() user?: ScopedUser) {
    this.svc.assertEquipe(user);
    return { data: await this.svc.listarUnidadesDesativadas() };
  }

  @Put('unidade/:unidadeId')
  @ApiOperation({ summary: 'Tirar (motivo) ou devolver (motivo null) uma unidade ao monitoramento (admin)' })
  async definirUnidade(
    @Param('unidadeId') id: string,
    @Body() body: { motivo?: 'retirado' | 'api' | 'outro' | null; observacao?: string | null },
    @CurrentUser() user?: ScopedUser,
  ) {
    this.svc.assertEquipe(user);
    return { data: await this.svc.definirUnidade(id, body?.motivo ?? null, body?.observacao, user) };
  }

  @Put('limiar/:equipamentoId')
  @ApiOperation({ summary: 'Limiar próprio (min) ou ignorar um equipamento (admin)' })
  async limiar(@Param('equipamentoId') id: string, @Body() body: { limiar_min?: number | null; ignorar?: boolean }, @CurrentUser() user?: ScopedUser) {
    this.svc.assertEquipe(user);
    return { data: await this.svc.definirLimiar(id, body?.limiar_min ?? null, !!body?.ignorar) };
  }

  @Get('abertos')
  @ApiOperation({ summary: 'Alarmes de comunicação abertos + ignorados (admin)' })
  async abertos(@CurrentUser() user?: ScopedUser) {
    this.svc.assertEquipe(user);
    return { data: await this.svc.listarAbertos() };
  }

  @Put('ignorar/:equipamentoId')
  @ApiOperation({ summary: 'Ignorar (ou voltar a monitorar) a comunicação de um equipamento (admin)' })
  async ignorar(@Param('equipamentoId') id: string, @Body() body: { ignorar?: boolean }, @CurrentUser() user?: ScopedUser) {
    this.svc.assertEquipe(user);
    return { data: await this.svc.ignorar(id, body?.ignorar !== false, user) };
  }

  @Post('resumo')
  @ApiOperation({ summary: 'Pré-visualiza (dryRun=true, padrão) ou envia agora o resumo diário (admin)' })
  async resumo(@Query('dryRun') dryRun?: string, @CurrentUser() user?: ScopedUser) {
    // Pré-visualizar é da equipe; enviar de verdade, só admin.
    if (dryRun === 'false') this.svc.assertAdmin(user);
    else this.svc.assertEquipe(user);
    return { data: await this.svc.enviarResumo(dryRun !== 'false') };
  }
}
