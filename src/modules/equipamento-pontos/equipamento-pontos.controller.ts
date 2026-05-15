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

import { EquipamentoPontosService } from './equipamento-pontos.service';
import {
  CreateEquipamentoPontoDto,
  UpdateEquipamentoPontoDto,
  EquipamentoPontoResponseDto,
} from './dto/equipamento-ponto.dto';

/**
 * CRUD de pontos logicos por equipamento.
 * Rotas sob /equipamentos/:id/pontos.
 *
 * Permission: equipamentos.manage_pontos (separada de equipamentos.manage
 * para granularidade — operador pode editar pontos sem editar cadastro).
 */
@ApiTags('Equipamentos · Pontos (Automacao)')
@ApiBearerAuth()
@Controller('equipamentos/:id/pontos')
@UseGuards(JwtAuthGuard)
export class EquipamentoPontosController {
  constructor(private readonly service: EquipamentoPontosService) {}

  @Get()
  @Permissions('equipamentos.view')
  @ApiOperation({ summary: 'Lista pontos do equipamento' })
  @ApiParam({ name: 'id', description: 'ID do equipamento' })
  @ApiResponse({ status: 200, type: [EquipamentoPontoResponseDto] })
  list(@Param('id') id: string, @CurrentUser() user?: any): Promise<EquipamentoPontoResponseDto[]> {
    return this.service.list(id, user);
  }

  @Post()
  @Permissions('equipamentos.manage_pontos')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Cria um ponto para o equipamento',
    description:
      'Equipamento precisa estar com automacao=true. Nome do ponto eh unico ' +
      'por equipamento — colisao retorna 409.',
  })
  @ApiResponse({ status: 201, type: EquipamentoPontoResponseDto })
  @ApiResponse({ status: 404, description: 'Equipamento nao encontrado' })
  @ApiResponse({ status: 409, description: 'automacao=false OU nome duplicado' })
  create(
    @Param('id') id: string,
    @Body() dto: CreateEquipamentoPontoDto,
    @CurrentUser() user?: any,
  ): Promise<EquipamentoPontoResponseDto> {
    return this.service.create(id, dto, user);
  }

  @Patch(':pontoId')
  @Permissions('equipamentos.manage_pontos')
  @ApiOperation({ summary: 'Atualiza um ponto (campos parciais)' })
  @ApiResponse({ status: 200, type: EquipamentoPontoResponseDto })
  @ApiResponse({ status: 404, description: 'Ponto nao encontrado' })
  @ApiResponse({ status: 409, description: 'Nome duplicado no equipamento' })
  update(
    @Param('id') id: string,
    @Param('pontoId') pontoId: string,
    @Body() dto: UpdateEquipamentoPontoDto,
    @CurrentUser() user?: any,
  ): Promise<EquipamentoPontoResponseDto> {
    return this.service.update(id, pontoId, dto, user);
  }

  @Delete(':pontoId')
  @Permissions('equipamentos.manage_pontos')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft delete de um ponto' })
  @ApiResponse({ status: 204, description: 'Soft delete confirmado' })
  @ApiResponse({ status: 404, description: 'Ponto nao encontrado' })
  remove(
    @Param('id') id: string,
    @Param('pontoId') pontoId: string,
    @CurrentUser() user?: any,
  ): Promise<void> {
    return this.service.remove(id, pontoId, user);
  }
}
