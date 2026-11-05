import { Body, Controller, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/core';
import { ControleMedService } from './controle-med.service';

/**
 * Controle automático pelo MED Concessionária (FP, demanda de geração e de carga).
 * Escopado por dono (assertEntityInScope); alterar exige configuração técnica (R10).
 */
@ApiTags('Controle · MED Concessionária')
@ApiBearerAuth()
@Controller('controle-med/:medId')
@UseGuards(JwtAuthGuard)
export class ControleMedController {
  constructor(private readonly svc: ControleMedService) {}

  @Get()
  @ApiOperation({ summary: 'Cadastro, modos, validação (R2/R4), inversores candidatos e último ciclo' })
  obter(@Param('medId') medId: string, @CurrentUser() user?: any) {
    return this.svc.obter(medId, user);
  }

  @Get('ciclos')
  @ApiOperation({ summary: 'Últimos ciclos (1 por minuto do medidor): entradas, portão, pedidos e comandos' })
  ciclos(@Param('medId') medId: string, @Query('limite') limite?: string, @CurrentUser() user?: any) {
    return this.svc.ciclos(medId, Number(limite) || 60, user);
  }

  @Get('historico')
  @ApiOperation({ summary: 'Histórico de alterações do cadastro e dos modos' })
  historico(@Param('medId') medId: string, @CurrentUser() user?: any) {
    return this.svc.historico(medId, user);
  }

  @Put('config')
  @ApiOperation({ summary: 'Grava parâmetros e UFVs (controle.configurar). Body: { params, ufvs }' })
  salvarConfig(@Param('medId') medId: string, @Body() body: any, @CurrentUser() user?: any) {
    return this.svc.salvarConfig(medId, body ?? {}, user);
  }

  @Put('modos')
  @ApiOperation({ summary: 'Modo de cada controle: desligado | sombra | ativo (controle.operar). Body: { modos: { fp, demanda_g, demanda_c } }' })
  salvarModos(@Param('medId') medId: string, @Body() body: any, @CurrentUser() user?: any) {
    return this.svc.salvarModos(medId, body ?? {}, user);
  }
}
