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
import { JwtAuthGuard, CurrentUser } from '@aupus/api-shared';

import { IoTService } from './iot.service';
import { MqttService } from '../../shared/mqtt/mqtt.service';
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
  constructor(
    private readonly iotService: IoTService,
    private readonly mqtt: MqttService,
  ) {}

  /**
   * Lista os boards de bancada vivos no namespace TESTE/ (modo simulação) —
   * MACs vistos publicando em TESTE/.../satellite/<MAC>/... nos últimos ~90s.
   * O painel de teste usa pro remap: você escolhe qual board físico de bancada
   * faz o papel da TON de produção, sem digitar MAC e sem tocar no cadastro.
   */
  @Get('sim/bench-satellites')
  @ApiOperation({ summary: 'Lista boards de bancada vivos no TESTE/ (simulação)' })
  @ApiResponse({ status: 200, description: 'Array de { mac, base, ageMs }' })
  async benchSatellites(): Promise<{
    data: Array<{ mac: string; base: string; ageMs: number; label: string | null }>;
  }> {
    return { data: this.mqtt.getBenchSatellites() };
  }

  @Get('projetos')
  @ApiOperation({ summary: 'Lista projetos IoT de uma unidade' })
  @ApiResponse({ status: 200, description: 'Array de projetos IoT' })
  async listProjetos(
    @Query() query: ListIotProjetosQueryDto,
    @CurrentUser() user?: any,
  ): Promise<{ data: IotProjetoRow[] }> {
    const data = await this.iotService.getProjetosByUnidade(query.unidade_id, user);
    return { data };
  }

  @Get('projetos/:id')
  @ApiOperation({ summary: 'Busca um projeto IoT pelo ID' })
  @ApiResponse({ status: 200, description: 'Projeto IoT (ou null se ausente)' })
  async getProjeto(
    @Param('id') id: string,
    @CurrentUser() user?: any,
  ): Promise<{ data: IotProjetoRow | null }> {
    const data = await this.iotService.getProjetoById(id, user);
    return { data };
  }

  @Post('projetos')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Cria novo projeto IoT vinculado a uma unidade' })
  @ApiResponse({ status: 201, description: 'Projeto IoT criado' })
  async createProjeto(
    @Body() dto: CreateIotProjetoDto,
    @CurrentUser() user?: any,
  ): Promise<{ data: IotProjetoRow }> {
    const data = await this.iotService.createProjeto(dto.unidade_id, dto.nome, user);
    return { data };
  }

  @Put('projetos/:id')
  @ApiOperation({ summary: 'Atualiza nome ou diagrama (ou ambos) de um projeto IoT' })
  @ApiResponse({ status: 200, description: 'Projeto IoT atualizado' })
  @ApiResponse({ status: 404, description: 'Projeto nao encontrado' })
  async updateProjeto(
    @Param('id') id: string,
    @Body() dto: UpdateIotProjetoDto,
    @CurrentUser() user?: any,
  ): Promise<{ data: IotProjetoRow }> {
    const data = await this.iotService.updateProjeto(id, dto, user);
    return { data };
  }

  @Get('power-meter-by-disjuntor/:disjuntorId')
  @ApiOperation({ summary: 'Resolve o Power Meter (IoT) associado a um disjuntor do unifilar' })
  @ApiResponse({ status: 200, description: '{ equipamento_id, nome } do PM associado, ou null' })
  async powerMeterByDisjuntor(
    @Param('disjuntorId') disjuntorId: string,
  ): Promise<{ data: { equipamento_id: string; nome: string | null } | null }> {
    const data = await this.iotService.powerMeterByDisjuntor(disjuntorId);
    return { data };
  }

  @Get('disjuntor-status-fonte/:disjuntorId')
  @ApiOperation({
    summary:
      'Resolve o relé que fornece o status aberto/fechado de um disjuntor (via io_config.bi)',
  })
  @ApiResponse({
    status: 200,
    description:
      '{ rele_equipamento_id, rele_nome, campo_aberto, campo_fechado } — de quem assinar a telemetria e quais campos ler. null se o DJ nao tem relé associado.',
  })
  async disjuntorStatusFonte(
    @Param('disjuntorId') disjuntorId: string,
    @CurrentUser() user?: any,
  ): Promise<{
    data: {
      rele_equipamento_id: string;
      rele_nome: string | null;
      campo_aberto: string | null;
      campo_fechado: string | null;
    } | null;
  }> {
    const data = await this.iotService.statusFonteDoDisjuntor(disjuntorId, user);
    return { data };
  }

  @Delete('projetos/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft-delete de um projeto IoT' })
  @ApiResponse({ status: 200, description: 'Soft-delete confirmado' })
  @ApiResponse({ status: 404, description: 'Projeto nao encontrado' })
  async deleteProjeto(
    @Param('id') id: string,
    @CurrentUser() user?: any,
  ): Promise<{ success: true }> {
    await this.iotService.deleteProjeto(id, user);
    return { success: true };
  }
}
