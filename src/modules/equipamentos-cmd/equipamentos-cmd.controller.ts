import {
  Body,
  Controller,
  Param,
  Post,
  HttpCode,
  HttpStatus,
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
import { SendCommandDto } from './dto/send-command.dto';
import { CommandResultDto } from './dto/command-result.dto';
import { ConfigurarWifiDto } from './dto/configurar-wifi.dto';

/**
 * Comandos MQTT para equipamentos (TONs IoT, dispositivos com firmware Aupus).
 *
 * Rota: POST /api/v1/equipamentos/:id/cmd
 *
 * Permission: equipamentos.comandar (separada de equipamentos.manage para
 * permitir granularidade futura: operador comanda mas nao edita cadastro).
 */
@ApiTags('Equipamentos · Comandos MQTT')
@ApiBearerAuth()
@Controller('equipamentos/:id/cmd')
@UseGuards(JwtAuthGuard)
export class EquipamentosCmdController {
  constructor(private readonly cmdService: EquipamentosCmdService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @Permissions('equipamentos.comandar')
  @ApiOperation({
    summary: 'Envia comando MQTT para um equipamento e aguarda ack',
    description:
      'Publica em <topico_mqtt>/cmd com envelope { cmd_id, cmd } e aguarda ack ' +
      'em <topico_mqtt>/cmd/ack. Retransmite ate 3 vezes em caso de timeout. ' +
      'Mapeamento de status: ok/duplicate -> 200, error -> 502, timeout -> 504. ' +
      'Backend nao valida semanticamente o `cmd` — firmware do TON eh a verdade.',
  })
  @ApiParam({ name: 'id', description: 'ID do equipamento (CUID/Char(26))' })
  @ApiResponse({
    status: 200,
    description: 'TON confirmou execucao (ok ou duplicate)',
    type: CommandResultDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Equipamento sem mqtt_habilitado ou topico_mqtt vazio, ou cmd invalido',
  })
  @ApiResponse({ status: 401, description: 'JWT ausente ou expirado' })
  @ApiResponse({ status: 403, description: 'Sem permission equipamentos.comandar' })
  @ApiResponse({ status: 404, description: 'Equipamento nao encontrado' })
  @ApiResponse({ status: 502, description: 'TON respondeu com error' })
  @ApiResponse({ status: 503, description: 'Broker MQTT desconectado' })
  @ApiResponse({ status: 504, description: 'TON nao respondeu dentro do timeout' })
  async send(
    @Param('id') id: string,
    @Body() dto: SendCommandDto,
    @CurrentUser() user?: any,
  ): Promise<CommandResultDto> {
    return this.cmdService.sendCommand(id, dto, user);
  }

  @Post('wifi')
  @HttpCode(HttpStatus.OK)
  @Permissions('equipamentos.comandar')
  @ApiOperation({
    summary: 'Configura redes WiFi de um TON em runtime (sem reflash)',
    description:
      'Publica em <topico_mqtt>/cmd/wifi (fire-and-forget, nao retido) para o ' +
      'firmware multi-WiFi adicionar/remover/listar redes no NVS (ate 4). O TON ' +
      'precisa estar ONLINE quando o comando chega — use para pre-cadastrar a rede ' +
      'nova A DISTANCIA antes de uma troca de WiFi. Nao aguarda ack.',
  })
  @ApiParam({ name: 'id', description: 'ID do equipamento (CUID/Char(26))' })
  @ApiResponse({ status: 200, description: 'Comando WiFi publicado' })
  @ApiResponse({ status: 400, description: 'Equipamento sem mqtt/topico, ou ssid ausente' })
  @ApiResponse({ status: 403, description: 'Sem permission equipamentos.comandar' })
  @ApiResponse({ status: 404, description: 'Equipamento nao encontrado' })
  @ApiResponse({ status: 503, description: 'Broker MQTT desconectado' })
  async configurarWifi(
    @Param('id') id: string,
    @Body() dto: ConfigurarWifiDto,
    @CurrentUser() user?: any,
  ): Promise<{ ok: boolean; topico: string; action: string; ssid?: string }> {
    return this.cmdService.configurarWifi(id, dto.action, dto.ssid, dto.pass, user);
  }
}
