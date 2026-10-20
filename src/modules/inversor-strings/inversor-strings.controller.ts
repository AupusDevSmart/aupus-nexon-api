import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, Permissions, CurrentUser } from '@/core';
import { InversorStringsService } from './inversor-strings.service';

@ApiTags('Equipamentos · Strings do inversor')
@ApiBearerAuth()
@Controller('equipamentos/:id/strings')
@UseGuards(JwtAuthGuard)
export class InversorStringsController {
  constructor(private readonly service: InversorStringsService) {}

  @Get()
  @ApiOperation({ summary: 'Perfil das strings (presença e razão típica, últimos 14 dias) + ajuste manual' })
  obter(@Param('id') id: string, @CurrentUser() user?: any) {
    return this.service.obter(id, user);
  }

  @Put()
  @Permissions('equipamentos.manage')
  @ApiOperation({ summary: 'Ajuste manual das entradas em uso: {"modos": {"2": "nao_usada", "5": "usada"}}' })
  salvar(@Param('id') id: string, @Body() body: { modos?: Record<string, string> }, @CurrentUser() user?: any) {
    return this.service.salvarModos(id, body?.modos ?? {}, user);
  }
}
