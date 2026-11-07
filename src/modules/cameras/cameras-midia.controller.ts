import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, Public } from '@/core';
import { CamerasMidiaService } from './cameras-midia.service';
import type { Usuario } from './cameras.tipos';

/**
 * Mídia: token para <img>/<video>/HLS sem header e a autenticação externa do MediaMTX.
 * `auth` recebe o JSON cru do MediaMTX (campos variam entre versões), por isso sem DTO —
 * a validação é do service, que só aceita chamada local (MIDIA_AUTH_LOCAL_ONLY).
 */
@ApiTags('Câmeras · Mídia')
@Controller('cameras/midia')
export class CamerasMidiaController {
  constructor(private readonly midia: CamerasMidiaService) {}

  @Get('token')
  @ApiOperation({ summary: 'Token de mídia (2 h) do usuário logado: { token, valido_ate }' })
  token(@CurrentUser() user?: Usuario) {
    return this.midia.gerarTokenMidia(user ?? {});
  }

  @Public()
  @Post('auth')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async auth(@Body() body: Record<string, unknown>, @Req() req: Request) {
    const ok = await this.midia.autenticarMediaMtx(body ?? {}, req.ip);
    if (!ok) throw new UnauthorizedException('Não autorizado');
    return { ok: true };
  }
}
