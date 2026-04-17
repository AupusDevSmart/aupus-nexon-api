import { Controller, Get, Post, Optional } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { MqttDiagnosticsService } from './mqtt-diagnostics.service';
import { MqttRedisBufferService } from './mqtt-redis-buffer.service';

@ApiTags('MQTT Diagnostics')
@Controller('mqtt/diagnostico')
export class MqttDiagnosticsController {
  constructor(
    private readonly diagnosticsService: MqttDiagnosticsService,
    @Optional() private readonly redisBuffer?: MqttRedisBufferService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Diagnóstico completo do sistema MQTT' })
  @ApiResponse({ status: 200, description: 'Relatório de diagnóstico' })
  async getDiagnostics() {
    return this.diagnosticsService.getFullDiagnostics();
  }

  @Get('status')
  @ApiOperation({ summary: 'Status resumido do MQTT' })
  @ApiResponse({ status: 200, description: 'Status do sistema' })
  async getStatus() {
    return this.diagnosticsService.getStatus();
  }

  @Get('equipamentos')
  @ApiOperation({ summary: 'Lista de equipamentos e última recepção' })
  @ApiResponse({ status: 200, description: 'Lista de equipamentos MQTT' })
  async getEquipamentos() {
    return this.diagnosticsService.getEquipamentosStatus();
  }

  @Get('topicos')
  @ApiOperation({ summary: 'Lista de tópicos MQTT configurados' })
  @ApiResponse({ status: 200, description: 'Lista de tópicos' })
  async getTopicos() {
    return this.diagnosticsService.getTopicosStatus();
  }

  @Get('qualidade')
  @ApiOperation({ summary: 'Análise de qualidade dos dados' })
  @ApiResponse({ status: 200, description: 'Análise de qualidade' })
  async getQualidade() {
    return this.diagnosticsService.getQualidadeAnalise();
  }

  @Get('buffer/stats')
  @ApiOperation({ summary: 'Estatísticas do buffer Redis' })
  @ApiResponse({ status: 200, description: 'Estatísticas do buffer' })
  async getBufferStats() {
    if (!this.redisBuffer) {
      return {
        success: false,
        message: 'Redis buffer não está configurado',
      };
    }

    try {
      const stats = await this.redisBuffer.obterEstatisticas();
      const saude = await this.redisBuffer.verificarSaude();

      return {
        success: true,
        data: {
          ...stats,
          ...saude,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Erro ao obter estatísticas do buffer',
        error: error.message,
      };
    }
  }

  @Post('buffer/forcar-processamento')
  @ApiOperation({ summary: 'Força processamento imediato dos dados pendentes' })
  @ApiResponse({ status: 200, description: 'Processamento executado' })
  async forcarProcessamento() {
    if (!this.redisBuffer) {
      return {
        success: false,
        message: 'Redis buffer não está configurado',
      };
    }

    try {
      const resultado = await this.redisBuffer.forcarProcessamento();

      return {
        success: true,
        message: 'Processamento forçado com sucesso',
        data: resultado,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Erro ao forçar processamento',
        error: error.message,
      };
    }
  }

  @Get('buffer/health')
  @ApiOperation({ summary: 'Verifica saúde do buffer Redis' })
  @ApiResponse({ status: 200, description: 'Status de saúde' })
  async verificarSaudeBuffer() {
    if (!this.redisBuffer) {
      return {
        success: false,
        message: 'Redis buffer não está configurado',
        redis: 'disabled',
      };
    }

    try {
      const saude = await this.redisBuffer.verificarSaude();

      return {
        success: true,
        data: saude,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Erro ao verificar saúde',
        redis: 'offline',
        error: error.message,
      };
    }
  }
}
