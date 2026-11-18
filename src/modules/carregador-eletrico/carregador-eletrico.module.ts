import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { MqttModule } from '../../shared/mqtt/mqtt.module';
import { OcppModule } from '../ocpp/ocpp.module';
import { CarregadorAuditoriaService } from './carregador-auditoria.service';
import { CarregadorEletricoController } from './carregador-eletrico.controller';
import { CarregadorEletricoService } from './carregador-eletrico.service';
import { CarregadorGestaoService } from './carregador-gestao.service';
import { CarregadorOcppRepositorio } from './carregador-ocpp.repositorio';
import { CarregadorOcppService } from './carregador-ocpp.service';

@Module({
  imports: [PrismaModule, forwardRef(() => MqttModule), OcppModule],
  controllers: [CarregadorEletricoController],
  providers: [
    CarregadorEletricoService,
    CarregadorOcppRepositorio,
    CarregadorOcppService,
    CarregadorAuditoriaService,
    CarregadorGestaoService,
  ],
  exports: [CarregadorEletricoService],
})
export class CarregadorEletricoModule {}
