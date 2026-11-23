import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { Public } from '@/core';
import { CamerasAgenteService } from './cameras-agente.service';
import { CamerasAparelhoService } from './cameras-aparelho.service';
import { CamerasDespertarService } from './cameras-despertar.service';
import { TRECHO_ARQUIVO_MAX_MB } from './cameras-regras';
import { CamerasTrechosService } from './cameras-trechos.service';
import type { AgenteInfo } from './cameras.tipos';
import { ClassificacaoEventoDto, EventoAgenteDto, SenhaConhecidaDto, FimEventoDto, HeartbeatDto, MiniaturaDto, ResultadoComandoDto } from './dto/cameras-agente.dto';
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
  constructor(
    private readonly agentes: CamerasAgenteService,
    private readonly trechos: CamerasTrechosService,
    private readonly despertar: CamerasDespertarService,
    private readonly aparelho: CamerasAparelhoService,
  ) {}

  @Get('atualizacao')
  @ApiOperation({ summary: 'Versão publicada do programa do aparelho: { versao, sha256, tamanho }' })
  atualizacao(@Agente() agente: AgenteInfo) {
    return this.aparelho.infoAgente(agente);
  }

  @Get('atualizacao/arquivo')
  @ApiOperation({ summary: 'Pacote (tar.gz) da versão publicada; o aparelho confere o sha256' })
  atualizacaoArquivo(@Agente() agente: AgenteInfo, @Req() req: Request, @Res() res: Response) {
    return this.aparelho.arquivoAgente(agente, req, res);
  }

  @Get('config')
  @ApiOperation({
    summary: 'Configuração completa do agente: câmeras com RTSP, armado, análise e stream',
    description:
      'Com `aguardar` (s, até 25) e `seq` (o último recebido), a resposta espera até haver trabalho novo (vídeo pedido, comando) ou o tempo acabar.',
  })
  async config(@Agente() agente: AgenteInfo, @Query('aguardar') aguardar?: string, @Query('seq') seq?: string) {
    const espera = Number(aguardar);
    if (Number.isFinite(espera) && espera > 0) {
      const visto = seq !== undefined && seq !== '' && Number.isFinite(Number(seq)) ? Number(seq) : undefined;
      await this.despertar.aguardar(agente.id, espera, visto);
    }
    const sinal = this.despertar.seq(agente.id);
    return { ...(await this.agentes.configDoAgente(agente)), seq: sinal };
  }

  @Post('descobertas/senha-conhecida')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Câmera da rede aceitou a senha de outra câmera da usina: cadastra sozinha (copia a senha cifrada)' })
  senhaConhecida(@Agente() agente: AgenteInfo, @Body() dto: SenhaConhecidaDto) {
    return this.agentes.senhaConhecida(agente, dto.ip, dto.camera_id);
  }

  @Post('heartbeat')
  @HttpCode(HttpStatus.OK)
  async heartbeat(@Agente() agente: AgenteInfo, @Body() dto: HeartbeatDto) {
    const r = await this.agentes.heartbeat(agente, dto);
    // NEXON-108: aparelho novo numa versão velha se atualiza sozinho (falha aqui não derruba o heartbeat)
    await this.aparelho.atualizarSozinho(agente.id, dto.versao).catch(() => undefined);
    return r;
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

  @Post('comandos/:id/arquivo')
  @HttpCode(HttpStatus.OK)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      `NEXON-108: MP4 do comando \`trecho\` no campo \`arquivo\` (≤ ${TRECHO_ARQUIVO_MAX_MB} MB — nginx aceita 50M; ` +
      'até 300 s no sub-stream). Falha: POST comandos/:id/resultado { ok: false, erro }.',
  })
  @UseInterceptors(upload('arquivo', TRECHO_ARQUIVO_MAX_MB))
  arquivo(@Agente() agente: AgenteInfo, @Param('id') id: string, @UploadedFile() file?: Express.Multer.File) {
    return this.trechos.receber(agente, id, file);
  }

  @Post('comandos/:id/resultado')
  @HttpCode(HttpStatus.OK)
  resultado(@Agente() agente: AgenteInfo, @Param('id') id: string, @Body() dto: ResultadoComandoDto) {
    return this.agentes.resultado(agente, id, dto);
  }
}
