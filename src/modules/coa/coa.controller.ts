import { Controller, Get, Query, UseGuards, HttpCode, HttpStatus, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { CoaService, DashboardData } from './coa.service';
import { JwtAuthGuard } from '@aupus/api-shared';
import { UserProprietarioId } from '@aupus/api-shared';

@ApiTags('COA - Centro de Operações')
@Controller('coa')
@UseGuards(JwtAuthGuard)
export class CoaController {
  private readonly logger = new Logger(CoaController.name);

  constructor(private readonly coaService: CoaService) {}

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
    @UserProprietarioId() autoProprietarioId?: string | null
  ): Promise<DashboardData> {
    const effectiveClienteId = autoProprietarioId || clienteId;
    this.logger.log(`[COA Controller] GET /dashboard - autoProprietarioId: ${autoProprietarioId}, clienteId: ${clienteId}, effective: ${effectiveClienteId}`);
    const result = await this.coaService.getDashboardData(effectiveClienteId);
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
    @UserProprietarioId() autoProprietarioId?: string | null
  ): Promise<DashboardData> {
    const effectiveClienteId = autoProprietarioId || clienteId;
    return this.coaService.refreshCache(effectiveClienteId);
  }
}