import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  HttpCode,
  HttpStatus,
  Put,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { DiagramasService } from './services/diagramas.service';
import { EquipamentosDiagramaService } from './services/equipamentos-diagrama.service';
import { ConexoesDiagramaService } from './services/conexoes-diagrama.service';
import { CreateDiagramaDto } from './dto/create-diagrama.dto';
import { UpdateDiagramaDto } from './dto/update-diagrama.dto';
import {
  AddEquipamentoDiagramaDto,
  UpdateEquipamentoDiagramaDto,
  AddEquipamentosBulkDto,
} from './dto/add-equipamento-diagrama.dto';
import {
  CreateConexaoDto,
  CreateConexoesBulkDto,
} from './dto/create-conexao.dto';
import { SaveLayoutDto } from './dto/save-layout.dto';
import { UserProprietarioId } from '@aupus/api-shared';

@ApiTags('Diagramas Sinópticos')
// @ApiBearerAuth() // TODO: Descomentar quando implementar autenticação
// @UseGuards(JwtAuthGuard) // TODO: Descomentar quando implementar autenticação
@Controller('diagramas')
export class DiagramasController {
  constructor(
    private readonly diagramasService: DiagramasService,
    private readonly equipamentosDiagramaService: EquipamentosDiagramaService,
    private readonly conexoesDiagramaService: ConexoesDiagramaService,
  ) {}

  // ==================== ROTAS DE DIAGRAMAS ====================

  @Post()
  @ApiOperation({ summary: 'Criar novo diagrama' })
  @ApiResponse({
    status: 201,
    description: 'Diagrama criado com sucesso',
  })
  @ApiResponse({ status: 404, description: 'Unidade não encontrada' })
  async create(@Body() createDiagramaDto: CreateDiagramaDto) {
    console.log('📝 [DiagramasController] CREATE - Recebendo request para criar diagrama');
    console.log('   📋 Body completo:', JSON.stringify(createDiagramaDto, null, 2));
    console.log('   📋 Propriedades do body:', Object.keys(createDiagramaDto));

    try {
      const diagrama = await this.diagramasService.create(createDiagramaDto);
      console.log('   ✅ Diagrama criado com ID:', diagrama.id);
      return diagrama;
    } catch (error) {
      console.error('   ❌ ERRO ao criar diagrama:', error);
      console.error('   📋 Mensagem:', error.message);
      console.error('   📋 Stack:', error.stack);
      throw error;
    }
  }

  @Get('by-unidade/:unidadeId')
  @ApiOperation({
    summary: 'Listar diagramas de uma unidade',
    description: 'Retorna todos os diagramas vinculados a uma unidade específica. Usuários não-admin só veem diagramas de suas unidades.',
  })
  @ApiParam({ name: 'unidadeId', description: 'ID da unidade' })
  @ApiResponse({ status: 200, description: 'Lista de diagramas da unidade' })
  @ApiResponse({ status: 404, description: 'Unidade não encontrada ou sem permissão' })
  async findByUnidade(
    @Param('unidadeId') unidadeId: string,
    @UserProprietarioId() autoProprietarioId: string | null,
  ) {
    return this.diagramasService.findByUnidade(unidadeId, autoProprietarioId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obter diagrama por ID. Usuários não-admin só acessam diagramas de suas unidades.' })
  @ApiParam({ name: 'id', description: 'ID do diagrama' })
  @ApiQuery({
    name: 'includeData',
    required: false,
    type: Boolean,
    description: 'Incluir dados em tempo real dos equipamentos',
  })
  @ApiResponse({ status: 200, description: 'Diagrama encontrado' })
  @ApiResponse({ status: 404, description: 'Diagrama não encontrado ou sem permissão' })
  async findOne(
    @Param('id') id: string,
    @Query('includeData') includeData?: string,
    @UserProprietarioId() autoProprietarioId?: string | null
  ) {
    const includeDataBool = includeData === 'true';
    return this.diagramasService.findOne(id, includeDataBool, autoProprietarioId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Atualizar diagrama' })
  @ApiParam({ name: 'id', description: 'ID do diagrama' })
  @ApiResponse({ status: 200, description: 'Diagrama atualizado com sucesso' })
  @ApiResponse({ status: 404, description: 'Diagrama não encontrado' })
  async update(
    @Param('id') id: string,
    @Body() updateDiagramaDto: UpdateDiagramaDto,
  ) {
    console.log('🔄 [DiagramasController] UPDATE - Recebendo request para atualizar diagrama');
    console.log('   📋 Diagrama ID:', id);
    console.log('   📋 Body completo:', JSON.stringify(updateDiagramaDto, null, 2));
    console.log('   📋 Propriedades do body:', Object.keys(updateDiagramaDto));

    const diagrama = await this.diagramasService.update(id, updateDiagramaDto);

    console.log('   ✅ Diagrama atualizado com sucesso');
    return diagrama;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remover diagrama (soft delete)' })
  @ApiParam({ name: 'id', description: 'ID do diagrama' })
  @ApiResponse({ status: 200, description: 'Diagrama removido com sucesso' })
  @ApiResponse({ status: 404, description: 'Diagrama não encontrado' })
  async remove(@Param('id') id: string) {
    return this.diagramasService.remove(id);
  }

  // ==================== ROTAS DE EQUIPAMENTOS ====================

  @Post(':diagramaId/equipamentos')
  @ApiOperation({ summary: 'Adicionar equipamento ao diagrama' })
  @ApiParam({ name: 'diagramaId', description: 'ID do diagrama' })
  @ApiResponse({
    status: 201,
    description: 'Equipamento adicionado com sucesso',
  })
  @ApiResponse({ status: 404, description: 'Diagrama ou equipamento não encontrado' })
  @ApiResponse({ status: 409, description: 'Equipamento já está em outro diagrama' })
  async addEquipamento(
    @Param('diagramaId') diagramaId: string,
    @Body() dto: AddEquipamentoDiagramaDto,
  ) {
    return this.equipamentosDiagramaService.addEquipamento(diagramaId, dto);
  }

  @Patch(':diagramaId/equipamentos/:equipamentoId')
  @ApiOperation({ summary: 'Atualizar posição/propriedades do equipamento no diagrama' })
  @ApiParam({ name: 'diagramaId', description: 'ID do diagrama' })
  @ApiParam({ name: 'equipamentoId', description: 'ID do equipamento' })
  @ApiResponse({
    status: 200,
    description: 'Equipamento atualizado com sucesso',
  })
  @ApiResponse({ status: 404, description: 'Equipamento não encontrado no diagrama' })
  async updateEquipamento(
    @Param('diagramaId') diagramaId: string,
    @Param('equipamentoId') equipamentoId: string,
    @Body() dto: UpdateEquipamentoDiagramaDto,
  ) {
    return this.equipamentosDiagramaService.updateEquipamento(
      diagramaId,
      equipamentoId,
      dto,
    );
  }

  @Delete(':diagramaId/equipamentos/:equipamentoId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remover equipamento do diagrama' })
  @ApiParam({ name: 'diagramaId', description: 'ID do diagrama' })
  @ApiParam({ name: 'equipamentoId', description: 'ID do equipamento' })
  @ApiResponse({
    status: 200,
    description: 'Equipamento removido do diagrama',
  })
  @ApiResponse({ status: 404, description: 'Equipamento não encontrado no diagrama' })
  async removeEquipamento(
    @Param('diagramaId') diagramaId: string,
    @Param('equipamentoId') equipamentoId: string,
  ) {
    return this.equipamentosDiagramaService.removeEquipamento(
      diagramaId,
      equipamentoId,
    );
  }

  @Delete(':diagramaId/equipamentos')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remover todos os equipamentos de um diagrama' })
  @ApiParam({ name: 'diagramaId', description: 'ID do diagrama' })
  @ApiResponse({
    status: 200,
    description: 'Todos os equipamentos foram removidos',
  })
  async removeAllEquipamentos(@Param('diagramaId') diagramaId: string) {
    console.log('🗑️ [DiagramasController] REMOVE_ALL_EQUIPAMENTOS - Removendo todos os equipamentos');
    console.log('   📋 Diagrama ID:', diagramaId);

    const resultado = await this.equipamentosDiagramaService.removeAll(diagramaId);

    console.log('   ✅ Total removido:', resultado.totalRemovidos);
    return resultado;
  }

  @Post(':diagramaId/equipamentos/bulk')
  @ApiOperation({ summary: 'Adicionar múltiplos equipamentos de uma vez' })
  @ApiParam({ name: 'diagramaId', description: 'ID do diagrama' })
  @ApiResponse({
    status: 200,
    description: 'Equipamentos processados',
  })
  async addEquipamentosBulk(
    @Param('diagramaId') diagramaId: string,
    @Body() dto: AddEquipamentosBulkDto,
  ) {
    console.log('📦 [DiagramasController] BULK - Adicionando equipamentos em lote');
    console.log('   📋 Diagrama ID:', diagramaId);
    console.log('   📋 Quantidade de equipamentos:', dto.equipamentos?.length || 0);
    console.log('   📋 Equipamentos recebidos:', JSON.stringify(dto.equipamentos, null, 2));

    // Log detalhado das posições
    dto.equipamentos?.forEach((eq: any, idx: number) => {
      console.log(`   🎯 Equipamento [${idx + 1}]:`, {
        equipamentoId: eq.equipamentoId,
        posicao_x: eq.posicao?.x,
        posicao_y: eq.posicao?.y,
        rotacao: eq.rotacao
      });
    });

    const resultado = await this.equipamentosDiagramaService.addEquipamentosBulk(
      diagramaId,
      dto,
    );

    console.log('   ✅ Resultado do bulk:');
    console.log('      Adicionados:', resultado.adicionados);
    console.log('      Atualizados:', resultado.atualizados);
    console.log('      Erros:', resultado.erros);
    if (resultado.erros > 0) {
      console.log('      Detalhes dos erros:');
      resultado.equipamentos
        .filter((eq: any) => eq.status === 'error')
        .forEach((eq: any, idx: number) => {
          console.log(`         [${idx + 1}] ID: ${eq.equipamentoId}`);
          console.log(`             Erro: ${eq.error}`);
        });
    }

    return resultado;
  }

  // ==================== ROTAS DE CONEXÕES ====================

  @Post(':diagramaId/conexoes')
  @ApiOperation({ summary: 'Criar conexão entre equipamentos' })
  @ApiParam({ name: 'diagramaId', description: 'ID do diagrama' })
  @ApiResponse({
    status: 201,
    description: 'Conexão criada com sucesso',
  })
  @ApiResponse({ status: 404, description: 'Equipamento não encontrado no diagrama' })
  async createConexao(
    @Param('diagramaId') diagramaId: string,
    @Body() dto: CreateConexaoDto,
  ) {
    return this.conexoesDiagramaService.create(diagramaId, dto);
  }

  @Patch(':diagramaId/conexoes/:conexaoId')
  @ApiOperation({
    summary: 'Atualizar conexão',
    deprecated: true,
    description: 'DESCONTINUADO: Use PUT /diagramas/:id/layout para salvar o layout completo.'
  })
  @ApiParam({ name: 'diagramaId', description: 'ID do diagrama' })
  @ApiParam({ name: 'conexaoId', description: 'ID da conexão' })
  @ApiResponse({ status: 400, description: 'Endpoint descontinuado' })
  async updateConexao(
    @Param('diagramaId') diagramaId: string,
    @Param('conexaoId') conexaoId: string,
    @Body() _dto: any,
  ) {
    return this.conexoesDiagramaService.update(diagramaId, conexaoId, _dto);
  }

  @Delete(':diagramaId/conexoes/:conexaoId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remover conexão' })
  @ApiParam({ name: 'diagramaId', description: 'ID do diagrama' })
  @ApiParam({ name: 'conexaoId', description: 'ID da conexão' })
  @ApiResponse({ status: 200, description: 'Conexão removida com sucesso' })
  @ApiResponse({ status: 404, description: 'Conexão não encontrada' })
  async removeConexao(
    @Param('diagramaId') diagramaId: string,
    @Param('conexaoId') conexaoId: string,
  ) {
    return this.conexoesDiagramaService.remove(diagramaId, conexaoId);
  }

  @Post(':diagramaId/conexoes/bulk')
  @ApiOperation({ summary: 'Criar múltiplas conexões de uma vez' })
  @ApiParam({ name: 'diagramaId', description: 'ID do diagrama' })
  @ApiResponse({
    status: 201,
    description: 'Conexões processadas',
  })
  async createConexoesBulk(
    @Param('diagramaId') diagramaId: string,
    @Body() dto: CreateConexoesBulkDto,
  ) {
    return this.conexoesDiagramaService.createBulk(diagramaId, dto);
  }

  @Delete(':diagramaId/conexoes')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remover todas as conexões de um diagrama' })
  @ApiParam({ name: 'diagramaId', description: 'ID do diagrama' })
  @ApiResponse({
    status: 200,
    description: 'Todas as conexões foram removidas',
  })
  async removeAllConexoes(@Param('diagramaId') diagramaId: string) {
    console.log('🗑️ [DiagramasController] REMOVE_ALL - Removendo todas as conexões');
    console.log('   📋 Diagrama ID:', diagramaId);

    const resultado = await this.conexoesDiagramaService.removeAll(diagramaId);

    console.log('   ✅ Total removido:', resultado.totalRemovidas);
    return resultado;
  }

  @Post(':diagramaId/conexoes/remove-duplicates')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remover conexões duplicadas do diagrama' })
  @ApiParam({ name: 'diagramaId', description: 'ID do diagrama' })
  @ApiResponse({
    status: 200,
    description: 'Conexões duplicadas removidas',
  })
  async removeDuplicateConexoes(@Param('diagramaId') diagramaId: string) {
    console.log('🧹 [DiagramasController] REMOVE_DUPLICATES - Removendo duplicatas');
    console.log('   📋 Diagrama ID:', diagramaId);

    const resultado = await this.conexoesDiagramaService.removeDuplicates(diagramaId);

    console.log('   ✅ Duplicatas removidas:', resultado.totalDuplicadas);
    console.log('   ✅ Conexões únicas mantidas:', resultado.totalUnicas);
    return resultado;
  }

  // ==================== ROTA ATÔMICA DE LAYOUT (V2) ====================

  @Put(':id/layout')
  @ApiOperation({
    summary: 'Salvar layout completo do diagrama (V2 - Atômico)',
    description: 'Substitui todo o layout (equipamentos + conexões) em uma única transação. ' +
      'Estratégia: DELETE ALL + INSERT ALL. ~10x mais rápido que múltiplas requisições PATCH.'
  })
  @ApiParam({ name: 'id', description: 'ID do diagrama' })
  @ApiResponse({
    status: 200,
    description: 'Layout salvo com sucesso',
    schema: {
      example: {
        equipamentosAtualizados: 15,
        conexoesCriadas: 20,
        tempoMs: 234
      }
    }
  })
  @ApiResponse({ status: 404, description: 'Diagrama não encontrado' })
  @ApiResponse({ status: 400, description: 'Dados inválidos' })
  async saveLayout(
    @Param('id') diagramaId: string,
    @Body() dto: SaveLayoutDto,
  ) {
    const startTime = Date.now();

    console.log('💾 [DiagramasController] SAVE_LAYOUT - Salvamento atômico');
    console.log('   📋 Diagrama ID:', diagramaId);
    console.log('   📋 Equipamentos:', dto.equipamentos?.length || 0);
    console.log('   📋 Conexões:', dto.conexoes?.length || 0);

    const resultado = await this.diagramasService.saveLayout(diagramaId, dto);

    const tempoMs = Date.now() - startTime;
    console.log(`   ✅ Layout salvo em ${tempoMs}ms`);
    console.log(`      Equipamentos atualizados: ${resultado.equipamentosAtualizados}`);
    console.log(`      Conexões criadas: ${resultado.conexoesCriadas}`);

    return {
      ...resultado,
      tempoMs
    };
  }
}
