import {
  Controller,
  Post,
  Body,
  Get,
  Delete,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordWithTokenDto } from './dto/reset-password.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import { SessoesService } from './sessoes.service';
import { Cliente, ClienteInfo } from '../../common/cliente-info';

/**
 * Controller de autenticação
 * Gerencia endpoints de login, logout, refresh token e perfil do usuário
 */
@ApiTags('Autenticação')
@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private sessoesService: SessoesService,
  ) {}

  /**
   * Endpoint de login
   * Retorna access_token, refresh_token e dados do usuário
   */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Realiza login e retorna JWT' })
  @ApiResponse({
    status: 200,
    description: 'Login realizado com sucesso',
    type: AuthResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Credenciais inválidas' })
  @ApiResponse({ status: 403, description: 'Usuário inativo' })
  async login(@Body() loginDto: LoginDto, @Cliente() cliente: ClienteInfo): Promise<AuthResponseDto> {
    return this.authService.login(loginDto, cliente);
  }

  /**
   * Endpoint de refresh token
   * Renova o access_token usando o refresh_token
   */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Renova o access token' })
  @ApiResponse({ status: 200, description: 'Token renovado com sucesso' })
  @ApiResponse({ status: 401, description: 'Refresh token inválido' })
  async refresh(@Body() refreshTokenDto: RefreshTokenDto, @Cliente() cliente: ClienteInfo) {
    return this.authService.refreshToken(refreshTokenDto.refresh_token, cliente);
  }

  /**
   * Solicita a redefinição de senha.
   * Sempre retorna sucesso genérico para não revelar se o email existe (anti-enumeração).
   */
  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Solicita redefinição de senha por email' })
  @ApiResponse({ status: 200, description: 'Solicitação processada' })
  async forgotPassword(@Body() forgotPasswordDto: ForgotPasswordDto) {
    return this.authService.forgotPassword(forgotPasswordDto);
  }

  /**
   * Conclui a redefinição de senha usando o token recebido por email.
   */
  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Redefine a senha usando token do email' })
  @ApiResponse({ status: 200, description: 'Senha redefinida com sucesso' })
  @ApiResponse({ status: 400, description: 'Token inválido ou expirado' })
  async resetPassword(@Body() resetPasswordDto: ResetPasswordWithTokenDto) {
    return this.authService.resetPassword(resetPasswordDto);
  }

  /**
   * Endpoint de logout
   * Remove a sessão do usuário (futuramente pode invalidar token)
   */
  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Realiza logout' })
  @ApiResponse({ status: 200, description: 'Logout realizado com sucesso' })
  async logout(@CurrentUser() user: any) {
    return this.authService.logout(user.id, user.sid);
  }

  // ==========================================================================
  // Sessões (apps NexON v2 — Conta e segurança)
  // Sessão encerrada: o refresh dela dá 401; o access token já emitido vale até
  // expirar (1 h). Não há checagem de sessão por request.
  // ==========================================================================

  @UseGuards(JwtAuthGuard)
  @Get('sessions')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Lista as sessões abertas do usuário (atual = a deste token)' })
  async listarSessoes(@CurrentUser() user: any) {
    return this.sessoesService.listar(user.id, user.sid);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('sessions')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Encerra as OUTRAS sessões (?outras=true)' })
  async encerrarOutras(@CurrentUser() user: any, @Query('outras') outras?: string) {
    this.sessoesService.exigirOutras(outras);
    return this.sessoesService.revogarOutras(user.id, user.sid ?? null);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('sessions/:id')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Encerra uma sessão do próprio usuário' })
  async encerrarSessao(@CurrentUser() user: any, @Param('id') id: string) {
    return this.sessoesService.revogar(user.id, id);
  }

  /**
   * Endpoint para buscar dados do usuário autenticado
   * Retorna informações completas do perfil
   */
  @UseGuards(JwtAuthGuard)
  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Retorna dados do usuário autenticado' })
  @ApiResponse({ status: 200, description: 'Dados do usuário' })
  @ApiResponse({ status: 401, description: 'Não autenticado' })
  async getProfile(@CurrentUser() user: any) {
    return this.authService.getCurrentUser(user.id);
  }
}
