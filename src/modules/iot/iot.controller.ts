import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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
import { JwtAuthGuard, CurrentUser } from '@/core';

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

  @Get('projetos/:id/vinculos-bo')
  @ApiOperation({ summary: 'Projeção iot_vinculos(modbus_bo)→io_config.bo dos relés do projeto (Fase 6)' })
  @ApiResponse({ status: 200, description: 'Mapa { relayEquipId: { sinal: {...params, ponto_id} } }' })
  async projetarVinculosBo(
    @Param('id') id: string,
    @CurrentUser() user?: any,
  ): Promise<{ data: Record<string, Record<string, unknown>> }> {
    const data = await this.iotService.projetarVinculosBo(id, user);
    return { data };
  }

  @Put('equipamentos/:id/vinculos-bo')
  @ApiOperation({ summary: 'Grava o comando de relé (modbus_bo) direto no vínculo — fonte da verdade (Fase 6)' })
  @ApiResponse({ status: 200, description: '{ escritos: n }' })
  async escreverVinculosBo(
    @Param('id') id: string,
    @Body() body: { bo?: Record<string, unknown> },
    @CurrentUser() user?: any,
  ): Promise<{ data: { escritos: number } }> {
    const data = await this.iotService.escreverVinculosBo(id, body?.bo ?? {}, user);
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

  @Get('equipamento/:equipamentoId/comandos')
  @ApiOperation({ summary: 'Pontos de comando do equipamento que já têm vínculo (modbus_bo ou ton_bo)' })
  async comandosDoEquipamento(@Param('equipamentoId') equipamentoId: string, @CurrentUser() user?: any) {
    return { data: await this.iotService.comandosDoEquipamento(equipamentoId, user) };
  }

  @Get('disjuntor/:disjuntorId/scs-bundle')
  @ApiOperation({ summary: 'Bundle do sheet do DJ: SCS + PM + fonte de status + comandos' })
  @ApiResponse({ status: 200, description: 'Tudo que o sheet do DJ precisa (escopado por dono)' })
  async disjuntorScsBundle(
    @Param('disjuntorId') disjuntorId: string,
    @CurrentUser() user?: any,
  ) {
    return { data: await this.iotService.disjuntorScsBundle(disjuntorId, user) };
  }

  @Patch('disjuntor/:disjuntorId/scs')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Habilita/configura o SCS de um elemento do unifilar (declaração)' })
  async setDisjuntorScs(
    @Param('disjuntorId') disjuntorId: string,
    @Body() body: { scs?: boolean; scs_comando?: boolean; scs_status?: boolean; scs_medicao?: string },
    @CurrentUser() user?: any,
  ) {
    return { data: await this.iotService.setDisjuntorScs(disjuntorId, body ?? {}, user) };
  }

  @Get('ton/:tonId/elementos-scs')
  @ApiOperation({ summary: 'Elementos do unifilar com comando/status/medição + seus pontos lógicos' })
  async elementosScs(@Param('tonId') tonId: string, @CurrentUser() user?: any) {
    return { data: await this.iotService.elementosScs(tonId, user) };
  }

  @Get('unidade/:unidadeId/elementos-scs')
  @ApiOperation({ summary: 'Elementos com SCS da unidade + última telemetria (cards da Visão Geral)' })
  async elementosScsVisaoGeral(@Param('unidadeId') unidadeId: string, @CurrentUser() user?: any) {
    return { data: await this.iotService.elementosScsVisaoGeral(unidadeId, user) };
  }

  @Get('ton/:tonId/scs-config')
  @ApiOperation({ summary: 'Configurações SCS da TON: dispositivos conectados + associação + elementos SCS' })
  async tonScsConfig(@Param('tonId') tonId: string, @CurrentUser() user?: any) {
    return { data: await this.iotService.tonScsConfig(tonId, user) };
  }

  @Post('scs/vinculo')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Associa/desassocia um device da TON a um elemento SCS do unifilar' })
  async associarScs(
    @Body() body: { comp_id: string; elemento_equipamento_id: string | null },
    @CurrentUser() user?: any,
  ) {
    return { data: await this.iotService.associarScs(body.comp_id, body.elemento_equipamento_id ?? null, user) };
  }

  @Post('scs/pontos')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Salva a correspondência editada (título ↔ campo JSON) de um device' })
  async savePontosOverride(
    @Body() body: { comp_id: string; overrides: Record<string, string> },
    @CurrentUser() user?: any,
  ) {
    return { data: await this.iotService.savePontosOverride(body.comp_id, body.overrides ?? {}, user) };
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
