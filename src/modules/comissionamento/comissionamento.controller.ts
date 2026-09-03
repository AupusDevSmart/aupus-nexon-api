import { Body, Controller, Delete, ForbiddenException, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, CurrentUser } from '@/core';
import { ComissionamentoService } from './comissionamento.service';

/**
 * Comissionamento de pontos IoT (Fase 0) — checks de coerência + registro de aceite.
 * Owner-scoped no service. Listar/preview: qualquer autenticado no escopo; comissionar
 * (sign-off): admin. Ver docs/IOT-NEXON-CONFIABILIDADE.md §3.2.
 */
@Controller('comissionamento')
@UseGuards(JwtAuthGuard)
export class ComissionamentoController {
  constructor(private readonly svc: ComissionamentoService) {}

  private assertAdmin(user: any) {
    const role = String(user?.role || '').toLowerCase();
    if (!['super_admin', 'admin', 'gerente'].includes(role)) {
      throw new ForbiddenException('Apenas administradores comissionam pontos.');
    }
  }

  /** Lista pontos (mqtt_habilitado) com o status de comissionamento. */
  @Get()
  async listar(
    @Query('plantaId') plantaId: string,
    @Query('unidadeId') unidadeId: string,
    @CurrentUser() user: any,
  ) {
    return { data: await this.svc.listar(user, plantaId || undefined, unidadeId || undefined) };
  }

  /** Equipamentos fantasma (mqtt fora do diagrama, sem feed) — pra revisar/excluir. */
  @Get('orfaos')
  async orfaos(@Query('unidadeId') unidadeId: string, @CurrentUser() user: any) {
    return { data: await this.svc.listarOrfaos(user, unidadeId || undefined) };
  }

  /** Registro armazenado + preview dos checks ao vivo de um ponto. */
  @Get(':equipamentoId')
  async status(@Param('equipamentoId') equipamentoId: string, @CurrentUser() user: any) {
    return { data: await this.svc.status(equipamentoId, user) };
  }

  /** Sign-off (admin). Bloqueia em 'falha' sem body.forcar. */
  @Post(':equipamentoId/comissionar')
  async comissionar(@Param('equipamentoId') equipamentoId: string, @Body() body: any, @CurrentUser() user: any) {
    this.assertAdmin(user);
    return { data: await this.svc.comissionar(equipamentoId, user, body || {}) };
  }

  /** Anexa uma foto de PROVA (data URL base64) ao comissionamento. Admin. */
  @Post(':equipamentoId/foto')
  async adicionarFoto(@Param('equipamentoId') equipamentoId: string, @Body() body: any, @CurrentUser() user: any) {
    this.assertAdmin(user);
    return { data: await this.svc.adicionarFoto(equipamentoId, user, body || {}) };
  }

  /** Remove uma foto de prova (por url). Admin. */
  @Delete(':equipamentoId/foto')
  async removerFoto(@Param('equipamentoId') equipamentoId: string, @Body() body: any, @CurrentUser() user: any) {
    this.assertAdmin(user);
    return { data: await this.svc.removerFoto(equipamentoId, user, String(body?.url || '')) };
  }
}
