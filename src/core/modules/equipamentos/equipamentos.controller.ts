import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  HttpStatus,
  HttpCode,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import * as fs from 'fs';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiConsumes, ApiParam } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { EquipamentosService } from './equipamentos.service';
import { EquipamentosDataService } from './services/equipamentos-data.service';
import { AnexosEquipamentosService } from './anexos-equipamentos.service';
import { CreateEquipamentoDto } from './dto/create-equipamento.dto';
import { UpdateEquipamentoDto } from './dto/update-equipamento.dto';
import { EquipamentoQueryDto } from './dto/equipamento-query.dto';
import { CreateComponenteUARDto } from './dto/componente-uar.dto';
import { ConfigurarMqttDto } from './dto/configurar-mqtt.dto';
import { CreateEquipamentoRapidoDto } from './dto/create-equipamento-rapido.dto';
import { CreateEquipamentosLoteDto } from './dto/create-equipamentos-lote.dto';
import { ProximoSequencialDto } from './dto/proximo-sequencial.dto';
import { ReplicarAnexosDto } from './dto/replicar-anexos.dto';
import { UserProprietarioId } from '../auth/decorators/user-proprietario.decorator';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@ApiTags('Equipamentos')
@Controller('equipamentos')
export class EquipamentosController {
  constructor(
    private readonly equipamentosService: EquipamentosService,
    private readonly equipamentosDataService: EquipamentosDataService,
    private readonly anexosService: AnexosEquipamentosService,
  ) {}

  @Post()
  @Permissions('equipamentos.manage')
  @ApiOperation({ summary: 'Criar novo equipamento/componente' })
  @ApiResponse({ status: 201, description: 'Equipamento criado com sucesso' })
  @ApiResponse({ status: 400, description: 'Dados inválidos' })
  create(@Body() createDto: CreateEquipamentoDto) {
    return this.equipamentosService.create(createDto);
  }

  @Post('lote')
  @Permissions('equipamentos.manage')
  @ApiOperation({
    summary: 'Cadastrar vários equipamentos iguais de uma vez',
    description:
      'O bloco comum vale para todos; o array de itens traz o que muda entre eles ' +
      '(nome, TAG, número de série e localização específica). Ou entram todos, ou ' +
      'não entra nenhum. O plano de manutenção não faz parte do lote: ele é ' +
      'vinculado por equipamento depois.',
  })
  @ApiResponse({ status: 201, description: 'Equipamentos criados' })
  @ApiResponse({ status: 400, description: 'Lote recusado — a mensagem lista o que corrigir' })
  criarEmLote(@Body() dto: CreateEquipamentosLoteDto) {
    return this.equipamentosService.criarEmLote(dto);
  }

  @Post('rapido')
  @Permissions('equipamentos.manage')
  @ApiOperation({
    summary: 'Criar equipamento rapidamente com dados mínimos',
    description: 'Cria equipamento para uso imediato no diagrama. Apenas tipo e unidade são obrigatórios. O nome é gerado automaticamente se não fornecido. Dados completos podem ser preenchidos depois na página de cadastro.'
  })
  @ApiResponse({
    status: 201,
    description: 'Equipamento criado rapidamente. Complete os dados depois.',
    schema: {
      example: {
        success: true,
        message: 'Equipamento criado rapidamente. Complete os dados depois na página de cadastro.',
        data: {
          id: 'cmhcg1w27000ejqo84gbjeyty',
          nome: 'Medidor 1',
          tag: 'MED-001',
          classificacao: 'UC',
          criticidade: '3',
          em_operacao: 'sim',
          tipoEquipamento: {
            id: '01JAQTE1MOTOR000000000017',
            codigo: 'MEDIDOR',
            nome: 'Medidor de Energia'
          }
        }
      }
    }
  })
  @ApiResponse({ status: 400, description: 'Dados inválidos' })
  @ApiResponse({ status: 404, description: 'Unidade ou tipo de equipamento não encontrado' })
  criarEquipamentoRapido(@Body() createDto: CreateEquipamentoRapidoDto) {
    return this.equipamentosService.criarEquipamentoRapido(createDto);
  }

  @Get()
  @Permissions('equipamentos.view')
  @ApiOperation({ summary: 'Listar equipamentos com filtros e paginação. Usuários não-admin veem apenas seus equipamentos.' })
  @ApiResponse({ status: 200, description: 'Lista de equipamentos' })
  findAll(
    @Query() query: EquipamentoQueryDto,
    @UserProprietarioId() autoProprietarioId: string | null,
    @CurrentUser() user: any
  ) {
    return this.equipamentosService.findAll({
      ...query,
      proprietario_id: autoProprietarioId || query.proprietario_id
    }, user);
  }

  @Get('proximo-sequencial')
  @Permissions('equipamentos.view')
  @ApiOperation({
    summary: 'De onde continuar a numeração de nomes e TAGs',
    description:
      'Devolve o próximo número livre para um prefixo. Nome conta por unidade; TAG conta ' +
      'global. Usado pelo cadastro em lote e pelo duplicar para que o novo equipamento ' +
      'siga o que já existe, e não o que foi copiado.',
  })
  @ApiResponse({ status: 200, description: '{ proximo_nome, proximo_tag }' })
  proximoSequencial(@Query() dto: ProximoSequencialDto) {
    return this.equipamentosService.proximoSequencial(dto);
  }

  @Get('ucs-disponiveis')
  @Permissions('equipamentos.view')
  @ApiOperation({ summary: 'Listar equipamentos UC disponíveis para serem pais de UAR' })
  @ApiResponse({ status: 200, description: 'Lista de equipamentos UC' })
  findEquipamentosUC() {
    return this.equipamentosService.findEquipamentosUC();
  }

  // ==================== ANEXOS ====================
  // ATENÇÃO à ordem: estas rotas precisam vir ANTES de @Get(':id') e
  // @Delete(':id'). O Nest casa na ordem de declaração, e depois de :id um
  // GET /equipamentos/anexos/xxx/download entraria em findOne com id='anexos'.

  @Get('anexos/:anexoId/download')
  @Permissions('equipamentos.view')
  @ApiOperation({ summary: 'Baixar um anexo do equipamento' })
  @ApiResponse({ status: 200, description: 'Download iniciado' })
  @ApiResponse({ status: 404, description: 'Anexo não encontrado' })
  async downloadAnexo(
    @Param('anexoId') anexoId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const anexo = await this.anexosService.buscarAnexo(anexoId);
    const caminho = await this.anexosService.obterCaminhoArquivo(anexoId);

    res.set({
      'Content-Type': anexo.mime_type,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(anexo.nome_original)}"`,
      'Content-Length': anexo.tamanho.toString(),
    });

    return new StreamableFile(fs.createReadStream(caminho));
  }

  @Delete('anexos/:anexoId')
  @Permissions('equipamentos.manage')
  @ApiOperation({ summary: 'Remover anexo do equipamento' })
  @ApiResponse({ status: 200, description: 'Anexo removido' })
  removerAnexo(@Param('anexoId') anexoId: string) {
    return this.anexosService.removerAnexo(anexoId);
  }

  @Post('anexos/replicar')
  @Permissions('equipamentos.manage')
  @ApiOperation({
    summary: 'Copiar os anexos de um equipamento para outros',
    description:
      'Cria registros próprios para cada destino apontando para os mesmos arquivos ' +
      'em disco. Cada equipamento passa a gerenciar a sua lista de forma ' +
      'independente, sem multiplicar o arquivo no servidor.',
  })
  @ApiResponse({ status: 201, description: 'Anexos replicados' })
  replicarAnexos(@Body() dto: ReplicarAnexosDto) {
    return this.anexosService.replicarAnexos(dto.origem_equipamento_id, dto.destino_equipamento_ids);
  }

  @Post(':id/anexos')
  @Permissions('equipamentos.manage')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Enviar anexo (manual, datasheet, documento) do equipamento' })
  @ApiConsumes('multipart/form-data')
  @ApiResponse({ status: 201, description: 'Anexo enviado' })
  uploadAnexo(
    @Param('id') id: string,
    @UploadedFile() file: any,
    @Body('descricao') descricao?: string,
  ) {
    return this.anexosService.uploadAnexo(id, file, descricao);
  }

  @Get(':id/anexos')
  @Permissions('equipamentos.view')
  @ApiOperation({ summary: 'Listar anexos do equipamento' })
  @ApiResponse({ status: 200, description: 'Lista de anexos' })
  listarAnexos(@Param('id') id: string) {
    return this.anexosService.listarAnexos(id);
  }

  @Get(':id')
  @Permissions('equipamentos.view')
  @ApiOperation({ summary: 'Buscar equipamento por ID' })
  @ApiResponse({ status: 200, description: 'Equipamento encontrado' })
  @ApiResponse({ status: 404, description: 'Equipamento não encontrado' })
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.equipamentosService.findOne(id, user);
  }

  @Get(':id/componentes')
  @Permissions('equipamentos.view')
  @ApiOperation({ summary: 'Listar componentes UAR de um equipamento UC' })
  @ApiResponse({ status: 200, description: 'Lista de componentes' })
  @ApiResponse({ status: 404, description: 'Equipamento não encontrado' })
  findComponentes(@Param('id') id: string) {
    return this.equipamentosService.findComponentesByEquipamento(id);
  }

  @Patch(':id')
  @Permissions('equipamentos.manage')
  @ApiOperation({ summary: 'Atualizar equipamento' })
  @ApiResponse({ status: 200, description: 'Equipamento atualizado' })
  @ApiResponse({ status: 404, description: 'Equipamento não encontrado' })
  update(@Param('id') id: string, @Body() updateDto: UpdateEquipamentoDto) {
    return this.equipamentosService.update(id, updateDto);
  }

  @Delete(':id')
  @Permissions('equipamentos.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remover equipamento (soft delete)' })
  @ApiResponse({ status: 204, description: 'Equipamento removido' })
  @ApiResponse({ status: 404, description: 'Equipamento não encontrado' })
  remove(@Param('id') id: string) {
    return this.equipamentosService.remove(id);
  }

  @Get('uar/:id/detalhes')
  @Permissions('equipamentos.view')
  @ApiOperation({ summary: 'Buscar detalhes completos de um componente UAR' })
  @ApiResponse({ status: 200, description: 'Detalhes do componente UAR' })
  @ApiResponse({ status: 404, description: 'Componente UAR não encontrado' })
  findUARDetalhes(@Param('id') uarId: string) {
    return this.equipamentosService.findUARDetalhes(uarId);
  }

  @Get(':ucId/componentes/gerenciar')
  @Permissions('equipamentos.manage')
  @ApiOperation({ summary: 'Listar componentes UAR para gerenciamento de uma UC' })
  @ApiResponse({ status: 200, description: 'Lista de componentes com dados completos' })
  @ApiResponse({ status: 404, description: 'Equipamento UC não encontrado' })
  findComponentesParaGerenciar(@Param('ucId') ucId: string) {
    return this.equipamentosService.findComponentesParaGerenciar(ucId);
  }

  @Put(':ucId/componentes/batch')
  @Permissions('equipamentos.manage')
  @ApiOperation({ summary: 'Salvar múltiplos componentes UAR de uma vez' })
  @ApiResponse({ status: 200, description: 'Componentes salvos com sucesso' })
  salvarComponentesUAR(
    @Param('ucId') ucId: string,
    @Body() componentesDto: { componentes: CreateComponenteUARDto[] }
  ) {
    return this.equipamentosService.salvarComponentesUARLote(ucId, componentesDto.componentes);
  }

  @Get('unidade/:unidadeId/equipamentos')
  @Permissions('equipamentos.view')
  @ApiOperation({ summary: 'Listar equipamentos de uma unidade específica' })
  @ApiResponse({ status: 200, description: 'Lista de equipamentos da unidade' })
  findByUnidade(
    @Param('unidadeId') unidadeId: string,
    @Query() query: EquipamentoQueryDto,
    @CurrentUser() user: any
  ) {
    return this.equipamentosService.findByUnidade(unidadeId, query, user);
  }

  @Get('unidades/:unidadeId/estatisticas')
  @Permissions('equipamentos.view')
  @ApiOperation({ summary: 'Estatísticas dos equipamentos de uma unidade' })
  @ApiResponse({ status: 200, description: 'Estatísticas da unidade' })
  getEstatisticasUnidade(@Param('unidadeId') unidadeId: string) {
    return this.equipamentosService.getEstatisticasUnidade(unidadeId);
  }

  // ==========================================
  // Rotas de MQTT e Dados em Tempo Real
  // ==========================================

  @Post('virtual/:unidadeId/:tipo')
  @Permissions('equipamentos.manage')
  @ApiOperation({ summary: 'Criar componente visual (BARRAMENTO ou PONTO) para diagramas' })
  @ApiResponse({ status: 201, description: 'Componente visual criado' })
  @ApiResponse({ status: 404, description: 'Unidade não encontrada' })
  criarComponenteVisual(
    @Param('unidadeId') unidadeId: string,
    @Param('tipo') tipo: 'BARRAMENTO' | 'PONTO',
    @Body() body?: { nome?: string },
  ) {
    return this.equipamentosService.criarComponenteVisual(unidadeId, tipo, body?.nome);
  }

  @Patch(':id/mqtt')
  @Permissions('equipamentos.manage')
  @ApiOperation({ summary: 'Configurar tópico MQTT de um equipamento' })
  @ApiResponse({ status: 200, description: 'Configuração MQTT atualizada' })
  @ApiResponse({ status: 404, description: 'Equipamento não encontrado' })
  configurarMqtt(
    @Param('id') id: string,
    @Body() dto: ConfigurarMqttDto,
  ) {
    return this.equipamentosService.configurarMqtt(id, dto);
  }

  @Get(':id/dados/atual')
  @Permissions('equipamentos.view')
  @ApiOperation({ summary: 'Obter último dado recebido do equipamento' })
  @ApiResponse({ status: 200, description: 'Dado atual do equipamento' })
  @ApiResponse({ status: 404, description: 'Equipamento ou dado não encontrado' })
  obterDadoAtual(@Param('id') id: string) {
    return this.equipamentosDataService.obterDadoAtual(id);
  }

  @Get(':id/dados/historico')
  @Permissions('equipamentos.view')
  @ApiOperation({ summary: 'Obter histórico de dados do equipamento' })
  @ApiQuery({ name: 'inicio', required: false, description: 'Data/hora inicial (ISO 8601)' })
  @ApiQuery({ name: 'fim', required: false, description: 'Data/hora final (ISO 8601)' })
  @ApiQuery({ name: 'limite', required: false, description: 'Máximo de registros', type: Number })
  @ApiQuery({ name: 'intervalo', required: false, description: 'Agrupamento: raw, 1min, 5min, 1hour, 1day' })
  @ApiResponse({ status: 200, description: 'Histórico de dados' })
  @ApiResponse({ status: 404, description: 'Equipamento não encontrado' })
  obterHistorico(
    @Param('id') id: string,
    @Query('inicio') inicio?: string,
    @Query('fim') fim?: string,
    @Query('limite') limite?: string,
    @Query('intervalo') intervalo?: 'raw' | '1min' | '5min' | '1hour' | '1day',
  ) {
    return this.equipamentosDataService.obterHistorico(id, {
      inicio: inicio ? new Date(inicio) : undefined,
      fim: fim ? new Date(fim) : undefined,
      limite: limite ? parseInt(limite, 10) : undefined,
      intervalo: intervalo || 'raw',
    });
  }

  @Post(':id/upload-foto')
  @Permissions('equipamentos.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Upload de foto do equipamento' })
  @ApiConsumes('multipart/form-data')
  @ApiParam({ name: 'id', description: 'ID do equipamento' })
  @ApiResponse({
    status: 200,
    description: 'Foto atualizada com sucesso',
    schema: { type: 'object', properties: { fotoUrl: { type: 'string' } } },
  })
  @ApiResponse({ status: 400, description: 'Arquivo invalido' })
  @ApiResponse({ status: 404, description: 'Equipamento nao encontrado' })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: './uploads/equipamentos',
        filename: (_req, file, cb) => {
          const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
          cb(null, `foto-${uniqueSuffix}${extname(file.originalname)}`);
        },
      }),
      fileFilter: (_req, file, cb) => {
        if (!file.mimetype.match(/\/(jpg|jpeg|png|webp)$/)) {
          return cb(new BadRequestException('Apenas imagens jpg, jpeg, png ou webp sao permitidas'), false);
        }
        cb(null, true);
      },
      limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
    }),
  )
  uploadFoto(@Param('id') id: string, @UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('Arquivo nao enviado');
    }
    return this.equipamentosService.updateFoto(id, file.filename);
  }

  @Delete(':id/foto')
  @Permissions('equipamentos.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remover foto do equipamento' })
  @ApiParam({ name: 'id', description: 'ID do equipamento' })
  @ApiResponse({ status: 200, description: 'Foto removida com sucesso' })
  @ApiResponse({ status: 404, description: 'Equipamento nao encontrado' })
  removerFoto(@Param('id') id: string) {
    return this.equipamentosService.removeFoto(id);
  }
}