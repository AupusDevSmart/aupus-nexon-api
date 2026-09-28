import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { Cliente, ClienteInfo } from '../../common/cliente-info';
import { ContaService } from './conta.service';
import { OperadoresService } from './operadores.service';
import {
  AcessoOperadorDto,
  AtualizarMeDto,
  CriarConviteDto,
  PreferenciasNotificacaoDto,
  RegistrarDispositivoPushDto,
} from './dto/conta-app.dto';

/**
 * Rotas dos apps NexON (AUPU-70) sob /usuarios. Este controller é registrado
 * ANTES do UsuariosController no módulo: `me`, `operadores` e `convites` são
 * rotas estáticas que, depois dele, seriam engolidas por `/usuarios/:id`.
 */
@ApiTags('Usuários · App NexON')
@ApiBearerAuth()
@Controller('usuarios')
export class UsuariosAppController {
  constructor(
    private readonly conta: ContaService,
    private readonly operadores: OperadoresService,
  ) {}

  // --------------------------------------------------------------------------
  // Minha conta (sempre o usuário do token)
  // --------------------------------------------------------------------------

  @Patch('me')
  @ApiOperation({ summary: 'Atualiza o próprio perfil (nome, telefone, email)' })
  atualizarMe(@CurrentUser() user: any, @Body() dto: AtualizarMeDto) {
    return this.conta.atualizarMe(user.id, dto);
  }

  @Get('me/notificacoes')
  @ApiOperation({ summary: 'Preferências de notificação do usuário' })
  getNotificacoes(@CurrentUser() user: any) {
    return this.conta.getNotificacoes(user.id);
  }

  @Put('me/notificacoes')
  @ApiOperation({ summary: 'Grava preferências de notificação (parcial)' })
  putNotificacoes(@CurrentUser() user: any, @Body() dto: PreferenciasNotificacaoDto) {
    return this.conta.putNotificacoes(user.id, dto);
  }

  @Post('me/dispositivos')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Registra token de push (APNs/FCM) do aparelho' })
  registrarDispositivo(@CurrentUser() user: any, @Body() dto: RegistrarDispositivoPushDto) {
    return this.conta.registrarDispositivo(user.id, dto);
  }

  @Delete('me/dispositivos/:token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove token de push (logout do aparelho)' })
  removerDispositivo(@CurrentUser() user: any, @Param('token') token: string) {
    return this.conta.removerDispositivo(user.id, token);
  }

  // --------------------------------------------------------------------------
  // Operadores
  // --------------------------------------------------------------------------

  @Get('operadores')
  @Permissions('usuarios.view')
  @ApiOperation({ summary: 'Operadores (proprietário: só os que criou) com contagens, permissões e convite' })
  listarOperadores(@CurrentUser() user: any) {
    return this.operadores.listar(user);
  }

  @Post('convites')
  @Permissions('usuarios.create_operador', 'usuarios.manage')
  @ApiOperation({ summary: 'Convida operador: cria o usuário inativo e devolve o link para criar a senha' })
  convidar(@CurrentUser() user: any, @Body() dto: CriarConviteDto, @Cliente() cliente: ClienteInfo) {
    return this.operadores.convidar(dto, user, cliente);
  }

  @Post('convites/:id/reenviar')
  @HttpCode(HttpStatus.OK)
  @Permissions('usuarios.create_operador', 'usuarios.manage')
  @ApiOperation({ summary: 'Reenvia o convite (token e validade novos)' })
  reenviar(@CurrentUser() user: any, @Param('id') id: string, @Cliente() cliente: ClienteInfo) {
    return this.operadores.reenviar(id, user, cliente);
  }

  @Get(':id/acesso')
  @Permissions('usuarios.view')
  @ApiOperation({ summary: 'Acesso do operador: instalações, permissões, exceções e janela' })
  getAcesso(@CurrentUser() user: any, @Param('id') id: string) {
    return this.operadores.getAcesso(id, user);
  }

  @Put(':id/acesso')
  @Permissions('usuarios.create_operador', 'usuarios.manage')
  @ApiOperation({ summary: 'Regrava o acesso do operador (fica na trilha "Permissões alteradas")' })
  putAcesso(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: AcessoOperadorDto,
    @Cliente() cliente: ClienteInfo,
  ) {
    return this.operadores.putAcesso(id, dto, user, cliente);
  }
}
