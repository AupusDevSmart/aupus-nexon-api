import { Module } from '@nestjs/common';
import { DiagramaGateway } from './diagrama.gateway';
import { MqttModule } from '../shared/mqtt/mqtt.module';

@Module({
  imports: [MqttModule],
  providers: [DiagramaGateway],
  exports: [DiagramaGateway],
})
export class WebSocketModule {}
