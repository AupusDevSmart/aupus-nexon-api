import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseInterceptors,
  UploadedFile,
  HttpStatus,
  Res,
  StreamableFile,
  HttpCode,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiResponse, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { ConcessionariasService } from './concessionarias.service';
import { AnexosConcessionariasService } from './anexos-concessionarias.service';
import {
  CreateConcessionariaDto,
  UpdateConcessionariaDto,
  ConcessionariaQueryDto,
  UploadAnexoDto,
  AnexoConcessionariaResponseDto,
} from './dto';
import { Response } from 'express';
import * as fs from 'fs';

@ApiTags('Concessionárias')
@Controller('concessionarias')
export class ConcessionariasController {
  constructor(
    private readonly concessionariasService: ConcessionariasService,
    private readonly anexosService: AnexosConcessionariasService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Criar nova concessionária' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Concessionária criada com sucesso',
  })
  @ApiResponse({ status: 400, description: 'Dados inválidos' })
  create(@Body() createDto: CreateConcessionariaDto) {
    return this.concessionariasService.create(createDto);
  }

  @Get()
  @ApiOperation({ summary: 'Listar concessionárias com filtros e paginação' })
  @ApiResponse({ status: 200, description: 'Lista de concessionárias' })
  findAll(@Query() query: ConcessionariaQueryDto) {
    return this.concessionariasService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Buscar concessionária por ID' })
  @ApiResponse({ status: 200, description: 'Concessionária encontrada' })
  @ApiResponse({ status: 404, description: 'Concessionária não encontrada' })
  findOne(@Param('id') id: string) {
    return this.concessionariasService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Atualizar concessionária' })
  @ApiResponse({ status: 200, description: 'Concessionária atualizada' })
  @ApiResponse({ status: 404, description: 'Concessionária não encontrada' })
  update(@Param('id') id: string, @Body() updateDto: UpdateConcessionariaDto) {
    return this.concessionariasService.update(id, updateDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remover concessionária (soft delete)' })
  @ApiResponse({ status: 204, description: 'Concessionária removida' })
  @ApiResponse({ status: 404, description: 'Concessionária não encontrada' })
  remove(@Param('id') id: string) {
    return this.concessionariasService.remove(id);
  }

  // ==================== ENDPOINTS DE ANEXOS ====================

  @Post(':id/anexos')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Fazer upload de anexo para concessionária' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'Upload de arquivo para concessionária',
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Arquivo a ser enviado (PDF, PNG, JPG, DOC, XLS)',
        },
        descricao: {
          type: 'string',
          description: 'Descrição opcional do anexo',
        },
      },
      required: ['file'],
    },
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Anexo enviado com sucesso',
    type: AnexoConcessionariaResponseDto,
  })
  async uploadAnexo(
    @Param('id') concessionariaId: string,
    @UploadedFile() file: any,
    @Body() uploadDto: UploadAnexoDto,
  ) {
    return this.anexosService.uploadAnexo(concessionariaId, file, uploadDto.descricao);
  }

  @Get(':id/anexos')
  @ApiOperation({ summary: 'Listar anexos de uma concessionária' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Lista de anexos da concessionária',
    type: [AnexoConcessionariaResponseDto],
  })
  async listarAnexosConcessionaria(@Param('id') concessionariaId: string) {
    return this.anexosService.listarAnexosConcessionaria(concessionariaId);
  }

  @Get('anexos/:anexoId')
  @ApiOperation({ summary: 'Buscar informações de um anexo específico' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Informações do anexo',
    type: AnexoConcessionariaResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Anexo não encontrado',
  })
  async buscarAnexo(@Param('anexoId') anexoId: string) {
    return this.anexosService.buscarAnexo(anexoId);
  }

  @Get('anexos/:anexoId/download')
  @ApiOperation({ summary: 'Fazer download de um anexo' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Download do arquivo iniciado',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Anexo não encontrado',
  })
  async downloadAnexo(
    @Param('anexoId') anexoId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const anexo = await this.anexosService.buscarAnexo(anexoId);
    const caminhoArquivo = await this.anexosService.obterCaminhoArquivo(anexoId);

    // Configurar headers para download
    res.set({
      'Content-Type': anexo.mime_type,
      'Content-Disposition': `attachment; filename="${anexo.nome_original}"`,
      'Content-Length': anexo.tamanho.toString(),
    });

    // Criar stream do arquivo
    const fileStream = fs.createReadStream(caminhoArquivo);
    return new StreamableFile(fileStream);
  }

  @Delete('anexos/:anexoId')
  @ApiOperation({ summary: 'Remover anexo' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Anexo removido com sucesso',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Anexo não encontrado',
  })
  async removerAnexo(@Param('anexoId') anexoId: string) {
    await this.anexosService.removerAnexo(anexoId);
    return { message: 'Anexo removido com sucesso' };
  }

  // ==================== ENDPOINTS DE CÁLCULO DE TARIFAS ====================

  @Post(':id/calcular/a4-verde')
  @ApiOperation({ summary: 'Calcular custo usando tarifas A4 Verde' })
  @ApiResponse({ status: 200, description: 'Cálculo realizado com sucesso' })
  async calcularA4Verde(
    @Param('id') id: string,
    @Body()
    consumo: {
      demanda_d?: number;
      demanda_p?: number;
      consumo_d?: number;
      consumo_p?: number;
      consumo_fp?: number;
    },
  ) {
    return this.concessionariasService.calcularTarifaA4Verde(id, consumo);
  }

  @Post(':id/calcular/a3a-verde')
  @ApiOperation({ summary: 'Calcular custo usando tarifas A3a Verde' })
  @ApiResponse({ status: 200, description: 'Cálculo realizado com sucesso' })
  async calcularA3aVerde(
    @Param('id') id: string,
    @Body()
    consumo: {
      demanda_d?: number;
      demanda_p?: number;
      consumo_d?: number;
      consumo_p?: number;
      consumo_fp?: number;
    },
  ) {
    return this.concessionariasService.calcularTarifaA3aVerde(id, consumo);
  }

  @Post(':id/calcular/b')
  @ApiOperation({ summary: 'Calcular custo usando tarifas Grupo B' })
  @ApiResponse({ status: 200, description: 'Cálculo realizado com sucesso' })
  async calcularB(
    @Param('id') id: string,
    @Body() body: { consumo: number },
  ) {
    return this.concessionariasService.calcularTarifaB(id, body.consumo);
  }
}
