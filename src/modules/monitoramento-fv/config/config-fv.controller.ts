import { Body, Controller, Delete, Get, Put, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser, ScopedUser } from '@aupus/api-shared';
import { ConfigFvService, ConfigFvInput } from './config-fv.service';

/**
 * Tela de Controle do sync de nuvem FV: gerencia `unidade_fv_config` (usinas, provedor,
 * periodicidade, on/off) com o teto de 2000 req/h por provedor imposto. RBAC:
 * super_admin/admin/analista.
 */
@ApiTags('Monitoramento FV — Controle de sync')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('monitoramento-fv/config')
export class ConfigFvController {
  constructor(private readonly service: ConfigFvService) {}

  @Get()
  @ApiOperation({ summary: 'Configs de sync + budget de req/h por provedor' })
  async listar(@CurrentUser() user?: ScopedUser) {
    this.service.assertEditor(user);
    return { data: await this.service.listar() };
  }

  @Get('unidades-disponiveis')
  @ApiOperation({ summary: 'Unidades FV ainda sem config (p/ adicionar)' })
  async disponiveis(@CurrentUser() user?: ScopedUser) {
    this.service.assertEditor(user);
    return { data: await this.service.unidadesDisponiveis() };
  }

  @Get('plantas-provedor')
  @ApiOperation({ summary: 'Lista as plantas do provedor via API (p/ seletor, em vez de digitar o ID)' })
  async plantasProvedor(@Query('provedor') provedor: string, @CurrentUser() user?: ScopedUser) {
    this.service.assertEditor(user);
    return { data: await this.service.listarPlantasProvedor(provedor) };
  }

  @Put()
  @ApiOperation({ summary: 'Cria/atualiza config (valida teto 2000/h)' })
  async upsert(@Body() body: ConfigFvInput, @CurrentUser() user?: ScopedUser) {
    this.service.assertEditor(user);
    await this.service.upsert(body);
    return { data: { ok: true } };
  }

  @Delete()
  @ApiOperation({ summary: 'Remove a config de uma unidade' })
  async remover(@Query('unidadeId') unidadeId: string, @CurrentUser() user?: ScopedUser) {
    this.service.assertEditor(user);
    return { data: await this.service.remover(unidadeId) };
  }
}
