import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { DiagramaGateway } from './diagrama.gateway';
import { MqttModule } from '../shared/mqtt/mqtt.module';

@Module({
  // JwtModule sem config: o gateway passa o JWT_SECRET na verificação (igual à JwtStrategy).
  imports: [MqttModule, JwtModule.register({})],
  providers: [DiagramaGateway],
  exports: [DiagramaGateway],
})
export class WebSocketModule {}
