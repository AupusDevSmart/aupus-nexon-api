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

import { TonBoService } from './ton-bo.service';
import {
  CreateTonBoDto,
  UpdateTonBoDto,
  TonBoResponseDto,
} from './dto/ton-bo.dto';

/**
 * CRUD de mapeamento BO (Binary Output) -> ponto de equipamento.
 *
 * Rotas sob /equipamentos/:tonId/bos. tonId eh um equipamento (categoria=TON
 * por convencao; controller nao restringe, frontend filtra).
 *
 * GET sempre retorna 6 entradas (BO01..BO06) — entradas nao persistidas
 * vem com id="" e defaults; frontend faz POST ao salvar pela primeira vez.
 */
@ApiTags('TON · Binary Outputs')
@ApiBearerAuth()
@Controller('equipamentos/:tonId/bos')
@UseGuards(JwtAuthGuard)
export class TonBoController {
  constructor(private readonly service: TonBoService) {}

  @Get()
  @Permissions('equipamentos.view')
  @ApiOperation({
    summary: 'Lista 6 BOs da TON (com mapeamentos atuais + placeholders)',
    description:
      'Sempre retorna 6 entradas (bo_numero 1..6). Entradas com id="" sao ' +
      'placeholders — frontend deve fazer POST ao salvar.',
  })
  @ApiParam({ name: 'tonId', description: 'ID da TON (equipamento)' })
  @ApiResponse({ status: 200, type: [TonBoResponseDto] })
  list(@Param('tonId') tonId: string, @CurrentUser() user?: any): Promise<TonBoResponseDto[]> {
    return this.service.list(tonId, user);
  }

  @Post()
  @Permissions('equipamentos.manage_bos')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Cria mapeamento de BO da TON' })
  @ApiResponse({ status: 201, type: TonBoResponseDto })
  @ApiResponse({ status: 404, description: 'TON nao encontrada' })
  @ApiResponse({ status: 400, description: 'Ponto invalido (nao existe ou nao eh tipo=comando)' })
  @ApiResponse({ status: 409, description: 'bo_numero ja existe para essa TON' })
  create(
    @Param('tonId') tonId: string,
    @Body() dto: CreateTonBoDto,
    @CurrentUser() user?: any,
  ): Promise<TonBoResponseDto> {
    return this.service.create(tonId, dto, user);
  }

  @Patch(':boId')
  @Permissions('equipamentos.manage_bos')
  @ApiOperation({ summary: 'Atualiza mapeamento de BO (parcial)' })
  @ApiResponse({ status: 200, type: TonBoResponseDto })
  @ApiResponse({ status: 404, description: 'BO nao encontrado' })
  @ApiResponse({ status: 400, description: 'Ponto invalido' })
  update(
    @Param('tonId') tonId: string,
    @Param('boId') boId: string,
    @Body() dto: UpdateTonBoDto,
    @CurrentUser() user?: any,
  ): Promise<TonBoResponseDto> {
    return this.service.update(tonId, boId, dto, user);
  }

  @Delete(':boId')
  @Permissions('equipamentos.manage_bos')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft delete do BO (preserva historico)' })
  @ApiResponse({ status: 204, description: 'Soft delete confirmado' })
  remove(
    @Param('tonId') tonId: string,
    @Param('boId') boId: string,
    @CurrentUser() user?: any,
  ): Promise<void> {
    return this.service.remove(tonId, boId, user);
  }
}
