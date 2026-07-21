import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, PermissionScopeService, CurrentUser, ScopedUser } from '@aupus/api-shared';
import { ReleEventosService } from './rele-eventos.service';

/**
 * SOE — eventos de proteção de relé (trip/pickup com timestamp da FONTE).
 * Só leitura + curadoria do mapa FUN/INF. A ingestão é do mqtt.service.
 *
 * ⚠️ RBAC: a listagem é escopada por dono (PermissionScopeService.getScope) — sem isso
 * um proprietário veria os trips de usina de outro.
 */
@ApiTags('Relé — Eventos (SOE)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('rele-eventos')
export class ReleEventosController {
  constructor(
    private readonly service: ReleEventosService,
    private readonly scope: PermissionScopeService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Lista eventos de relé (ordenado pela hora da fonte)' })
  async listar(
    @Query('device') device?: string,
    @Query('equipamentoId') equipamentoId?: string,
    @Query('desde') desde?: string,
    @Query('limit') limit?: string,
    @CurrentUser() user?: ScopedUser,
  ) {
    const scope = await this.scope.getScope(user);
    return {
      data: await this.service.listar(
        { device, equipamentoId, desde, limit: limit ? Number(limit) : undefined },
        scope,
      ),
    };
  }

  @Get('codigos')
  @ApiOperation({ summary: 'Mapa FUN/INF -> evento semântico' })
  async codigos() {
    return { data: await this.service.listarCodigos() };
  }

  @Get('codigos/desconhecidos')
  @ApiOperation({ summary: 'Códigos vistos em campo mas ainda sem tradução (fila de curadoria)' })
  async desconhecidos() {
    return { data: await this.service.codigosDesconhecidos() };
  }

  @Post('codigos')
  @ApiOperation({ summary: 'Cadastra/atualiza tradução de código (reprocessa o histórico) — admin' })
  async salvarCodigo(
    @Body() body: { protocolo?: string; fun: number; inf: number; evento: string; descricao?: string },
    @CurrentUser() user?: ScopedUser,
  ) {
    this.service.assertEditor(user);
    return { data: await this.service.salvarCodigo(body) };
  }
}
