import { Body, Controller, ForbiddenException, Get, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard, CurrentUser } from '@/core';
import { RelatoriosService } from './relatorios.service';
import { BoletimSemanalService } from './boletim-semanal.service';
import { BoletimSemanalEnvioService, BoletimSemanalConfig } from './boletim-semanal-envio.service';

@Controller('relatorios/semanal')
@UseGuards(JwtAuthGuard)
export class RelatoriosController {
  constructor(
    private readonly service: RelatoriosService,
    private readonly boletim: BoletimSemanalService,
    private readonly envio: BoletimSemanalEnvioService,
  ) {}

  private assertAdmin(user: any) {
    const role = String(user?.role || '').toLowerCase();
    if (!['super_admin', 'admin', 'gerente'].includes(role)) {
      throw new ForbiddenException('Apenas administradores.');
    }
  }

  // ===== Config do envio semanal (admin) =====
  @Get('config')
  async getConfig(@CurrentUser() user: any) {
    this.assertAdmin(user);
    return { data: await this.envio.getConfig() };
  }

  @Put('config')
  async putConfig(@Body() body: Partial<BoletimSemanalConfig>, @CurrentUser() user: any) {
    this.assertAdmin(user);
    return { data: await this.envio.updateConfig(body) };
  }

  /** Dispara o boletim semanal. dryRun=true (default) só monta; dryRun=false ENVIA de verdade. */
  @Post('disparar')
  async disparar(@Query('dryRun') dryRun: string, @Query('data') data: string, @CurrentUser() user: any) {
    this.assertAdmin(user);
    const isDry = dryRun !== 'false';
    return { data: await this.envio.disparar(data || undefined, { dryRun: isDry }) };
  }

  /** Payload real (JSON) do boletim — pra inspecionar os dados antes/independente do PDF. */
  @Get('dados')
  async dados(
    @Query('unidadeId') unidadeId: string,
    @Query('data') data: string,
    @CurrentUser() user: any,
  ) {
    return this.boletim.montarPayload(unidadeId, data, user);
  }

  /**
   * Preview do boletim semanal. Com `?unidadeId=` usa DADOS REAIS (semana anterior);
   * sem, cai nos dados de exemplo. `?formato=pdf` devolve o PDF; senão, o HTML.
   */
  @Get('preview')
  async preview(
    @Query('formato') formato: string,
    @Query('unidadeId') unidadeId: string,
    @Query('data') data: string,
    @CurrentUser() user: any,
    @Res() res: Response,
  ) {
    const dados = unidadeId
      ? await this.boletim.montarPayload(unidadeId, data, user)
      : await this.service.dadosExemplo();
    if (formato === 'pdf') {
      const pdf = await this.service.gerarPdf(dados);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="boletim-semanal.pdf"');
      res.send(pdf);
      return;
    }
    const html = await this.service.gerarHtml(dados);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  }
}
