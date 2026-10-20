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
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { MqttService } from '../shared/mqtt/mqtt.service';
import { PrismaService } from '../core/prisma/prisma.service';
import { PermissionScopeService, ScopedUser } from '../core/modules/auth/permission-scope.service';

/** Token do cliente: `auth.token` (socket.io-client), `?token=` ou header Authorization. */
export function tokenDoHandshake(client: Pick<Socket, 'handshake'>): string | null {
  const h = client.handshake ?? ({} as Socket['handshake']);
  const doAuth = typeof h.auth?.token === 'string' ? h.auth.token : null;
  const daQuery = typeof h.query?.token === 'string' ? h.query.token : null;
  const header = typeof h.headers?.authorization === 'string' ? h.headers.authorization : null;
  const bruto = doAuth || daQuery || header;
  if (!bruto) return null;
  const t = bruto.replace(/^Bearer\s+/i, '').trim();
  return t || null;
}

/**
 * NEXON-20: o WebSocket só atende usuário logado e dentro do escopo. Os
 * dispositivos IoT falam MQTT com o broker (Mosquitto), não este gateway; aqui
 * só conectam o web e os apps.
 *
 * - Conexão sem JWT válido (mesmo segredo do HTTP) ou de usuário inativo: cai.
 * - `subscribe_equipamento`: assertEntityInScope (planta e, para operador, o
 *   equipamento liberado).
 * - `subscribe_diagrama`: planta/instalação do diagrama no escopo. O operador
 *   não entra na sala do diagrama inteiro: entra numa sala por equipamento
 *   liberado do diagrama, e só recebe a telemetria deles (PER-23).
 */
@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/ws/diagramas',
})
export class DiagramaGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(DiagramaGateway.name);

  constructor(
    private mqttService: MqttService,
    private jwt: JwtService,
    private config: ConfigService,
    private prisma: PrismaService,
    private scope: PermissionScopeService,
  ) {}

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

  async handleConnection(client: Socket) {
    const user = await this.autenticar(client);
    if (!user) {
      client.emit('nao_autorizado', { message: 'Faça login para receber os dados ao vivo' });
      client.disconnect(true);
      return;
    }
    client.data.user = user;
  }

  /** Valida o JWT como a JwtStrategy do HTTP (segredo, expiração, usuário ativo). */
  private async autenticar(client: Socket): Promise<ScopedUser & { nome?: string } | null> {
    const token = tokenDoHandshake(client);
    if (!token) return null;
    try {
      const payload: any = await this.jwt.verifyAsync(token, {
        secret: this.config.get<string>('JWT_SECRET') || 'your-secret-key-change-in-production',
      });
      const id = String(payload?.sub ?? '').trim();
      if (!id) return null;
      const u = await this.prisma.usuarios.findFirst({
        where: { id, deleted_at: null },
        select: { status: true },
      });
      if (!u || u.status !== 'Ativo') return null;
      return { id, role: payload.role ?? null, nome: payload.nome };
    } catch {
      return null;
    }
  }

  private usuario(client: Socket): (ScopedUser & { nome?: string }) | null {
    return (client.data?.user as ScopedUser) ?? null;
  }

  private negado(alvo: Record<string, string>) {
    return { event: 'subscribe_negado', data: { ...alvo, message: 'Recurso fora do escopo do usuario' } };
  }

  handleDisconnect(client: Socket) {
    // console.log(`🔌 Cliente desconectado: ${client.id}`);
  }

  /**
   * Cliente se inscreve para receber atualizações de um diagrama
   */
  @SubscribeMessage('subscribe_diagrama')
  async handleSubscribeDiagrama(
    @MessageBody() data: { diagramaId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const diagramaId = String(data?.diagramaId ?? '').trim();
    const user = this.usuario(client);
    if (!user || !diagramaId) return this.negado({ diagramaId });
    const diagrama = await this.prisma.diagramas_unitarios.findFirst({
      where: { id: diagramaId, deleted_at: null },
      select: { unidade_id: true },
    });
    if (!diagrama) return this.negado({ diagramaId });
    const unidadeId = diagrama.unidade_id.trim();

    const acesso = await this.scope.acessoPorEquipamento(user);
    if (acesso) {
      // Operador: só a planta não basta; salas por equipamento liberado do diagrama.
      try {
        await this.scope.assertEntityInScope('planta', (await this.plantaDaUnidade(unidadeId)) ?? '', user);
      } catch {
        return this.negado({ diagramaId });
      }
      const eqs = await this.prisma.equipamentos.findMany({
        where: { diagrama_id: diagramaId, deleted_at: null, id: { in: [...acesso.equipamentos] } },
        select: { id: true },
      });
      for (const e of eqs) client.join(`diagrama:${diagramaId}:eq:${e.id.trim()}`);
      return { event: 'subscribed', data: { diagramaId } };
    }

    try {
      await this.scope.assertEntityInScope('unidade', unidadeId, user);
    } catch {
      return this.negado({ diagramaId });
    }
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
    const diagramaId = String(data?.diagramaId ?? '').trim();
    const room = `diagrama:${diagramaId}`;

    client.leave(room);
    // Salas por equipamento do operador.
    for (const r of [...client.rooms]) {
      if (r.startsWith(`${room}:eq:`)) client.leave(r);
    }
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
  async handleSubscribeEquipamento(
    @MessageBody() data: { equipamentoId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const equipamentoId = String(data?.equipamentoId ?? '').trim();
    const user = this.usuario(client);
    if (!user || !equipamentoId) return this.negado({ equipamentoId });
    try {
      // Planta no escopo e, para operador, equipamento liberado (PER-23).
      await this.scope.assertEntityInScope('equipamento', equipamentoId, user);
    } catch {
      return this.negado({ equipamentoId });
    }
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
    const equipamentoId = String(data?.equipamentoId ?? '').trim();
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

  private async plantaDaUnidade(unidadeId: string): Promise<string | null> {
    const u = await this.prisma.unidades.findFirst({ where: { id: unidadeId, deleted_at: null }, select: { planta_id: true } });
    return u?.planta_id?.trim() ?? null;
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

    // Enviar para sala do diagrama (e para a do operador com este equipamento liberado)
    if (diagramaId) {
      const roomDiagrama = `diagrama:${diagramaId}`;
      this.server.to([roomDiagrama, `${roomDiagrama}:eq:${String(equipamentoId).trim()}`]).emit('equipamento_update', {
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
      const roomDiagrama = `diagrama:${diagramaId}`;
      this.server.to([roomDiagrama, `${roomDiagrama}:eq:${String(equipamentoId).trim()}`]).emit('equipamento_inputs', payload);
    }
    this.server.to(`equipamento:${equipamentoId}`).emit('equipamento_inputs', payload);
  }
}
