import { Body, Controller, ForbiddenException, Get, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard, CurrentUser } from '@/core';
import { BoletimConsumoService } from './boletim-consumo.service';
import { RelatoriosService } from './relatorios.service';
import { BoletimConsumoEnvioService, BoletimConsumoConfig } from './boletim-consumo-envio.service';

/**
 * Relatório de Gestão de Energia (CONSUMO) — POR UNIDADE. A partir das infos da
 * unidade (medidor M160/Power Meter + configuracao_demanda) monta o payload real.
 * Tudo owner-scoped (PermissionScopeService dentro do service).
 * PDF gerado pela MESMA via do de geração (RelatoriosService → gerador isolado).
 */
@Controller('relatorios/consumo')
@UseGuards(JwtAuthGuard)
export class RelatoriosConsumoController {
  constructor(
    private readonly consumo: BoletimConsumoService,
    private readonly relatorios: RelatoriosService,
    private readonly envio: BoletimConsumoEnvioService,
  ) {}

  private assertAdmin(user: any) {
    const role = String(user?.role || '').toLowerCase();
    if (!['super_admin', 'admin', 'gerente'].includes(role)) {
      throw new ForbiddenException('Apenas administradores.');
    }
  }

  /** Unidades elegíveis (têm medidor, mesmo off no momento) — pra popular o seletor. */
  @Get('unidades')
  async unidades(@CurrentUser() user: any) {
    return { data: await this.consumo.listarUnidadesElegiveis(user) };
  }

  // ===== Config do envio semanal do consumo (admin) =====
  @Get('config')
  async getConfig(@CurrentUser() user: any) {
    this.assertAdmin(user);
    return { data: await this.envio.getConfig() };
  }

  @Put('config')
  async putConfig(@Body() body: Partial<BoletimConsumoConfig>, @CurrentUser() user: any) {
    this.assertAdmin(user);
    return { data: await this.envio.updateConfig(body) };
  }

  /** Dispara o relatório de consumo. dryRun=true (default) só monta; dryRun=false ENVIA de verdade. */
  @Post('disparar')
  async disparar(@Query('dryRun') dryRun: string, @Query('data') data: string, @CurrentUser() user: any) {
    this.assertAdmin(user);
    const isDry = dryRun !== 'false';
    return { data: await this.envio.disparar(data || undefined, { dryRun: isDry }) };
  }

  /** Payload real (JSON) do relatório de consumo da unidade (semana anterior por padrão). */
  @Get('dados')
  async dados(
    @Query('unidadeId') unidadeId: string,
    @Query('data') data: string,
    @CurrentUser() user: any,
  ) {
    return { data: await this.consumo.montarPayload(unidadeId, data || undefined, user) };
  }

  /** PDF (ou HTML) do relatório de consumo da unidade — mesma via do de geração. */
  @Get('preview')
  async preview(
    @Query('unidadeId') unidadeId: string,
    @Query('data') data: string,
    @Query('formato') formato: string,
    @CurrentUser() user: any,
    @Res() res: Response,
  ) {
    const dados = await this.consumo.montarPayload(unidadeId, data || undefined, user);
    if (formato === 'pdf') {
      const pdf = await this.relatorios.gerarPdfConsumo(dados);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="relatorio-consumo.pdf"');
      res.send(pdf);
      return;
    }
    const html = await this.relatorios.gerarHtmlConsumo(dados);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  }
}
