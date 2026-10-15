import { Controller, Get, Param, Query, UseGuards, HttpCode, HttpStatus, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { CoaService, DashboardData } from './coa.service';
import { JwtAuthGuard } from '@/core';
import { UserProprietarioId, CurrentUser, Cliente, ExportacaoAuditoriaService } from '@/core';
import type { ClienteInfo } from '@/core';

@ApiTags('COA - Centro de Operações')
@Controller('coa')
@UseGuards(JwtAuthGuard)
export class CoaController {
  private readonly logger = new Logger(CoaController.name);

  constructor(
    private readonly coaService: CoaService,
    private readonly exportacoes: ExportacaoAuditoriaService,
  ) {}

  @Get('dashboard')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Obter dados do dashboard COA',
    description: 'Retorna dados agregados das plantas e unidades. Usuários não-admin veem apenas seus dados.'
  })
  @ApiQuery({
    name: 'clienteId',
    required: false,
    description: 'ID do cliente para filtrar dados (admin only)',
    type: String
  })
  @ApiResponse({
    status: 200,
    description: 'Dados do dashboard retornados com sucesso'
  })
  async getDashboardData(
    @Query('clienteId') clienteId?: string,
    @UserProprietarioId() autoProprietarioId?: string | null,
    @CurrentUser() user?: any,
  ): Promise<DashboardData> {
    const effectiveClienteId = autoProprietarioId || clienteId;
    this.logger.log(`[COA Controller] GET /dashboard - autoProprietarioId: ${autoProprietarioId}, clienteId: ${clienteId}, effective: ${effectiveClienteId}`);
    const result = await this.coaService.getDashboardData(effectiveClienteId, user);
    this.logger.log(`[COA Controller] Dashboard data returned - ${result.plantas.length} plantas, ${result.resumoGeral.totalUnidades} unidades`);
    return result;
  }

  @Get('dashboard/refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Forçar atualização do cache',
    description: 'Remove o cache e busca dados frescos do banco de dados. Usuários não-admin veem apenas seus dados.'
  })
  @ApiQuery({
    name: 'clienteId',
    required: false,
    description: 'ID do cliente para filtrar dados (admin only)',
    type: String
  })
  @ApiResponse({
    status: 200,
    description: 'Cache atualizado e dados retornados'
  })
  async refreshDashboard(
    @Query('clienteId') clienteId?: string,
    @UserProprietarioId() autoProprietarioId?: string | null,
    @CurrentUser() user?: any,
  ): Promise<DashboardData> {
    const effectiveClienteId = autoProprietarioId || clienteId;
    return this.coaService.refreshCache(effectiveClienteId, user);
  }

  @Get('unidades/:unidadeId/geracao')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Histórico de geração da unidade (dia/mês/ano/total)',
    description: 'Série para o gráfico estilo portal do provedor. Fonte: snapshots de nuvem (horário) e fechamento diário. Escopado por dono.',
  })
  async historicoGeracao(
    @Param('unidadeId') unidadeId: string,
    @Query('periodo') periodo?: string,
    @Query('data') data?: string,
    @CurrentUser() user?: any,
    @Cliente() cliente?: ClienteInfo,
  ) {
    // Alimenta o gráfico (recarrega a cada 5 min) e o CSV montado no front: audita só a recusa.
    return this.exportacoes.executar(
      { user, cliente, tipo: 'geracao', unidadeIds: [unidadeId], periodo: { periodo: periodo ?? null, data: data ?? null } },
      () => this.coaService.historicoGeracao(unidadeId, periodo, data, user),
      { registrarSucesso: false },
    );
  }
}