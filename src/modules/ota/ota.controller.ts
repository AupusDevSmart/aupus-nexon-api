import {
  Controller,
  Post,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiParam,
} from '@nestjs/swagger';
import { OtaService } from './ota.service';
import {
  TriggerOtaDto,
  CompilePublishOtaDto,
  OtaStatusResponseDto,
} from './dto/trigger-ota.dto';
import { JwtAuthGuard, Permissions } from '@aupus/api-shared';

@ApiTags('OTA')
@ApiBearerAuth()
@Controller('equipamentos/:id/ota')
@UseGuards(JwtAuthGuard)
@Permissions('equipamentos.manage')
export class OtaController {
  constructor(private readonly otaService: OtaService) {}

  @Post('publicar')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Dispara OTA para um equipamento com firmware já publicado',
    description:
      'Publica um comando MQTT em {topico_mqtt}/ota/cmd com a URL do firmware. ' +
      'A TON faz o download via HTTP(S), grava via Update.h, e reinicia.',
  })
  @ApiParam({ name: 'id', description: 'ID do equipamento (CUID)' })
  @ApiResponse({
    status: 202,
    description: 'Comando OTA publicado no broker',
    type: OtaStatusResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Equipamento sem MQTT / payload inválido' })
  @ApiResponse({ status: 404, description: 'Equipamento não encontrado' })
  @ApiResponse({ status: 503, description: 'MQTT broker ou compiler indisponível' })
  async publicarOta(
    @Param('id') id: string,
    @Body() dto: TriggerOtaDto,
  ): Promise<OtaStatusResponseDto> {
    return this.otaService.triggerOta(id, dto);
  }

  @Post('compilar-e-publicar')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Compila o firmware e dispara OTA em uma única operação',
    description:
      'Envia os arquivos do projeto ao firmware-compiler, que compila com PlatformIO, ' +
      'salva o .bin em /iot-compile/artifacts/ e retorna URL + md5. ' +
      'Em seguida publica o comando OTA via MQTT.',
  })
  @ApiParam({ name: 'id', description: 'ID do equipamento (CUID)' })
  @ApiResponse({
    status: 202,
    description: 'Firmware compilado, artefato publicado e comando OTA enviado',
    type: OtaStatusResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Compilação falhou / equipamento sem MQTT' })
  @ApiResponse({ status: 404, description: 'Equipamento não encontrado' })
  @ApiResponse({ status: 503, description: 'Compiler ou MQTT indisponível' })
  async compilarEPublicar(
    @Param('id') id: string,
    @Body() dto: CompilePublishOtaDto,
  ): Promise<OtaStatusResponseDto> {
    return this.otaService.compileAndPublish(id, dto);
  }
}
