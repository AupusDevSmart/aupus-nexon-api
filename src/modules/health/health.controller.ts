import { Controller, Get, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { HealthService } from './health.service';
import { AlertService } from './alert.service';
import { MetricsService } from './metrics.service';
import { Public } from '@aupus/api-shared';
import { PrismaService } from '@aupus/api-shared';

@ApiTags('Health Check')
@Controller('health')
export class HealthController {
  constructor(
    private readonly healthService: HealthService,
    private readonly alertService: AlertService,
    private readonly metricsService: MetricsService,
    private readonly prismaService: PrismaService,
  ) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Health check geral do sistema' })
  @ApiResponse({ status: 200, description: 'Sistema saudável' })
  @ApiResponse({ status: 503, description: 'Sistema com problemas' })
  async check() {
    return this.healthService.checkHealth();
  }

  @Get('mqtt')
  @Public()
  @ApiOperation({ summary: 'Health check específico do MQTT' })
  @ApiResponse({ status: 200, description: 'MQTT conectado' })
  @ApiResponse({ status: 503, description: 'MQTT desconectado' })
  async checkMqtt() {
    return this.healthService.checkMqttHealth();
  }

  @Get('database')
  @Public()
  @ApiOperation({ summary: 'Health check do banco de dados' })
  @ApiResponse({ status: 200, description: 'Banco conectado' })
  @ApiResponse({ status: 503, description: 'Banco desconectado' })
  async checkDatabase() {
    return this.healthService.checkDatabaseHealth();
  }

  @Get('dados-recentes')
  @Public()
  @ApiOperation({ summary: 'Verifica se há dados recentes sendo salvos' })
  @ApiResponse({ status: 200, description: 'Dados sendo salvos normalmente' })
  @ApiResponse({ status: 503, description: 'Sem dados recentes' })
  async checkRecentData() {
    return this.healthService.checkRecentDataHealth();
  }

  @Get('alerts')
  @Public()
  @ApiOperation({ summary: 'Retorna histórico de alertas' })
  @ApiResponse({ status: 200, description: 'Histórico de alertas' })
  async getAlerts() {
    return {
      alerts: this.alertService.getAlertHistory(),
      total: this.alertService.getAlertHistory().length,
    };
  }

  @Post('alerts/check')
  @Public()
  @ApiOperation({ summary: 'Força verificação manual do sistema' })
  @ApiResponse({ status: 200, description: 'Verificação executada' })
  async triggerManualCheck() {
    await this.alertService.triggerManualCheck();
    return {
      message: 'Verificação manual executada com sucesso',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('metrics')
  @Public()
  @ApiOperation({ summary: 'Retorna métricas detalhadas do MQTT' })
  @ApiResponse({ status: 200, description: 'Métricas do MQTT' })
  async getMetrics() {
    return this.metricsService.getMqttMetrics();
  }

  @Get('metrics/simple')
  @Public()
  @ApiOperation({ summary: 'Retorna métricas simplificadas do MQTT' })
  @ApiResponse({ status: 200, description: 'Métricas simplificadas' })
  async getSimpleMetrics() {
    return this.metricsService.getSimpleMetrics();
  }

  @Get('metrics/database')
  @Public()
  @ApiOperation({ summary: 'Retorna métricas de queries do banco de dados' })
  @ApiResponse({ status: 200, description: 'Métricas de queries do banco' })
  async getDatabaseMetrics() {
    return {
      database: this.prismaService.getQueryMetrics(),
      timestamp: new Date().toISOString(),
    };
  }
}
