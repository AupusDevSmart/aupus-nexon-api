import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpStatus,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, Public } from '@aupus/api-shared';
import { IotCatalogService } from './iot-catalog.service';
import { CreateIotDeviceModeloDto } from './dto/create-iot-device-modelo.dto';
import { CreateIotDeviceTipoDto } from './dto/create-iot-device-tipo.dto';
import { IotCatalogResponseDto } from './dto/iot-catalog-response.dto';
import { UpdateIotDeviceModeloDto } from './dto/update-iot-device-modelo.dto';
import { UpdateIotDeviceTipoDto } from './dto/update-iot-device-tipo.dto';

@ApiTags('iot-catalog')
@Controller('iot-catalog')
export class IotCatalogController {
  private readonly logger = new Logger(IotCatalogController.name);

  constructor(private readonly service: IotCatalogService) {}

  /**
   * Endpoint REST JSON do catalogo.
   *
   * Usado por:
   *  - UI admin (Fase 3) para edicao de tipos/modelos.
   *  - Hook React (useIotCatalog) — caminho limpo de longo prazo.
   *
   * Protegido por JWT pra alinhar com o restante das rotas. Editar = autenticado.
   * Se isso virar problema pro frontend, pode-se afrouxar pra "Public" pra leitura.
   */
  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Catalogo IoT completo (tipos + modelos)' })
  @ApiResponse({ status: HttpStatus.OK })
  async getCatalog(): Promise<IotCatalogResponseDto> {
    return this.service.getCatalog();
  }

  /**
   * Endpoint de compatibilidade com `iot-firmware-generator.v2.js`.
   *
   * Serve um arquivo JS que popula `window.DEVICE_POINTS`, `window.DEVICE_MODELS`
   * e os helpers (`getCatalogByType`, etc.). Substituicao direta do antigo
   * `/iot-device-catalog.v2.js` estatico.
   *
   * PUBLICO (sem auth) — carregado via <script> tag, browsers nao mandam
   * Authorization automaticamente. Nao tem dado confidencial no catalogo.
   *
   * Cache: Cache-Control max-age=60 + ETag.  ETag deriva do MAX(updated_at) das
   * tabelas. Quando admin salva mudanca, o version muda e o browser revalida.
   */
  @Get('device-catalog.js')
  @Public()
  @Header('Content-Type', 'application/javascript; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=60, must-revalidate')
  @ApiOperation({
    summary: 'Catalogo IoT em formato JS legado (compat com firmware-generator)',
    description: 'Gera o equivalente do antigo /iot-device-catalog.v2.js a partir do DB.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  async getLegacyJs(
    @Headers('if-none-match') etag: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const { content, version } = await this.service.getLegacyJs();
    if (etag && etag === version) {
      res.status(HttpStatus.NOT_MODIFIED).end();
      return;
    }
    res.setHeader('ETag', version);
    res.status(HttpStatus.OK).send(content);
  }

  // ==========================================================================
  // CRUD de tipos (autenticado)
  // ==========================================================================

  @Get('tipos')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Lista tipos IoT' })
  listTipos() {
    return this.service.listTipos();
  }

  @Get('tipos/:id')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Detalhe de tipo IoT' })
  findTipo(@Param('id') id: string) {
    return this.service.findTipo(id);
  }

  @Post('tipos')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Cria tipo IoT' })
  createTipo(@Body() dto: CreateIotDeviceTipoDto) {
    return this.service.createTipo(dto);
  }

  @Patch('tipos/:id')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Atualiza tipo IoT' })
  updateTipo(@Param('id') id: string, @Body() dto: UpdateIotDeviceTipoDto) {
    return this.service.updateTipo(id, dto);
  }

  @Delete('tipos/:id')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Remove tipo IoT (cascade nos modelos linkados)',
  })
  removeTipo(@Param('id') id: string) {
    return this.service.removeTipo(id);
  }

  // ==========================================================================
  // CRUD de modelos (autenticado)
  // ==========================================================================

  @Get('modelos')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Lista modelos IoT (filtra por ?tipo=codigo)' })
  listModelos(@Query('tipo') tipo?: string) {
    return this.service.listModelos(tipo);
  }

  @Get('modelos/:id')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Detalhe de modelo IoT' })
  findModelo(@Param('id') id: string) {
    return this.service.findModelo(id);
  }

  @Post('modelos')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Cria modelo IoT' })
  createModelo(@Body() dto: CreateIotDeviceModeloDto) {
    return this.service.createModelo(dto);
  }

  @Patch('modelos/:id')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Atualiza modelo IoT' })
  updateModelo(@Param('id') id: string, @Body() dto: UpdateIotDeviceModeloDto) {
    return this.service.updateModelo(id, dto);
  }

  @Delete('modelos/:id')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Remove modelo IoT' })
  removeModelo(@Param('id') id: string) {
    return this.service.removeModelo(id);
  }

  @Post('modelos/:id/duplicate')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Duplica modelo existente (mesmo tipo + mapeamento)',
    description: 'Util pra criar variantes (ex: SG250CX -> SG110CX so mudando num_mppts).',
  })
  duplicateModelo(@Param('id') id: string) {
    return this.service.duplicateModelo(id);
  }
}
