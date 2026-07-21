import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
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

import { EquipamentosCmdService } from './equipamentos-cmd.service';
import { AcionarPontoResultDto } from './dto/acionar-ponto-result.dto';
import { AcionarPontoDto } from './dto/acionar-ponto.dto';

/**
 * Aciona um ponto de comando de um equipamento, executando o pulso na TON
 * mapeada via ton_bo.
 *
 * Rota: POST /api/v1/equipamentos/:id/pontos/:pontoId/acionar
 *
 * Fluxo:
 *  1. Valida equipamento (existe, automacao=true)
 *  2. Valida ponto (existe, tipo=comando, ativo)
 *  3. Resolve ton_bo ativo apontando pra esse ponto
 *  4. Publica r{N} on no topico da TON + wait pulso_ms + r{N} off
 *  5. Retorna ack do TON + descricao tecnica/semantica
 *
 * Permission: equipamentos.acionar_ponto
 */
@ApiTags('Equipamentos · Acionar Ponto')
@ApiBearerAuth()
@Controller('equipamentos/:id/pontos/:pontoId/acionar')
@UseGuards(JwtAuthGuard)
export class EquipamentosAcionarPontoController {
  constructor(private readonly cmdService: EquipamentosCmdService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @Permissions('equipamentos.acionar_ponto')
  @ApiOperation({
    summary: 'Aciona um ponto de comando (executa pulso ON->OFF na TON mapeada)',
  })
  @ApiParam({ name: 'id', description: 'ID do equipamento alvo (disjuntor, etc.)' })
  @ApiParam({ name: 'pontoId', description: 'ID do ponto a acionar (tipo=comando)' })
  @ApiResponse({ status: 200, type: AcionarPontoResultDto })
  @ApiResponse({ status: 400, description: 'Equipamento sem automacao / ponto invalido / sem mapeamento ton_bo' })
  @ApiResponse({ status: 401, description: 'JWT ausente ou expirado' })
  @ApiResponse({ status: 403, description: 'Sem permission equipamentos.acionar_ponto' })
  @ApiResponse({ status: 404, description: 'Equipamento ou ponto nao encontrado' })
  @ApiResponse({ status: 502, description: 'TON respondeu com error' })
  @ApiResponse({ status: 503, description: 'Broker MQTT desconectado' })
  @ApiResponse({ status: 504, description: 'TON nao respondeu dentro do timeout' })
  async acionar(
    @Param('id') id: string,
    @Param('pontoId') pontoId: string,
    @Body() dto: AcionarPontoDto = {},
    @CurrentUser() user?: any,
  ): Promise<AcionarPontoResultDto> {
    return this.cmdService.acionarPonto(
      id,
      pontoId,
      user,
      dto?.sim === true,
      dto?.sim === true ? dto?.testMac : undefined,
    );
  }
}
