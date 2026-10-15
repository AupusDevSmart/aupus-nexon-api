import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, CurrentUser, Cliente, ExportacaoAuditoriaService } from '@/core';
import type { ClienteInfo } from '@/core';
import { CarregadorEletricoService } from './carregador-eletrico.service';

/**
 * Carregador Elétrico — moradores, liberação, sessões, pedir vaga, estado (modal),
 * valor do kWh e export mensal. Owner-scoped no service. Perfis no service:
 * analista (valor do kWh), proprietário (moradores, export) e morador (só a própria
 * recarga). Encerrar também vem da ingestão MQTT (desconexão).
 */
@Controller('carregador-eletrico')
@UseGuards(JwtAuthGuard)
export class CarregadorEletricoController {
  constructor(
    private readonly svc: CarregadorEletricoService,
    private readonly exportacoes: ExportacaoAuditoriaService,
  ) {}

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
    return { data: await this.svc.salvarMorador(body, user) };
  }
  @Delete('moradores/:id')
  async removerMorador(@Param('id') id: string, @CurrentUser() user: any) {
    return { data: await this.svc.removerMorador(id, user) };
  }

  // ---- Configuração (valor do kWh: só analista) ----
  @Put(':id/config')
  async salvarConfig(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any) {
    return { data: await this.svc.salvarConfig(id, body ?? {}, user) };
  }

  // ---- Operação (portaria) ----
  @Post(':id/liberar')
  async liberar(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any) {
    return { data: await this.svc.liberarRecarga(id, String(body?.morador_id || '').trim(), user) };
  }
  @Post(':id/parar')
  async parar(@Param('id') id: string, @CurrentUser() user: any) {
    return { data: await this.svc.pararRecarga(id, user) };
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
  async exportar(
    @Query('mes') mes: string,
    @Query('plantaId') plantaId: string,
    @CurrentUser() user: any,
    @Cliente() cliente?: ClienteInfo,
  ) {
    const data = await this.exportacoes.executar(
      { user, cliente, tipo: 'carregador', plantaIds: plantaId ? [plantaId] : [], periodo: { mes }, formato: 'csv' },
      () => this.svc.exportarMensal(mes, user, plantaId || undefined),
      {
        resumo: (r) => ({
          linhas: r.linhas.length,
          plantaIds: plantaId ? [plantaId] : r.linhas.map((l: any) => l.planta_id),
        }),
      },
    );
    return { data };
  }
}
