import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { CurrentUser } from '@/core';
import { Cliente, type ClienteInfo } from '@/core/common/cliente-info';
import { ChamadosService } from './chamados.service';
import { AbrirChamadoDto, EncaminharChamadoDto, FecharChamadoDto, ListarChamadosDto } from './dto/chamados.dto';

/**
 * Chamados (NEXON-24): pedido de reparo de equipamento, aberto pela web ou pelo app.
 * Escopo por planta (PermissionScopeService). Toda ação grava em auditoria_acessos.
 */
@Controller('chamados')
export class ChamadosController {
  constructor(private readonly chamados: ChamadosService) {}

  @Get()
  listar(@Query() q: ListarChamadosDto, @CurrentUser() user?: any) {
    return this.chamados.listar(q, user);
  }

  /** Número do menu lateral: chamados ainda não fechados. */
  @Get('contagem')
  contagem(@CurrentUser() user?: any) {
    return this.chamados.contagem(user);
  }

  @Get(':id')
  detalhe(@Param('id') id: string, @CurrentUser() user?: any) {
    return this.chamados.detalhe(id, user);
  }

  @Post()
  abrir(@Body() dto: AbrirChamadoDto, @CurrentUser() user?: any, @Cliente() cliente?: ClienteInfo) {
    return this.chamados.abrir(dto, user, cliente);
  }

  @Post(':id/encaminhar')
  @HttpCode(HttpStatus.OK)
  encaminhar(
    @Param('id') id: string,
    @Body() dto: EncaminharChamadoDto,
    @CurrentUser() user?: any,
    @Cliente() cliente?: ClienteInfo,
  ) {
    return this.chamados.encaminhar(id, dto, user, cliente);
  }

  @Post(':id/fechar')
  @HttpCode(HttpStatus.OK)
  fechar(
    @Param('id') id: string,
    @Body() dto: FecharChamadoDto,
    @CurrentUser() user?: any,
    @Cliente() cliente?: ClienteInfo,
  ) {
    return this.chamados.fechar(id, dto, user, cliente);
  }
}
