import { Body, Controller, Delete, ForbiddenException, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, CurrentUser } from '@aupus/api-shared';
import { CarregadorEletricoService } from './carregador-eletrico.service';

/**
 * Carregador Elétrico — moradores, liberação (porteiro), sessões, pedir vaga,
 * estado (modal) e export mensal. Owner-scoped no service. Cadastro de moradores
 * exige admin; liberar/pedir-vaga é operação de portaria (qualquer autenticado no
 * escopo). Encerrar sessão NÃO é rota manual — vem da ingestão MQTT (desconexão).
 */
@Controller('carregador-eletrico')
@UseGuards(JwtAuthGuard)
export class CarregadorEletricoController {
  constructor(private readonly svc: CarregadorEletricoService) {}

  private assertAdmin(user: any) {
    const role = String(user?.role || '').toLowerCase();
    if (!['super_admin', 'admin', 'gerente'].includes(role)) throw new ForbiddenException('Apenas administradores.');
  }

  @Get('carregadores')
  async carregadores(@CurrentUser() user: any) {
    return { data: await this.svc.listarCarregadores(user) };
  }

  // ---- Moradores ----
  @Get('moradores')
  async moradores(@Query('plantaId') plantaId: string, @CurrentUser() user: any) {
    return { data: await this.svc.listarMoradores(user, plantaId || undefined) };
  }
  @Post('moradores')
  async salvarMorador(@Body() body: any, @CurrentUser() user: any) {
    this.assertAdmin(user);
    return { data: await this.svc.salvarMorador(body, user) };
  }
  @Delete('moradores/:id')
  async removerMorador(@Param('id') id: string, @CurrentUser() user: any) {
    this.assertAdmin(user);
    return { data: await this.svc.removerMorador(id, user) };
  }

  // ---- Operação (portaria) ----
  @Post(':id/liberar')
  async liberar(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any) {
    return { data: await this.svc.liberarRecarga(id, String(body?.morador_id || '').trim(), user) };
  }
  @Post(':id/pedir-vaga')
  async pedirVaga(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any) {
    return { data: await this.svc.pedirVaga(id, String(body?.morador_id || '').trim(), user) };
  }

  // ---- Sessões / estado ----
  @Get('sessoes')
  async sessoes(@Query('carregadorId') carregadorId: string, @Query('limite') limite: string, @CurrentUser() user: any) {
    return { data: await this.svc.listarSessoes(user, carregadorId || undefined, Number(limite) || 100) };
  }
  @Get(':id/estado')
  async estado(@Param('id') id: string, @CurrentUser() user: any) {
    return { data: await this.svc.getEstado(id, user) };
  }

  // ---- Export mensal ----
  @Get('export')
  async exportar(@Query('mes') mes: string, @Query('plantaId') plantaId: string, @CurrentUser() user: any) {
    return { data: await this.svc.exportarMensal(mes, user, plantaId || undefined) };
  }
}
