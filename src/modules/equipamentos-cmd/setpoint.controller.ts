import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards, BadRequestException } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, Permissions, CurrentUser, Cliente, ClienteInfo } from '@/core';
import { EquipamentosCmdService } from './equipamentos-cmd.service';

/**
 * Setpoints de equipamento (comando com VALOR): limite de potência, fator de potência,
 * reativo, endereço Modbus. O que existe vem do catálogo do modelo (mapeamento.setpoints
 * + bo_map com value "$valor"). Escopado por dono; envio exige equipamentos.acionar_ponto.
 */
@ApiTags('Equipamentos · Setpoints')
@ApiBearerAuth()
@Controller('equipamentos/:id/setpoints')
@UseGuards(JwtAuthGuard)
export class EquipamentosSetpointController {
  constructor(private readonly cmdService: EquipamentosCmdService) {}

  @Get()
  @ApiOperation({ summary: 'Ajustes (setpoints) que o modelo deste equipamento suporta' })
  listar(@Param('id') id: string, @CurrentUser() user?: any) {
    return this.cmdService.listarSetpoints(id, user);
  }

  @Post(':setpointId')
  @HttpCode(HttpStatus.OK)
  @Permissions('equipamentos.acionar_ponto')
  @ApiOperation({ summary: 'Envia um setpoint (valor em unidade de engenharia) à TON que lê o equipamento' })
  enviar(
    @Param('id') id: string,
    @Param('setpointId') setpointId: string,
    @Body() body: { valor?: number },
    @CurrentUser() user?: any,
    @Cliente() cliente?: ClienteInfo,
  ) {
    if (body?.valor === undefined || body?.valor === null || !Number.isFinite(Number(body.valor))) {
      throw new BadRequestException('Informe "valor" (número).');
    }
    return this.cmdService.enviarSetpoint(id, setpointId, Number(body.valor), user, cliente);
  }
}
