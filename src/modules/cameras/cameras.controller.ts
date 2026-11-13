import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CurrentUser, Public } from '@/core';
import { Cliente, type ClienteInfo } from '@/core/common/cliente-info';
import { CamerasAgenteService } from './cameras-agente.service';
import { CamerasEventosService } from './cameras-eventos.service';
import { CamerasService } from './cameras.service';
import type { Usuario } from './cameras.tipos';
import {
  AcionarDto,
  ArmarDto,
  ConfigUnidadeDto,
  CriarAgenteDto,
  CriarCameraDto,
  EditarCameraDto,
  ListarAgentesDto,
  ListarCamerasDto,
  ListarEventosDto,
  MarcarLidosDto,
} from './dto/cameras.dto';
import { UsuarioOuTokenMidiaGuard } from './guards/usuario-ou-token-midia.guard';

/**
 * Câmeras (NEXON-88) — rotas de usuário. Contrato: NexON/docs/cameras/API-CAMERAS.md.
 * Rotas com caminho fixo (eventos, agentes, unidades) vêm antes de `:id`.
 * Miniatura, snapshot e clipe aceitam JWT ou `?token=` (UsuarioOuTokenMidiaGuard) e ignoram
 * `?v=` (cache do navegador); por isso não têm DTO de query.
 */
@ApiTags('Câmeras')
@ApiBearerAuth()
@Controller('cameras')
export class CamerasController {
  constructor(
    private readonly cameras: CamerasService,
    private readonly eventos: CamerasEventosService,
    private readonly agentes: CamerasAgenteService,
  ) {}

  // ---------------------------------------------------------------------------
  // Eventos
  // ---------------------------------------------------------------------------

  @Get('eventos')
  @ApiOperation({ summary: 'Eventos (mais recentes primeiro); tipo aceita lista e `sistema`; dia em America/Sao_Paulo' })
  listarEventos(@Query() q: ListarEventosDto, @CurrentUser() user?: Usuario) {
    return this.eventos.listar(q, user);
  }

  @Post('eventos/lidos')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Marca todos os alertas da unidade (ou de uma câmera) como lidos' })
  marcarLidos(@Body() dto: MarcarLidosDto, @CurrentUser() user?: Usuario, @Cliente() cliente?: ClienteInfo) {
    return this.eventos.marcarLidos(dto, user, cliente);
  }

  @Get('eventos/:id')
  detalheEvento(@Param('id') id: string, @CurrentUser() user?: Usuario) {
    return this.eventos.detalhe(id, user);
  }

  @Public()
  @UseGuards(UsuarioOuTokenMidiaGuard)
  @Get('eventos/:id/snapshot')
  @ApiOperation({ summary: 'JPEG do evento (JWT ou ?token=)' })
  snapshot(@Param('id') id: string, @CurrentUser() user: Usuario, @Req() req: Request, @Res() res: Response) {
    return this.eventos.arquivo(id, 'snapshot', user, req, res);
  }

  @Public()
  @UseGuards(UsuarioOuTokenMidiaGuard)
  @Get('eventos/:id/clipe')
  @ApiOperation({ summary: 'MP4 do evento com Range (JWT ou ?token=)' })
  clipe(@Param('id') id: string, @CurrentUser() user: Usuario, @Req() req: Request, @Res() res: Response) {
    return this.eventos.arquivo(id, 'clipe', user, req, res);
  }

  @Post('eventos/:id/lido')
  @HttpCode(HttpStatus.OK)
  marcarLido(@Param('id') id: string, @CurrentUser() user?: Usuario) {
    return this.eventos.marcarLido(id, user);
  }

  // ---------------------------------------------------------------------------
  // Agentes (cadastroTecnico)
  // ---------------------------------------------------------------------------

  @Get('agentes')
  listarAgentes(@Query() q: ListarAgentesDto, @CurrentUser() user?: Usuario) {
    return this.agentes.listar(q, user);
  }

  @Post('agentes')
  @ApiOperation({ summary: 'Cria o agente; o token só aparece nesta resposta' })
  criarAgente(@Body() dto: CriarAgenteDto, @CurrentUser() user?: Usuario, @Cliente() cliente?: ClienteInfo) {
    return this.agentes.criar(dto, user, cliente);
  }

  @Get('agentes/:id/descobertas')
  @ApiOperation({ summary: 'Câmeras encontradas na rede pelo agente (24 h) que ainda não estão cadastradas na unidade' })
  descobertasAgente(@Param('id') id: string, @CurrentUser() user?: Usuario) {
    return this.agentes.descobertas(id, user);
  }

  @Post('agentes/:id/token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Gera token novo (o antigo deixa de valer)' })
  novoTokenAgente(@Param('id') id: string, @CurrentUser() user?: Usuario, @Cliente() cliente?: ClienteInfo) {
    return this.agentes.novoToken(id, user, cliente);
  }

  @Delete('agentes/:id')
  removerAgente(@Param('id') id: string, @CurrentUser() user?: Usuario, @Cliente() cliente?: ClienteInfo) {
    return this.agentes.remover(id, user, cliente);
  }

  // ---------------------------------------------------------------------------
  // Unidade: resumo, config, armar, acionar
  // ---------------------------------------------------------------------------

  @Get('unidades/:unidadeId/resumo')
  resumo(@Param('unidadeId') unidadeId: string, @CurrentUser() user?: Usuario) {
    return this.cameras.resumo(unidadeId, user);
  }

  @Get('unidades/:unidadeId/config')
  config(@Param('unidadeId') unidadeId: string, @CurrentUser() user?: Usuario) {
    return this.cameras.obterConfig(unidadeId, user);
  }

  @Put('unidades/:unidadeId/config')
  salvarConfig(
    @Param('unidadeId') unidadeId: string,
    @Body() dto: ConfigUnidadeDto,
    @CurrentUser() user?: Usuario,
    @Cliente() cliente?: ClienteInfo,
  ) {
    return this.cameras.salvarConfig(unidadeId, dto, user, cliente);
  }

  @Post('unidades/:unidadeId/armar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Armamento manual { armado, ate? }; responde o resumo' })
  armar(@Param('unidadeId') unidadeId: string, @Body() dto: ArmarDto, @CurrentUser() user?: Usuario, @Cliente() cliente?: ClienteInfo) {
    return this.cameras.armar(unidadeId, dto, user, cliente);
  }

  @Post('unidades/:unidadeId/acionar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Pulsa o refletor ou a sirene configurados' })
  acionar(@Param('unidadeId') unidadeId: string, @Body() dto: AcionarDto, @CurrentUser() user?: Usuario, @Cliente() cliente?: ClienteInfo) {
    return this.cameras.acionar(unidadeId, dto, user, cliente);
  }

  // ---------------------------------------------------------------------------
  // Câmeras
  // ---------------------------------------------------------------------------

  @Get()
  @ApiOperation({ summary: 'Câmeras da unidade (?unidade_id=) com status, não lidos e miniatura' })
  listar(@Query() q: ListarCamerasDto, @CurrentUser() user?: Usuario) {
    return this.cameras.listar(q, user);
  }

  @Post()
  criar(@Body() dto: CriarCameraDto, @CurrentUser() user?: Usuario, @Cliente() cliente?: ClienteInfo) {
    return this.cameras.criar(dto, user, cliente);
  }

  @Get(':id')
  detalhe(@Param('id') id: string, @CurrentUser() user?: Usuario) {
    return this.cameras.detalhe(id, user);
  }

  @Patch(':id')
  editar(@Param('id') id: string, @Body() dto: EditarCameraDto, @CurrentUser() user?: Usuario, @Cliente() cliente?: ClienteInfo) {
    return this.cameras.editar(id, dto, user, cliente);
  }

  @Delete(':id')
  excluir(@Param('id') id: string, @CurrentUser() user?: Usuario, @Cliente() cliente?: ClienteInfo) {
    return this.cameras.excluir(id, user, cliente);
  }

  @Public()
  @UseGuards(UsuarioOuTokenMidiaGuard)
  @Get(':id/miniatura')
  @ApiOperation({ summary: 'Última miniatura JPEG (JWT ou ?token=); 404 se não há' })
  miniatura(@Param('id') id: string, @CurrentUser() user: Usuario, @Req() req: Request, @Res() res: Response) {
    return this.cameras.miniatura(id, user, req, res);
  }

  @Get(':id/stream')
  @ApiOperation({ summary: 'Pede o vídeo ao vivo (HLS com ?token=); repetir a cada 60 s enquanto assiste' })
  stream(@Param('id') id: string, @CurrentUser() user?: Usuario) {
    return this.cameras.stream(id, user);
  }

  @Post(':id/foto')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Pede uma foto agora ao agente; 409 CAMERA_SEM_AGENTE' })
  foto(@Param('id') id: string, @CurrentUser() user?: Usuario, @Cliente() cliente?: ClienteInfo) {
    return this.cameras.foto(id, user, cliente);
  }
}
