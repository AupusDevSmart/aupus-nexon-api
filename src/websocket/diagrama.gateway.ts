import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { MqttService } from '../shared/mqtt/mqtt.service';

@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/ws/diagramas',
})
export class DiagramaGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  constructor(private mqttService: MqttService) {}

  afterInit(server: Server) {
    // console.log('✅ WebSocket Gateway inicializado');

    // Escutar eventos do MQTT e repassar via WebSocket
    this.mqttService.on('equipamento_dados', (event) => {
      this.enviarAtualizacaoEquipamento(event);
    });

    // Entradas digitais (BI) — estado on-change dos inputs do TON
    this.mqttService.on('equipamento_inputs', (event) => {
      this.enviarInputsEquipamento(event);
    });
  }

  handleConnection(client: Socket) {
    // console.log(`🔌 Cliente conectado: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    // console.log(`🔌 Cliente desconectado: ${client.id}`);
  }

  /**
   * Cliente se inscreve para receber atualizações de um diagrama
   */
  @SubscribeMessage('subscribe_diagrama')
  handleSubscribeDiagrama(
    @MessageBody() data: { diagramaId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const { diagramaId } = data;
    const room = `diagrama:${diagramaId}`;

    client.join(room);
    // console.log(`📡 Cliente ${client.id} inscrito no diagrama ${diagramaId}`);

    return {
      event: 'subscribed',
      data: { diagramaId },
    };
  }

  /**
   * Cliente se desinscreve de um diagrama
   */
  @SubscribeMessage('unsubscribe_diagrama')
  handleUnsubscribeDiagrama(
    @MessageBody() data: { diagramaId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const { diagramaId } = data;
    const room = `diagrama:${diagramaId}`;

    client.leave(room);
    // console.log(`📡 Cliente ${client.id} desinscrito do diagrama ${diagramaId}`);

    return {
      event: 'unsubscribed',
      data: { diagramaId },
    };
  }

  /**
   * Cliente se inscreve para receber atualizações de um equipamento específico
   */
  @SubscribeMessage('subscribe_equipamento')
  handleSubscribeEquipamento(
    @MessageBody() data: { equipamentoId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const { equipamentoId } = data;
    const room = `equipamento:${equipamentoId}`;

    client.join(room);
    // console.log(
    //   `📡 Cliente ${client.id} inscrito no equipamento ${equipamentoId}`,
    // );

    return {
      event: 'subscribed',
      data: { equipamentoId },
    };
  }

  /**
   * Cliente se desinscreve de um equipamento
   */
  @SubscribeMessage('unsubscribe_equipamento')
  handleUnsubscribeEquipamento(
    @MessageBody() data: { equipamentoId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const { equipamentoId } = data;
    const room = `equipamento:${equipamentoId}`;

    client.leave(room);
    // console.log(
    //   `📡 Cliente ${client.id} desinscrito do equipamento ${equipamentoId}`,
    // );

    return {
      event: 'unsubscribed',
      data: { equipamentoId },
    };
  }

  /**
   * Envia atualização de equipamento para clientes conectados
   */
  private enviarAtualizacaoEquipamento(event: any) {
    const { equipamentoId, diagramaId, dados } = event;

    // console.log('📤 [WebSocket] Emitindo dados do equipamento', equipamentoId);
    // console.log('📤 [WebSocket] Estrutura do event:', {
    //   temEquipamentoId: !!equipamentoId,
    //   temDiagramaId: !!diagramaId,
    //   temDados: !!dados,
    //   temDados_dados: !!dados?.dados,
    //   temTimestamp: !!dados?.timestamp_dados,
    // });

    // Enviar para sala do diagrama
    if (diagramaId) {
      const roomDiagrama = `diagrama:${diagramaId}`;
      this.server.to(roomDiagrama).emit('equipamento_update', {
        type: 'equipamento_update',
        equipamentoId,
        dados: dados.dados,
        timestamp: dados.timestamp_dados,
        qualidade: dados.qualidade,
      });
    }

    // Enviar para sala específica do equipamento (se houver cliente escutando)
    const roomEquipamento = `equipamento:${equipamentoId}`;
    this.server.to(roomEquipamento).emit('equipamento_dados', {
      type: 'equipamento_dados',
      equipamentoId,
      dados: dados.dados,
      timestamp: dados.timestamp_dados,
      qualidade: dados.qualidade,
    });
  }

  /**
   * Envia estado das entradas digitais (BI) para clientes conectados.
   * event: { equipamentoId, diagramaId, estado: {d1..d6} }
   */
  private enviarInputsEquipamento(event: any) {
    const { equipamentoId, diagramaId, estado } = event;

    const payload = {
      type: 'equipamento_inputs',
      equipamentoId,
      estado,
    };

    if (diagramaId) {
      this.server.to(`diagrama:${diagramaId}`).emit('equipamento_inputs', payload);
    }
    this.server.to(`equipamento:${equipamentoId}`).emit('equipamento_inputs', payload);
  }
}
