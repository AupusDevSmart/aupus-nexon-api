import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { Public } from '@/core';
import { CamerasAgenteService } from './cameras-agente.service';
import type { AgenteInfo } from './cameras.tipos';
import { ClassificacaoEventoDto, EventoAgenteDto, FimEventoDto, HeartbeatDto, MiniaturaDto, ResultadoComandoDto } from './dto/cameras-agente.dto';
import { Agente, CameraAgenteGuard } from './guards/camera-agente.guard';

const MB = 1024 * 1024;
/** Arquivos ficam em memória até o service gravar em CAMERAS_STORAGE_DIR (nunca em ./uploads). */
const upload = (campo: string, maxMb: number) =>
  FileInterceptor(campo, { storage: memoryStorage(), limits: { fileSize: maxMb * MB, files: 1 } });

/**
 * Rotas do agente local (nexon-camera-agent), autenticadas pelo token do agente
 * (`Authorization: Bearer nxcam_...`) — nunca por JWT de usuário. Controller separado de
 * propósito: @Public() tira o JwtAuthGuard global do caminho e o CameraAgenteGuard fecha a porta.
 */
@ApiTags('Câmeras · Agente')
@Public()
@UseGuards(CameraAgenteGuard)
@Controller('cameras/agente')
export class CamerasAgenteController {
  constructor(private readonly agentes: CamerasAgenteService) {}

  @Get('config')
  @ApiOperation({ summary: 'Configuração completa do agente: câmeras com RTSP, armado, análise e stream' })
  config(@Agente() agente: AgenteInfo) {
    return this.agentes.configDoAgente(agente);
  }

  @Post('heartbeat')
  @HttpCode(HttpStatus.OK)
  heartbeat(@Agente() agente: AgenteInfo, @Body() dto: HeartbeatDto) {
    return this.agentes.heartbeat(agente, dto);
  }

  @Post('miniaturas')
  @HttpCode(HttpStatus.OK)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'camera_id + arquivo `arquivo` (JPEG ≤ 2 MB)' })
  @UseInterceptors(upload('arquivo', 2))
  miniatura(@Agente() agente: AgenteInfo, @Body() dto: MiniaturaDto, @UploadedFile() file?: Express.Multer.File) {
    return this.agentes.miniatura(agente, dto, file);
  }

  @Post('eventos')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'camera_id, tipo, inicio_em, fim_em?, confianca?, dados? + arquivo `snapshot` (JPEG ≤ 3 MB)' })
  @UseInterceptors(upload('snapshot', 3))
  evento(@Agente() agente: AgenteInfo, @Body() dto: EventoAgenteDto, @UploadedFile() file?: Express.Multer.File) {
    return this.agentes.evento(agente, dto, file);
  }

  @Post('eventos/:id/fim')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '{ fim_em, dados?, tipo?, confianca?, caixas? } — dados entra por merge raso; tipo sobe movimento → classe' })
  fimEvento(@Agente() agente: AgenteInfo, @Param('id') id: string, @Body() dto: FimEventoDto) {
    return this.agentes.fimEvento(agente, id, dto);
  }

  @Post('eventos/:id/classificacao')
  @HttpCode(HttpStatus.OK)
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiOperation({
    summary:
      'tipo (pessoa|veiculo|animal), confianca 0..1, caixas? + arquivo `snapshot` (JPEG ≤ 3 MB, opcional). ' +
      'Só sobe de movimento para a classe; se passar a alertar, notifica uma vez. Idempotente.',
  })
  @UseInterceptors(upload('snapshot', 3))
  classificacao(
    @Agente() agente: AgenteInfo,
    @Param('id') id: string,
    @Body() dto: ClassificacaoEventoDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.agentes.classificacao(agente, id, dto, file);
  }

  @Post('eventos/:id/clipe')
  @HttpCode(HttpStatus.OK)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'arquivo `clipe` (MP4 ≤ 30 MB)' })
  @UseInterceptors(upload('clipe', 30))
  clipe(@Agente() agente: AgenteInfo, @Param('id') id: string, @UploadedFile() file?: Express.Multer.File) {
    return this.agentes.clipe(agente, id, file);
  }

  @Get('comandos')
  @ApiOperation({ summary: 'Comandos pendentes (ficam marcados como entregues)' })
  comandos(@Agente() agente: AgenteInfo) {
    return this.agentes.comandos(agente);
  }

  @Post('comandos/:id/resultado')
  @HttpCode(HttpStatus.OK)
  resultado(@Agente() agente: AgenteInfo, @Param('id') id: string, @Body() dto: ResultadoComandoDto) {
    return this.agentes.resultado(agente, id, dto);
  }
}
