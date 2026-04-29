import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@aupus/api-shared';

import { IoTService } from './iot.service';
import { CreateIotProjetoDto } from './dto/create-iot-projeto.dto';
import { UpdateIotProjetoDto } from './dto/update-iot-projeto.dto';
import { ListIotProjetosQueryDto } from './dto/list-iot-projetos.dto';
import type { IotProjetoRow } from './interfaces/iot-diagrama.interface';

/**
 * Controller dos projetos IoT (diagramas).
 * Consumido pela tab "IoT" do Sinoptico Ativo no frontend
 * (componente IoTDiagram em src/features/supervisorio/components/iot-diagram.tsx).
 *
 * Rotas (com globalPrefix 'api/v1'):
 *   GET    /api/v1/iot/projetos?unidade_id=...
 *   GET    /api/v1/iot/projetos/:id
 *   POST   /api/v1/iot/projetos
 *   PUT    /api/v1/iot/projetos/:id
 *   DELETE /api/v1/iot/projetos/:id
 *
 * Todas as rotas exigem autenticacao JWT. Decisao sobre `@Permissions(...)`
 * granular (ex: `iot.view`/`iot.manage`) deferida para refinamento futuro.
 *
 * Envelope de resposta padrao do projeto: { data: ... } para retornos com
 * conteudo, { success: true } para operacoes void (DELETE).
 */
@ApiTags('IoT')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('iot')
export class IoTController {
  constructor(private readonly iotService: IoTService) {}

  @Get('projetos')
  @ApiOperation({ summary: 'Lista projetos IoT de uma unidade' })
  @ApiResponse({ status: 200, description: 'Array de projetos IoT' })
  async listProjetos(
    @Query() query: ListIotProjetosQueryDto,
  ): Promise<{ data: IotProjetoRow[] }> {
    const data = await this.iotService.getProjetosByUnidade(query.unidade_id);
    return { data };
  }

  @Get('projetos/:id')
  @ApiOperation({ summary: 'Busca um projeto IoT pelo ID' })
  @ApiResponse({ status: 200, description: 'Projeto IoT (ou null se ausente)' })
  async getProjeto(
    @Param('id') id: string,
  ): Promise<{ data: IotProjetoRow | null }> {
    const data = await this.iotService.getProjetoById(id);
    return { data };
  }

  @Post('projetos')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Cria novo projeto IoT vinculado a uma unidade' })
  @ApiResponse({ status: 201, description: 'Projeto IoT criado' })
  async createProjeto(
    @Body() dto: CreateIotProjetoDto,
  ): Promise<{ data: IotProjetoRow }> {
    const data = await this.iotService.createProjeto(dto.unidade_id, dto.nome);
    return { data };
  }

  @Put('projetos/:id')
  @ApiOperation({ summary: 'Atualiza nome ou diagrama (ou ambos) de um projeto IoT' })
  @ApiResponse({ status: 200, description: 'Projeto IoT atualizado' })
  @ApiResponse({ status: 404, description: 'Projeto nao encontrado' })
  async updateProjeto(
    @Param('id') id: string,
    @Body() dto: UpdateIotProjetoDto,
  ): Promise<{ data: IotProjetoRow }> {
    const data = await this.iotService.updateProjeto(id, dto);
    return { data };
  }

  @Delete('projetos/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft-delete de um projeto IoT' })
  @ApiResponse({ status: 200, description: 'Soft-delete confirmado' })
  @ApiResponse({ status: 404, description: 'Projeto nao encontrado' })
  async deleteProjeto(
    @Param('id') id: string,
  ): Promise<{ success: true }> {
    await this.iotService.deleteProjeto(id);
    return { success: true };
  }
}
