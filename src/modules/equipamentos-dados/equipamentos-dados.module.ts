import { Module } from '@nestjs/common';
import { EquipamentosDadosController } from './equipamentos-dados.controller';
import { EquipamentosDadosService } from './equipamentos-dados.service';
import { ClassificacaoHorariosService } from './services/classificacao-horarios.service';
import { CalculoCustosService } from './services/calculo-custos.service';
import { ConfiguracaoCustoService } from './services/configuracao-custo.service';
import { FeriadosNacionaisService } from './services/feriados-nacionais.service';
import { MqttIngestionService } from './services/mqtt-ingestion.service';
import { GatewayGraficosService } from './services/gateway-graficos.service';
import { GatewayDashboardService } from './services/gateway-dashboard.service';
import { PrismaModule } from '@/core';

@Module({
  imports: [PrismaModule],
  controllers: [EquipamentosDadosController],
  providers: [
    EquipamentosDadosService,
    ClassificacaoHorariosService,
    CalculoCustosService,
    ConfiguracaoCustoService,
    FeriadosNacionaisService,
    MqttIngestionService,
    GatewayGraficosService,
    GatewayDashboardService,
  ],
  exports: [
    EquipamentosDadosService,
    MqttIngestionService,
    CalculoCustosService,
    ClassificacaoHorariosService,
    ConfiguracaoCustoService,
  ],
})
export class EquipamentosDadosModule {}
