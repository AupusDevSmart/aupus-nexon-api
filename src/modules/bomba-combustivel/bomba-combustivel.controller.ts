import { Body, Controller, Delete, ForbiddenException, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, CurrentUser } from '@/core';
import { BombaCombustivelService } from './bomba-combustivel.service';

/**
 * Posto de Combustível — tags RFID (máquinas), operadores (matrículas), lista de
 * autorizados (→ TON), config, abastecimentos, eventos e estado (modal/relatório).
 * Tudo owner-scoped no service. Mutações de cadastro exigem admin.
 */
@Controller('bomba-combustivel')
@UseGuards(JwtAuthGuard)
export class BombaCombustivelController {
  constructor(private readonly svc: BombaCombustivelService) {}

  private assertAdmin(user: any) {
    const role = String(user?.role || '').toLowerCase();
    if (!['super_admin', 'admin', 'gerente'].includes(role)) throw new ForbiddenException('Apenas administradores.');
  }

  @Get('bombas')
  async bombas(@CurrentUser() user: any) {
    return { data: await this.svc.listarBombas(user) };
  }

  // ---- tags (máquinas) ----
  @Get('rfid')
  async listarRfid(@Query('bombaId') bombaId: string, @CurrentUser() user: any) {
    return { data: await this.svc.listarRfid(user, bombaId || undefined) };
  }
  @Post('rfid')
  async salvarRfid(@Body() body: any, @CurrentUser() user: any) {
    this.assertAdmin(user);
    return { data: await this.svc.salvarRfid(body, user) };
  }
  @Delete('rfid/:id')
  async removerRfid(@Param('id') id: string, @CurrentUser() user: any) {
    this.assertAdmin(user);
    return { data: await this.svc.removerRfid(id, user) };
  }

  // ---- operadores (matrículas) ----
  @Get('operadores')
  async listarOperadores(@Query('bombaId') bombaId: string, @CurrentUser() user: any) {
    return { data: await this.svc.listarOperadores(user, bombaId || undefined) };
  }
  @Post('operadores')
  async salvarOperador(@Body() body: any, @CurrentUser() user: any) {
    this.assertAdmin(user);
    return { data: await this.svc.salvarOperador(body, user) };
  }
  @Delete('operadores/:id')
  async removerOperador(@Param('id') id: string, @CurrentUser() user: any) {
    this.assertAdmin(user);
    return { data: await this.svc.removerOperador(id, user) };
  }

  // ---- transações / eventos / estado ----
  @Get('abastecimentos')
  async abastecimentos(@Query('bombaId') bombaId: string, @Query('limite') limite: string, @CurrentUser() user: any) {
    return { data: await this.svc.listarAbastecimentos(user, bombaId || undefined, Number(limite) || 100) };
  }
  @Get(':id/eventos')
  async eventos(@Param('id') id: string, @Query('limite') limite: string, @CurrentUser() user: any) {
    return { data: await this.svc.listarEventos(user, id, Number(limite) || 50) };
  }
  @Get(':id/estado')
  async estado(@Param('id') id: string, @CurrentUser() user: any) {
    return { data: await this.svc.getEstado(id, user) };
  }
  @Get(':id/lista')
  async lista(@Param('id') id: string, @CurrentUser() user: any) {
    await this.svc.getConfig(id, user);   // só pelo escopo
    return { data: await this.svc.montarLista(id) };
  }

  // ---- config ----
  @Get(':id/config')
  async getConfig(@Param('id') id: string, @CurrentUser() user: any) {
    return { data: await this.svc.getConfig(id, user) };
  }
  @Put(':id/config')
  async putConfig(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any) {
    this.assertAdmin(user);
    return { data: await this.svc.salvarConfig(id, body, user) };
  }

  // ---- lista → TON ----
  @Post(':id/whitelist/publicar')
  async publicar(@Param('id') id: string, @CurrentUser() user: any) {
    this.assertAdmin(user);
    await this.svc.getConfig(id, user);   // escopo
    return { data: await this.svc.publicarWhitelist(id) };
  }
}
