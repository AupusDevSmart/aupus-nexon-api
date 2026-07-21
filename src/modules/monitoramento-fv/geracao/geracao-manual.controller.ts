import { Body, Controller, Delete, Get, Put, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser, ScopedUser } from '@aupus/api-shared';
import { GeracaoManualService, LinhaManual } from './geracao-manual.service';

/**
 * Curadoria manual da geração diária FV (analistas/admins). Entrada e correção à mão + import
 * Excel (parseado no front → JSON). `origem='manual'` tem precedência sobre a nuvem (o cron
 * não sobrescreve). RBAC: assertEditor (super_admin/consultor) em toda escrita e leitura —
 * é ferramenta interna.
 */
@ApiTags('Monitoramento FV — Geração manual')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('monitoramento-fv/geracao')
export class GeracaoManualController {
  constructor(private readonly service: GeracaoManualService) {}

  @Get('unidades')
  @ApiOperation({ summary: 'Unidades FV elegíveis (dropdown + template de import)' })
  async unidades(@CurrentUser() user?: ScopedUser) {
    this.service.assertEditor(user);
    return { data: await this.service.listarUnidades() };
  }

  @Get()
  @ApiOperation({ summary: 'Lista geração diária p/ a tabela editável (?unidadeId&de&ate)' })
  async listar(
    @CurrentUser() user?: ScopedUser,
    @Query('unidadeId') unidadeId?: string,
    @Query('de') de?: string,
    @Query('ate') ate?: string,
  ) {
    this.service.assertEditor(user);
    return { data: await this.service.listar({ unidadeId, de, ate }) };
  }

  @Put()
  @ApiOperation({ summary: 'Lança/corrige uma geração diária (origem=manual)' })
  async upsert(@Body() body: LinhaManual, @CurrentUser() user?: ScopedUser) {
    this.service.assertEditor(user);
    await this.service.upsertManual(body);
    return { data: { ok: true } };
  }

  @Post('importar')
  @ApiOperation({ summary: 'Import em lote (Excel/CSV parseado no front → JSON array)' })
  async importar(@Body() body: { linhas: LinhaManual[] }, @CurrentUser() user?: ScopedUser) {
    this.service.assertEditor(user);
    return { data: await this.service.upsertBulk(body?.linhas ?? []) };
  }

  @Delete()
  @ApiOperation({ summary: 'Remove correção manual (volta pra nuvem no próximo sync)' })
  async remover(
    @Query('unidadeId') unidadeId: string,
    @Query('data') data: string,
    @CurrentUser() user?: ScopedUser,
  ) {
    this.service.assertEditor(user);
    return { data: await this.service.remover(unidadeId, data) };
  }
}
