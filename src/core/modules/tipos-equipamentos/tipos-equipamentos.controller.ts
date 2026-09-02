import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Param,
  HttpStatus,
  Logger,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import { TiposEquipamentosService } from './tipos-equipamentos.service';
import { CreateTipoEquipamentoDto } from './dto/create-tipo-equipamento.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('tipos-equipamentos')
@Controller('tipos-equipamentos')
@UseGuards(JwtAuthGuard)
export class TiposEquipamentosController {
  private readonly logger = new Logger(TiposEquipamentosController.name);

  constructor(private readonly tiposEquipamentosService: TiposEquipamentosService) {}

  @Post()
  @ApiOperation({
    summary: 'Criar novo tipo de equipamento (modelo)',
    description: 'Cria um novo modelo de equipamento no catálogo',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Tipo de equipamento criado com sucesso',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Já existe um tipo com este código',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Categoria não encontrada ou dados inválidos',
  })
  async create(@Body() dto: CreateTipoEquipamentoDto) {
    this.logger.log(`📝 [CREATE TIPO] Criando novo tipo: ${dto.nome} (${dto.codigo})`);

    try {
      const tipo = await this.tiposEquipamentosService.create(dto);
      this.logger.log(`✅ [CREATE TIPO] Tipo criado com sucesso: ${tipo.id}`);

      return tipo;
    } catch (error) {
      this.logger.error(`❌ [CREATE TIPO] Erro:`, error.message);
      throw error;
    }
  }

  @Get()
  @ApiOperation({
    summary: 'Listar tipos de equipamentos (modelos)',
    description: 'Retorna catálogo de modelos de equipamentos disponíveis com filtros opcionais',
  })
  @ApiQuery({
    name: 'categoria_id',
    required: false,
    type: String,
    description: 'Filtrar por ID da categoria de equipamento',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Busca por código, nome ou fabricante',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Lista de tipos de equipamentos retornada com sucesso',
  })
  async findAll(
    @Query('categoria_id') categoria_id?: string,
    @Query('search') search?: string,
  ) {
    this.logger.log(`📋 [LIST TIPOS EQUIPAMENTOS] Buscando tipos de equipamentos`);
    this.logger.log(`📝 [LIST TIPOS EQUIPAMENTOS] Filtros - categoria_id: ${categoria_id}, search: ${search}`);

    try {
      const result = await this.tiposEquipamentosService.findAll(categoria_id, search);

      this.logger.log(`✅ [LIST TIPOS EQUIPAMENTOS] Encontrados ${result.data.length} tipos`);
      return result;

    } catch (error) {
      this.logger.error(`❌ [LIST TIPOS EQUIPAMENTOS] Erro:`, error.message);
      throw error;
    }
  }

  @Get('categorias')
  @ApiOperation({
    summary: 'Listar categorias',
    description: 'Retorna todas as categorias de tipos de equipamentos',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Lista de categorias retornada com sucesso',
  })
  async getCategorias() {
    this.logger.log(`📋 [LIST CATEGORIAS] Buscando categorias`);

    try {
      const result = await this.tiposEquipamentosService.getCategorias();
      this.logger.log(`✅ [LIST CATEGORIAS] Encontradas ${result.length} categorias`);
      return result;
    } catch (error) {
      this.logger.error(`❌ [LIST CATEGORIAS] Erro:`, error.message);
      throw error;
    }
  }

  @Get('estatisticas')
  @ApiOperation({
    summary: 'Estatísticas dos tipos',
    description: 'Retorna estatísticas sobre os tipos de equipamentos',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Estatísticas retornadas com sucesso',
  })
  async getEstatisticas() {
    this.logger.log(`📊 [ESTATISTICAS] Buscando estatísticas`);

    try {
      const result = await this.tiposEquipamentosService.getEstatisticas();
      this.logger.log(`✅ [ESTATISTICAS] Total: ${result.total} tipos`);
      return result;
    } catch (error) {
      this.logger.error(`❌ [ESTATISTICAS] Erro:`, error.message);
      throw error;
    }
  }

  @Get('codigo/:codigo')
  @ApiOperation({
    summary: 'Buscar tipo por código',
    description: 'Busca um tipo de equipamento por código (ex: M160, TRANSFORMADOR)',
  })
  @ApiParam({
    name: 'codigo',
    description: 'Código do tipo de equipamento',
    example: 'M160',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Tipo de equipamento encontrado',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Tipo de equipamento não encontrado',
  })
  async findByCode(@Param('codigo') codigo: string) {
    this.logger.log(`🔍 [FIND BY CODE] Buscando tipo com código: ${codigo}`);

    try {
      const tipo = await this.tiposEquipamentosService.findByCode(codigo);

      if (!tipo) {
        throw new NotFoundException(`Tipo de equipamento com código '${codigo}' não encontrado`);
      }

      this.logger.log(`✅ [FIND BY CODE] Tipo encontrado: ${tipo.nome}`);
      return tipo;
    } catch (error) {
      this.logger.error(`❌ [FIND BY CODE] Erro:`, error.message);
      throw error;
    }
  }

  @Get('codigo/:codigo/campos-tecnicos')
  @ApiOperation({
    summary: 'Buscar campos técnicos por código',
    description: 'Retorna os campos técnicos padrão para um tipo de equipamento (por código)',
  })
  @ApiParam({
    name: 'codigo',
    description: 'Código do tipo de equipamento',
    example: 'M160',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Campos técnicos retornados',
  })
  async getCamposTecnicosByCode(@Param('codigo') codigo: string) {
    this.logger.log(`🔧 [CAMPOS TECNICOS BY CODE] Buscando campos para código: ${codigo}`);

    try {
      const campos = await this.tiposEquipamentosService.getCamposTecnicosByCode(codigo);

      this.logger.log(`✅ [CAMPOS TECNICOS BY CODE] Encontrados ${campos.length} campos`);

      return {
        codigo,
        campos,
        mensagem: campos.length === 0 ? 'Nenhum campo técnico padrão definido para este tipo' : undefined,
      };
    } catch (error) {
      this.logger.error(`❌ [CAMPOS TECNICOS BY CODE] Erro:`, error.message);
      throw error;
    }
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Buscar tipo por ID',
    description: 'Busca um tipo de equipamento por ID',
  })
  @ApiParam({
    name: 'id',
    description: 'ID do tipo de equipamento',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Tipo de equipamento encontrado',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Tipo de equipamento não encontrado',
  })
  async findOne(@Param('id') id: string) {
    this.logger.log(`🔍 [FIND ONE] Buscando tipo com ID: ${id}`);

    try {
      const tipo = await this.tiposEquipamentosService.findOne(id);

      if (!tipo) {
        throw new NotFoundException(`Tipo de equipamento com ID '${id}' não encontrado`);
      }

      this.logger.log(`✅ [FIND ONE] Tipo encontrado: ${tipo.nome}`);
      return tipo;
    } catch (error) {
      this.logger.error(`❌ [FIND ONE] Erro:`, error.message);
      throw error;
    }
  }

  @Get(':id/campos-tecnicos')
  @ApiOperation({
    summary: 'Buscar campos técnicos por ID',
    description: 'Retorna os campos técnicos padrão para um tipo de equipamento',
  })
  @ApiParam({
    name: 'id',
    description: 'ID do tipo de equipamento',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Campos técnicos retornados',
  })
  async getCamposTecnicos(@Param('id') id: string) {
    this.logger.log(`🔧 [CAMPOS TECNICOS] Buscando campos para ID: ${id}`);

    try {
      const campos = await this.tiposEquipamentosService.getCamposTecnicos(id);

      this.logger.log(`✅ [CAMPOS TECNICOS] Encontrados ${campos.length} campos`);

      return {
        id,
        campos,
        mensagem: campos.length === 0 ? 'Nenhum campo técnico padrão definido para este tipo' : undefined,
      };
    } catch (error) {
      this.logger.error(`❌ [CAMPOS TECNICOS] Erro:`, error.message);
      throw error;
    }
  }
}
