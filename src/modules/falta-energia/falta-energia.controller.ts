import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Public } from '@/core';
import { Cliente, type ClienteInfo } from '@/core/common/cliente-info';
import { FaltaEnergiaService } from './falta-energia.service';
import { AvisarFaltaEnergiaDto, ListarFaltaEnergiaDto } from './dto/falta-energia.dto';

/**
 * Falta de energia (NEXON-145): TON avisa → chamado na concessionária pelo robô de WhatsApp do
 * WhatsAupus → protocolo de volta. Toda ação grava em auditoria_acessos (objeto_tipo 'falta_energia').
 */
@ApiTags('Falta de energia')
@Controller('falta-energia')
export class FaltaEnergiaController {
  constructor(private readonly faltaEnergia: FaltaEnergiaService) {}

  @Get()
  @ApiOperation({ summary: 'Avisos de falta de energia (por chamado ou planta), no escopo do usuário' })
  listar(@Query() q: ListarFaltaEnergiaDto, @CurrentUser() user?: any) {
    return this.faltaEnergia.listar(q, user);
  }

  @Post('avisar')
  @ApiOperation({ summary: 'Avisar falta de energia à mão (admin e analistas): abre o chamado e manda ao robô na hora' })
  avisar(@Body() dto: AvisarFaltaEnergiaDto, @CurrentUser() user: any, @Cliente() cliente?: ClienteInfo) {
    return this.faltaEnergia.avisarManual(dto, user, cliente);
  }

  @Post(':id/reenviar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reenviar ao robô um aviso que falhou ou estava sem dados' })
  reenviar(@Param('id') id: string, @CurrentUser() user: any, @Cliente() cliente?: ClienteInfo) {
    return this.faltaEnergia.reenviar(id, user, cliente);
  }

  /**
   * Retorno do WhatsAupus (equatorial-bot dispatchCallback). Sem JWT: o token aleatório da URL é a
   * credencial (só o hash fica no banco) e vale para um único aviso.
   */
  @Public()
  @Post('whatsaupus/:token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Callback do WhatsAupus com o protocolo da concessionária' })
  retorno(@Param('token') token: string, @Body() body: unknown) {
    return this.faltaEnergia.retornoWhatsaupus(token, body);
  }
}
