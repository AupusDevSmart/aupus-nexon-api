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
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard, Permissions, CurrentUser } from '@/core';

import { TonAiService } from './ton-ai.service';
import {
  CreateTonAiDto,
  UpdateTonAiDto,
  TonAiResponseDto,
} from './dto/ton-ai.dto';

/**
 * CRUD de mapeamento AI (Analog Input) -> ponto (tipo medicao) + escala mV->%.
 *
 * Rotas sob /equipamentos/:tonId/ais. Reaproveita a permissao
 * equipamentos.manage_bos (mesma tela de configuracao de I/O da TON).
 *
 * GET /ais -> N entradas (AI01..AI0N) com mapeamentos + placeholders.
 */
@ApiTags('TON · Analog Inputs')
@ApiBearerAuth()
@Controller('equipamentos/:tonId/ais')
@UseGuards(JwtAuthGuard)
export class TonAiController {
  constructor(private readonly service: TonAiService) {}

  @Get()
  @Permissions('equipamentos.view')
  @ApiOperation({
    summary: 'Lista os AIs da TON (mapeamentos atuais + placeholders)',
    description:
      'Retorna os canais analogicos do modelo (v1: ai_numero 1..2). ' +
      'Entradas com id="" sao placeholders — frontend deve fazer POST ao salvar.',
  })
  @ApiParam({ name: 'tonId', description: 'ID da TON (equipamento)' })
  @ApiResponse({ status: 200, type: [TonAiResponseDto] })
  list(
    @Param('tonId') tonId: string,
    @CurrentUser() user?: any,
  ): Promise<TonAiResponseDto[]> {
    return this.service.list(tonId, user);
  }

  @Post()
  @Permissions('equipamentos.manage_bos')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Cria mapeamento de AI da TON' })
  @ApiResponse({ status: 201, type: TonAiResponseDto })
  @ApiResponse({ status: 404, description: 'TON nao encontrada' })
  @ApiResponse({ status: 400, description: 'Ponto invalido (nao existe ou nao eh tipo=medicao) / escala invalida' })
  @ApiResponse({ status: 409, description: 'ai_numero ja existe para essa TON' })
  create(
    @Param('tonId') tonId: string,
    @Body() dto: CreateTonAiDto,
    @CurrentUser() user?: any,
  ): Promise<TonAiResponseDto> {
    return this.service.create(tonId, dto, user);
  }

  @Patch(':aiId')
  @Permissions('equipamentos.manage_bos')
  @ApiOperation({ summary: 'Atualiza mapeamento de AI (parcial)' })
  @ApiResponse({ status: 200, type: TonAiResponseDto })
  @ApiResponse({ status: 404, description: 'AI nao encontrado' })
  @ApiResponse({ status: 400, description: 'Ponto ou escala invalidos' })
  update(
    @Param('tonId') tonId: string,
    @Param('aiId') aiId: string,
    @Body() dto: UpdateTonAiDto,
    @CurrentUser() user?: any,
  ): Promise<TonAiResponseDto> {
    return this.service.update(tonId, aiId, dto, user);
  }

  @Delete(':aiId')
  @Permissions('equipamentos.manage_bos')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft delete do AI (preserva historico)' })
  @ApiResponse({ status: 204, description: 'Soft delete confirmado' })
  remove(
    @Param('tonId') tonId: string,
    @Param('aiId') aiId: string,
    @CurrentUser() user?: any,
  ): Promise<void> {
    return this.service.remove(tonId, aiId, user);
  }
}
