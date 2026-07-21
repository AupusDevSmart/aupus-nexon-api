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
import { JwtAuthGuard, Permissions, CurrentUser } from '@aupus/api-shared';

import { TonBiService } from './ton-bi.service';
import {
  CreateTonBiDto,
  UpdateTonBiDto,
  TonBiResponseDto,
  TonBiEstadoDto,
} from './dto/ton-bi.dto';

/**
 * CRUD de mapeamento BI (Boolean Input) -> ponto de equipamento + leitura de
 * estado atual.
 *
 * Rotas sob /equipamentos/:tonId/bis. tonId eh um equipamento (TON por
 * convencao). Reaproveita a permissao equipamentos.manage_bos (mesma tela de
 * configuracao de I/O da TON).
 *
 * GET /bis        -> 6 entradas (BI01..BI06) com mapeamentos + placeholders.
 * GET /bis/estado -> estado atual (liga/desliga) dos BIs ativos, ja resolvido.
 */
@ApiTags('TON · Boolean Inputs')
@ApiBearerAuth()
@Controller('equipamentos/:tonId/bis')
@UseGuards(JwtAuthGuard)
export class TonBiController {
  constructor(private readonly service: TonBiService) {}

  @Get()
  @Permissions('equipamentos.view')
  @ApiOperation({
    summary: 'Lista os BIs da TON (mapeamentos atuais + placeholders)',
    description:
      'Retorna as entradas do modelo (v1: bi_numero 1..6; TON-V2: 1..8). ' +
      'Entradas com id="" sao placeholders — frontend deve fazer POST ao salvar.',
  })
  @ApiParam({ name: 'tonId', description: 'ID da TON (equipamento)' })
  @ApiResponse({ status: 200, type: [TonBiResponseDto] })
  list(
    @Param('tonId') tonId: string,
    @CurrentUser() user?: any,
  ): Promise<TonBiResponseDto[]> {
    return this.service.list(tonId, user);
  }

  @Get('estado')
  @Permissions('equipamentos.view')
  @ApiOperation({
    summary: 'Estado atual (liga/desliga) dos BIs ativos da TON',
    description:
      'Junta o mapeamento com o ultimo {d1..d6} lido, aplicando inversao (NF). ' +
      'valor=null indica que ainda nao houve leitura.',
  })
  @ApiParam({ name: 'tonId', description: 'ID da TON (equipamento)' })
  @ApiResponse({ status: 200, type: [TonBiEstadoDto] })
  estado(
    @Param('tonId') tonId: string,
    @CurrentUser() user?: any,
  ): Promise<TonBiEstadoDto[]> {
    return this.service.getEstados(tonId, user);
  }

  @Post()
  @Permissions('equipamentos.manage_bos')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Cria mapeamento de BI da TON' })
  @ApiResponse({ status: 201, type: TonBiResponseDto })
  @ApiResponse({ status: 404, description: 'TON nao encontrada' })
  @ApiResponse({ status: 400, description: 'Ponto invalido (nao existe ou nao eh tipo=status)' })
  @ApiResponse({ status: 409, description: 'bi_numero ja existe para essa TON' })
  create(
    @Param('tonId') tonId: string,
    @Body() dto: CreateTonBiDto,
    @CurrentUser() user?: any,
  ): Promise<TonBiResponseDto> {
    return this.service.create(tonId, dto, user);
  }

  @Patch(':biId')
  @Permissions('equipamentos.manage_bos')
  @ApiOperation({ summary: 'Atualiza mapeamento de BI (parcial)' })
  @ApiResponse({ status: 200, type: TonBiResponseDto })
  @ApiResponse({ status: 404, description: 'BI nao encontrado' })
  @ApiResponse({ status: 400, description: 'Ponto invalido' })
  update(
    @Param('tonId') tonId: string,
    @Param('biId') biId: string,
    @Body() dto: UpdateTonBiDto,
    @CurrentUser() user?: any,
  ): Promise<TonBiResponseDto> {
    return this.service.update(tonId, biId, dto, user);
  }

  @Delete(':biId')
  @Permissions('equipamentos.manage_bos')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft delete do BI (preserva historico)' })
  @ApiResponse({ status: 204, description: 'Soft delete confirmado' })
  remove(
    @Param('tonId') tonId: string,
    @Param('biId') biId: string,
    @CurrentUser() user?: any,
  ): Promise<void> {
    return this.service.remove(tonId, biId, user);
  }
}
