import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser } from '@/core';
import { Cliente, type ClienteInfo } from '@/core/common/cliente-info';
import { ChamadosService } from './chamados.service';
import {
  AbrirChamadoDto,
  AdicionarNotaDto,
  EditarChamadoDto,
  EncaminharChamadoDto,
  ExcluirChamadoDto,
  FecharChamadoDto,
  ListarChamadosDto,
  MudarStatusDto,
} from './dto/chamados.dto';

/**
 * Chamados (NEXON-24): pedido de reparo de equipamento, aberto pela web ou pelo app.
 * NEXON-144: chamado EXTERNO (aberto com terceiro, ex.: Equatorial), edição, status,
 * notas, exclusão e estatísticas da página.
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

  /** Indicadores e gráficos da página (mesmos filtros da lista). */
  @Get('estatisticas')
  estatisticas(@Query() q: ListarChamadosDto, @CurrentUser() user?: any) {
    return this.chamados.estatisticas(q, user);
  }

  /** Órgãos já usados (sugestão do campo). */
  @Get('orgaos')
  orgaos(@CurrentUser() user?: any) {
    return this.chamados.orgaos(user);
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

  @Patch(':id')
  editar(@Param('id') id: string, @Body() dto: EditarChamadoDto, @CurrentUser() user?: any, @Cliente() cliente?: ClienteInfo) {
    return this.chamados.editar(id, dto, user, cliente);
  }

  @Post(':id/status')
  @HttpCode(HttpStatus.OK)
  mudarStatus(@Param('id') id: string, @Body() dto: MudarStatusDto, @CurrentUser() user?: any, @Cliente() cliente?: ClienteInfo) {
    return this.chamados.mudarStatus(id, dto, user, cliente);
  }

  @Post(':id/notas')
  @HttpCode(HttpStatus.OK)
  adicionarNota(@Param('id') id: string, @Body() dto: AdicionarNotaDto, @CurrentUser() user?: any, @Cliente() cliente?: ClienteInfo) {
    return this.chamados.adicionarNota(id, dto, user, cliente);
  }

  /** Exclusão lógica com motivo (cadastro errado). */
  @Delete(':id')
  excluir(@Param('id') id: string, @Body() dto: ExcluirChamadoDto, @CurrentUser() user?: any, @Cliente() cliente?: ClienteInfo) {
    return this.chamados.excluir(id, dto, user, cliente);
  }
}
