import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, CurrentUser, Cliente, ExportacaoAuditoriaService } from '@/core';
import type { ClienteInfo } from '@/core';
import { CarregadorEletricoService } from './carregador-eletrico.service';
import { CarregadorGestaoService } from './carregador-gestao.service';

/**
 * Carregador Elétrico — moradores, liberação, sessões, pedir vaga, estado (modal),
 * valor do kWh e export mensal. Owner-scoped no service. Perfis no service:
 * analista (valor do kWh), proprietário (moradores, export) e morador (só a própria
 * recarga). Encerrar também vem da ingestão MQTT (desconexão).
 *
 * Carregador ligado por OCPP (NEXON-130): as mesmas rotas de iniciar/parar/estado, mais
 * limites de uso, comandos, conexão e parâmetros (CarregadorGestaoService). Contrato em
 * NexON/docs/carregador/API-CARREGADOR-OCPP.md.
 */
@Controller('carregador-eletrico')
@UseGuards(JwtAuthGuard)
export class CarregadorEletricoController {
  constructor(
    private readonly svc: CarregadorEletricoService,
    private readonly exportacoes: ExportacaoAuditoriaService,
    private readonly gestao: CarregadorGestaoService,
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

  // ---- Configuração (valor do kWh e corrente máxima: só analista; limites de uso: também o proprietário) ----
  @Put(':id/config')
  async salvarConfig(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any, @Cliente() cliente?: ClienteInfo) {
    const b = body ?? {};
    const temLimite = ['limite_tempo_min', 'limite_energia_kwh', 'inicio_automatico', 'limite_corrente_a'].some((k) => b[k] !== undefined);
    const data: Record<string, unknown> = {};
    if (b.tarifa_kwh !== undefined || !temLimite) Object.assign(data, await this.svc.salvarConfig(id, b, user, cliente));
    if (temLimite) Object.assign(data, await this.gestao.salvarLimites(id, b, user, cliente));
    return { data };
  }

  // ---- Operação (portaria) ----
  @Post(':id/liberar')
  async liberar(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any, @Cliente() cliente?: ClienteInfo) {
    return {
      data: await this.svc.liberarRecarga(id, String(body?.morador_id || '').trim(), user, {
        limiteTempoMin: body?.limite_tempo_min, limiteEnergiaKwh: body?.limite_energia_kwh, cliente,
      }),
    };
  }
  @Post(':id/parar')
  async parar(@Param('id') id: string, @CurrentUser() user: any, @Cliente() cliente?: ClienteInfo) {
    return { data: await this.svc.pararRecarga(id, user, cliente) };
  }
  /** Bloquear, liberar, destravar, reiniciar e atualizar a leitura (carregador OCPP). */
  @Post(':id/comando')
  async comando(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any, @Cliente() cliente?: ClienteInfo) {
    return { data: await this.gestao.comando(id, body?.comando, user, cliente) };
  }

  // ---- Conexão OCPP e parâmetros do equipamento (Admin e analistas) ----
  @Get(':id/ocpp')
  async conexao(@Param('id') id: string, @CurrentUser() user: any) {
    return { data: await this.gestao.conexao(id, user) };
  }
  @Put(':id/ocpp')
  async vincular(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any, @Cliente() cliente?: ClienteInfo) {
    return { data: await this.gestao.vincular(id, body ?? {}, user, cliente) };
  }
  @Post(':id/ocpp/chave')
  async novaChave(@Param('id') id: string, @CurrentUser() user: any, @Cliente() cliente?: ClienteInfo) {
    return { data: await this.gestao.novaChave(id, user, cliente) };
  }
  @Delete(':id/ocpp')
  async desvincular(@Param('id') id: string, @CurrentUser() user: any, @Cliente() cliente?: ClienteInfo) {
    return { data: await this.gestao.desvincular(id, user, cliente) };
  }
  @Get(':id/ocpp/parametros')
  async parametros(@Param('id') id: string, @CurrentUser() user: any) {
    return { data: await this.gestao.parametros(id, user) };
  }
  @Put(':id/ocpp/parametros')
  async mudarParametro(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any, @Cliente() cliente?: ClienteInfo) {
    return { data: await this.gestao.mudarParametro(id, body ?? {}, user, cliente) };
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
