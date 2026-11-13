import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Public } from '@/core';
import { Cliente, type ClienteInfo } from '@/core/common/cliente-info';
import { CamerasPareamentoService } from './cameras-pareamento.service';
import type { Usuario } from './cameras.tipos';
import { EstadoPareamentoDto, PedirPareamentoDto, VincularPareamentoDto } from './dto/cameras-pareamento.dto';

/**
 * Pareamento do aparelho por código (NEXON-108). As duas rotas do aparelho são @Public() (ele ainda
 * não tem token) e se protegem pelo segredo do pedido + limite por IP; as da pessoa usam o JWT global
 * e exigem cadastroTecnico, como `POST /cameras/agentes`. Registrado antes do CamerasController.
 */
@ApiTags('Câmeras · Pareamento')
@Controller('cameras/pareamento')
export class CamerasPareamentoController {
  constructor(private readonly pareamento: CamerasPareamentoService) {}

  @Public()
  @Post()
  @ApiOperation({ summary: 'Aparelho sem token pede código de 6 dígitos (público, 10/min por IP)' })
  pedir(@Body() dto: PedirPareamentoDto, @Cliente() cliente?: ClienteInfo) {
    return this.pareamento.pedir(dto, cliente);
  }

  @Get('proximos')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Aparelhos aguardando código na mesma rede (mesmo IP público de quem chama)' })
  proximos(@CurrentUser() user?: Usuario, @Cliente() cliente?: ClienteInfo) {
    return this.pareamento.proximos(user, cliente);
  }

  @Post('vincular')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '{ codigo, unidade_id, nome? } — cria o agente; o aparelho recebe o token sozinho' })
  vincular(@Body() dto: VincularPareamentoDto, @CurrentUser() user?: Usuario, @Cliente() cliente?: ClienteInfo) {
    return this.pareamento.vincular(dto, user, cliente);
  }

  @Public()
  @Post(':pedidoId/estado')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '{ segredo } → estado; token nxcam_ vem uma única vez depois de vinculado (público, 30/min por IP)' })
  estado(@Param('pedidoId') pedidoId: string, @Body() dto: EstadoPareamentoDto, @Cliente() cliente?: ClienteInfo) {
    return this.pareamento.estado(pedidoId, dto, cliente);
  }
}
