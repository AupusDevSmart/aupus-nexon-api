import { Body, Controller, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser, ScopedUser, PermissionScopeService } from '@/core';
import { GeracaoAnaliseService } from './geracao-analise.service';
import { ConfigUsinaInput, GeracaoConfigService } from './geracao-config.service';
import { IrradianciaService } from './irradiancia/irradiancia.service';

/**
 * Análise de geração da instalação (NEXON-16): esperado × real, perdas, fechamento do mês,
 * previsão de amanhã e o grupo "Usina" da configuração. Contrato em docs/GERACAO-ANALISE.md.
 */
@ApiTags('Análise de geração')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('geracao-analise/unidades')
export class GeracaoAnaliseController {
  constructor(
    private readonly analise: GeracaoAnaliseService,
    private readonly configs: GeracaoConfigService,
    private readonly irradiancia: IrradianciaService,
    private readonly scope: PermissionScopeService,
  ) {}

  @Get(':unidadeId')
  @ApiOperation({ summary: 'Análise de geração do período (dia | semana | mes | ano)' })
  async obter(
    @Param('unidadeId') unidadeId: string,
    @Query('periodo') periodo?: string,
    @Query('data') data?: string,
    @CurrentUser() user?: ScopedUser,
  ) {
    return this.analise.analise(unidadeId, periodo, data, user);
  }

  @Get(':unidadeId/config')
  @ApiOperation({ summary: 'Configuração "Usina" da instalação, faixas e opções' })
  async config(@Param('unidadeId') unidadeId: string, @CurrentUser() user?: ScopedUser) {
    if (user) await this.scope.assertEntityInScope('unidade', unidadeId.trim(), user);
    return this.configs.obter(unidadeId, user);
  }

  @Get(':unidadeId/config/historico')
  @ApiOperation({ summary: 'Histórico de alterações da configuração "Usina"' })
  async historico(@Param('unidadeId') unidadeId: string, @CurrentUser() user?: ScopedUser) {
    if (user) await this.scope.assertEntityInScope('unidade', unidadeId.trim(), user);
    return this.configs.historico(unidadeId);
  }

  @Put(':unidadeId/config')
  @ApiOperation({ summary: 'Grava a configuração "Usina" (analista de automação e admin)' })
  async salvar(@Param('unidadeId') unidadeId: string, @Body() body: ConfigUsinaInput, @CurrentUser() user?: ScopedUser) {
    if (user) await this.scope.assertEntityInScope('unidade', unidadeId.trim(), user);
    const alteracoes = await this.configs.salvar(unidadeId, body, user);
    if (Object.keys(alteracoes).length) {
      // Esperado depende de toda a config: o cache diário recomeça. Inclinação, azimute ou fonte
      // mudam a própria irradiância no plano dos módulos.
      await this.analise.limparCache(unidadeId);
      if (['inclinacao_graus', 'azimute_graus', 'fonte'].some((k) => k in alteracoes)) {
        await this.irradiancia.limpar(unidadeId);
      }
      // Recalcula o último ano em segundo plano para Semana/Mês/Ano abrirem rápido.
      void this.configs.contexto(unidadeId).then((ctx) => this.analise.aquecer(ctx, 400)).catch(() => undefined);
    }
    return this.configs.obter(unidadeId, user);
  }
}
