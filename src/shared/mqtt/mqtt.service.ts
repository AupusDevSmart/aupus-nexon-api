import { Injectable, OnModuleInit, OnModuleDestroy, Inject, forwardRef, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as mqtt from 'mqtt';
import { randomUUID, randomBytes } from 'crypto';
import {
  PrismaService,
  EQUIPAMENTO_MQTT_CHANGED,
  EquipamentoMqttChangedPayload,
} from '@/core';
import { MqttIngestionService } from '../../modules/equipamentos-dados/services/mqtt-ingestion.service';
import { detectarOverflowUint } from '../util/inverter-overflow';
import { MqttRedisBufferService } from './mqtt-redis-buffer.service';
import { RegrasLogsMqttEngine } from '../../modules/regras-logs-mqtt/regras-logs-mqtt.engine';
import { EventEmitter } from 'events';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

type SubscribeOrigin = 'boot' | 'event' | 'reconcile' | 'manual';

// Ack aplicação-level para comandos publicados em <base>/cmd.
// TON responde em <base>/cmd/ack: {cmd_id, status, msg, ts}
export type CmdAckStatus = 'ok' | 'error' | 'duplicate';
export interface CmdAckResult {
  cmd_id: string;
  status: CmdAckStatus;
  msg: string;
  ts: number;
}
interface PendingCommand {
  cmd_id: string;
  topic: string;             // <base>/cmd
  envelope: string;          // payload serializado
  resolve: (r: CmdAckResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  attempt: number;           // 1 = primeira tentativa
  maxAttempts: number;
  timeoutMs: number;
}

export interface ReconcileResult {
  added: Array<{ equipamentoId: string; topic: string }>;
  removed: Array<{ equipamentoId: string; topic: string }>;
  total: number;
}

/**
 * Payload retained publicado pelo TON em `<topic_base>/status` quando conecta.
 * Apenas `mac` (formato AA:BB:CC:DD:EE:FF) e `online` sao consumidos hoje;
 * outros campos sao toleravelmente ignorados (forward-compatible).
 */
export interface StatusAnnouncePayload {
  online?: boolean;
  mac?: string;
  version?: string;
  model?: string;
  ip?: string;
  // Telemetria opcional do dispositivo — populada conforme firmware evoluir.
  // Mapeada para iot_dispositivos_online em upsertDispositivoOnline.
  rssi?: number;
  wifi_rssi?: number;
  heap?: number;
  free_heap?: number;
  uptime?: number;
  uptime_sec?: number;
  hostname_ota?: string;
  ota_hostname?: string;
  firmware_versao?: number;
  modbus_ok?: number;
  modbus_err?: number;
  mqtt_pub?: number;
  sd_writes?: number;
  [key: string]: unknown;
}

// Interface para o buffer de dados
interface BufferData {
  equipamentoId: string;
  leituras: Array<{
    timestamp: Date;
    dados: any;
  }>;
  timestamp_inicio: Date;
}

@Injectable()
export class MqttService extends EventEmitter implements OnModuleInit, OnModuleDestroy {
  private client: mqtt.MqttClient;
  private subscriptions: Map<string, string[]> = new Map(); // topic -> [equipamentoIds]
  private ajv: Ajv;
  private logLevel: 'minimal' | 'normal' | 'verbose' = 'normal';

  // Comandos publicados aguardando ack do TON. Chave: cmd_id (UUID).
  private pendingCommands: Map<string, PendingCommand> = new Map();

  // Listeners temporarios para `<topic_base>/ota/status`, usados pelo OtaService
  // para limpar o retained do `<topic_base>/ota/cmd` assim que o TON confirma.
  private otaStatusListeners: Map<string, (data: any) => void> = new Map();

  // Buffer para agregação de 1 minuto
  private buffers: Map<string, BufferData> = new Map();
  private bufferInterval = 60000; // 1 minuto em ms
  private flushTimer: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => MqttIngestionService))
    private readonly mqttIngestionService: MqttIngestionService,
    @Optional() private readonly redisBuffer?: MqttRedisBufferService,
    @Optional() private readonly regrasLogsMqttEngine?: RegrasLogsMqttEngine,
  ) {
    super();
    // Inicializar Ajv com formatos adicionais
    this.ajv = new Ajv({ allErrors: true });
    addFormats(this.ajv);
  }

  async onModuleInit() {
    await this.connect();

    // Iniciar processo de flush periódico (1 minuto)
    this.flushTimer = setInterval(() => {
      this.flushAllBuffers();
    }, this.bufferInterval);

    // console.log('📊 Sistema de agregação de dados (1 minuto) inicializado');
  }

  onModuleDestroy() {
    // Limpar timer de flush
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }

    // Fazer flush final antes de desconectar
    this.flushAllBuffers();

    this.disconnect();
  }

  private async connect() {
    // ✅ SISTEMA DE 3 MODOS: production, development, disabled
    const mqttMode = process.env.MQTT_MODE || 'production';
    const instanceId = process.env.INSTANCE_ID || 'unknown';
    this.logLevel = (process.env.MQTT_LOG_LEVEL as any) || 'normal';

    // Modo DISABLED: Não conectar ao MQTT
    if (mqttMode === 'disabled') {
      console.warn(`⏸️ [MQTT] DESABILITADO para instância: ${instanceId}`);
      console.warn(`⏸️ [MQTT] Dados MQTT NÃO serão processados nesta instância`);
      console.warn(`⏸️ [MQTT] Configure MQTT_MODE=development ou production para habilitar`);
      return;
    }

    // Modo DEVELOPMENT: Conectar mas não salvar no banco
    if (mqttMode === 'development') {
      if (this.logLevel !== 'minimal') {
        console.log(`🔧 [MQTT] MODO DESENVOLVIMENTO - Instância: ${instanceId}`);
        console.log(`🔧 [MQTT] Conectará ao MQTT mas NÃO salvará dados no banco`);
        console.log(`🔧 [MQTT] WebSocket e logs funcionarão normalmente`);
      }
    } else {
      // Modo PRODUCTION: Funcionalidade completa
      if (this.logLevel !== 'minimal') {
        console.log(`🚀 [MQTT] MODO PRODUÇÃO - Instância: ${instanceId}`);
      }
    }

    // Construir URL do broker a partir de HOST e PORT
    const mqttHost = process.env.MQTT_HOST || 'localhost';
    const mqttPort = process.env.MQTT_PORT || '1883';
    const mqttUrl = `mqtt://${mqttHost}:${mqttPort}`;

    const options: mqtt.IClientOptions = {
      // Sem sufixo aleatorio: clientId TEM que ser estavel para uma sessao
      // persistente ter o que retomar. `instanceId` ja diferencia dev/staging/
      // prod (ver .env), e `ecosystem.config.cjs` fixa este processo em
      // `instances: 1, exec_mode: 'fork'` — nao ha dois workers deste servico
      // disputando o mesmo clientId ao mesmo tempo.
      clientId: `aupus-${instanceId}`,
      username: process.env.MQTT_USERNAME,
      password: process.env.MQTT_PASSWORD,
      // `clean: false` = sessao persistente: o broker guarda as inscricoes e
      // enfileira mensagem QoS>=1 recebida enquanto este cliente esta
      // desconectado, e entrega tudo na reconexao. Antes, `clean: true` fazia
      // o broker esquecer a sessao em TODA reconexao — nao so em deploy, em
      // qualquer soluco de rede — perdendo o que chegou no meio.
      clean: false,
      reconnectPeriod: 5000,
      // 🔧 FIX: Parâmetros adicionais para estabilidade de conexão
      keepalive: 30,              // Enviar PINGREQ a cada 30s para manter conexão ativa
      connectTimeout: 30 * 1000,  // 30s timeout para conexão inicial
      protocolVersion: 4,         // MQTT 3.1.1 (mais estável que 5.0)
      reschedulePings: true,      // Reajustar ping se houver tráfego
    };

    if (this.logLevel !== 'minimal') {
      console.log(`🔌 [MQTT] Conectando ao broker: ${mqttUrl}`);
    }
    this.client = mqtt.connect(mqttUrl, options);

    this.client.on('connect', (packet) => {
      if (this.logLevel !== 'minimal') {
        // `sessionPresent` vem no CONNACK: true quando o broker retomou a
        // sessao persistente (e entregou o que ficou em fila), false quando
        // comecou do zero — primeira conexao, ou o broker expirou a sessao por
        // ficar tempo demais sem este clientId aparecer.
        console.log(`✅ [MQTT] Conectado com sucesso! sessionPresent=${packet?.sessionPresent ?? 'indisponivel'}`);
      }
      this.carregarTopicosEquipamentos();
      // Discovery de bancada (modo simulação): escuta TESTE/# só pra registrar
      // quais boards de bancada estão vivos (MAC em .../satellite/<MAC>/...), pro
      // painel de teste oferecer o remap sem o usuário digitar MAC. Não ingere
      // dados — TESTE/ não está no subscriptions map, então cai fora em handleMessage.
      this.client?.subscribe('TESTE/#', { qos: 0 }, (err) => {
        if (err) console.warn(`⚠️ [MQTT] Falha ao subscrever TESTE/# (discovery): ${err.message}`);
      });
    });

    this.client.on('message', (topic, payload, packet?: any) => {
      // 🔍 LOG TEMPORÁRIO: Logar TODAS as mensagens recebidas
      if (this.logLevel === 'verbose') {
        console.log(`📥 [MQTT] Mensagem recebida | Tópico: ${topic} | Tamanho: ${payload.length} bytes`);
      }
      // packet.retain=true → mensagem retida reentregue na (re)conexão (dado ANTIGO,
      // não sinal de vida). Passa a flag adiante p/ o liveness não carimbar retained.
      this.handleMessage(topic, payload, !!packet?.retain);
    });

    this.client.on('error', (error) => {
      // Sempre mostrar erros críticos com mais detalhes
      console.error('❌ [MQTT] ERRO:', error.message || error);
      if (this.logLevel === 'verbose') {
        console.error('❌ [MQTT] Stack:', error.stack);
      }
    });

    this.client.on('reconnect', () => {
      // Silenciar em modo minimal
      if (this.logLevel !== 'minimal') {
        console.warn('🔄 [MQTT] Reconectando ao broker...');
      }
    });

    // ✅ NOVO: Eventos adicionais para monitoramento
    this.client.on('offline', () => {
      // Silenciar em modo minimal - este log é muito verbose
      if (this.logLevel === 'verbose') {
        console.error('🔴 [MQTT] ALERTA: Broker OFFLINE!');
      }
    });

    this.client.on('close', () => {
      // 🔧 FIX: Mostrar sempre (não só em verbose) para debug de ECONNRESET
      if (this.logLevel !== 'minimal') {
        console.warn('⚠️ [MQTT] Conexão fechada pelo broker');
      }
    });

    this.client.on('end', () => {
      if (this.logLevel !== 'minimal') {
        console.log('🔌 [MQTT] Cliente MQTT encerrado (chamado explicitamente)');
      }
    });

    // 🔧 FIX: Adicionar handler para evento 'disconnect'
    this.client.on('disconnect', (packet) => {
      if (this.logLevel !== 'minimal') {
        console.warn('⚠️ [MQTT] Desconectado do broker:', packet);
      }
    });

    // 🔧 FIX: Adicionar handler para evento 'packetsend' em modo verbose
    if (this.logLevel === 'verbose') {
      this.client.on('packetsend', (packet) => {
        if (packet.cmd === 'pingreq') {
          console.log('💓 [MQTT] Enviando PINGREQ (keepalive)');
        }
      });

      this.client.on('packetreceive', (packet) => {
        if (packet.cmd === 'pingresp') {
          console.log('💓 [MQTT] Recebido PINGRESP (keepalive OK)');
        }
      });
    }
  }

  /**
   * Carrega todos os tópicos cadastrados e subscreve
   */
  private async carregarTopicosEquipamentos() {
    const equipamentos = await this.prisma.equipamentos.findMany({
      where: {
        mqtt_habilitado: true,
        topico_mqtt: { not: null },
        NOT: { topico_mqtt: '' },   // ← NOVO: ignora tópicos vazios
        deleted_at: null,
      },
      select: {
        id: true,
        topico_mqtt: true,
      },
    });

    if (this.logLevel !== 'minimal') {
      console.log(`📡 [MQTT] Carregando ${equipamentos.length} tópicos MQTT...`);
    }

    for (const equip of equipamentos) {
      this.subscribeTopic(equip.topico_mqtt!, equip.id, 'boot');
    }

    if (this.logLevel !== 'minimal') {
      console.log(`✅ [MQTT] ${equipamentos.length} equipamentos inscritos em ${this.subscriptions.size} tópicos distintos`);
    }
  }

  /**
   * Valida formato basico de topico (defesa em profundidade — DTO no api-shared
   * deveria validar primeiro). Recusa wildcards, vazio, leading/trailing slash.
   */
  private isValidTopic(topic: unknown): topic is string {
    if (!topic || typeof topic !== 'string') return false;
    const t = topic.trim();
    if (!t) return false;
    if (t.startsWith('/') || t.endsWith('/')) return false;
    if (t.includes('\u0000')) return false;
    // Wildcards MQTT (+, #) nao fazem sentido para topicos de equipamento
    if (t.includes('+') || t.includes('#')) return false;
    return true;
  }

  /**
   * Subscreve a um tópico MQTT.
   * Também subscreve a `<topic>/status` (retained) — usado pelo TON
   * para anunciar identidade (mac, version, ip) ao conectar.
   * Vide processStatusAnnounce() em handleMessage().
   */
  private subscribeTopic(topic: string, equipamentoId: string, origin: SubscribeOrigin = 'boot') {
    if (!this.isValidTopic(topic)) {
      console.warn(`⚠️ [MQTT] Topico invalido ignorado para equipamento ${equipamentoId}: ${JSON.stringify(topic)}`);
      return;
    }
    const equipId = equipamentoId.trim();

    // 1) Subscribe principal (telemetria — formato definido por mqtt_schema do tipo)
    let isNewTopic = false;
    if (!this.subscriptions.has(topic)) {
      this.subscriptions.set(topic, []);
      isNewTopic = true;
      this.client?.subscribe(topic, { qos: 1 }, (err) => {
        if (err) {
          console.warn(`⚠️ [MQTT] Falha ao subscrever ${topic}: ${err.message}`);
        }
      });
    }

    const equipamentos = this.subscriptions.get(topic)!;
    let added = false;
    if (!equipamentos.includes(equipId)) {
      equipamentos.push(equipId);
      added = true;
    }

    if (origin !== 'boot' && (isNewTopic || added) && this.logLevel !== 'minimal') {
      console.log(`[MQTT][dyn] subscribe ${topic} (equipamento ${equipId}, origin=${origin})`);
    }

    // 2) Subscribe ao tópico de status retained do mesmo dispositivo:
    // permite descobrir o MAC físico (eFuse) e popular equipamentos.mac_address
    // automaticamente quando o TON fica online.
    const statusTopic = `${topic}/status`;
    if (!this.subscriptions.has(statusTopic)) {
      this.subscriptions.set(statusTopic, []);
      this.client?.subscribe(statusTopic, { qos: 1 }, (err) => {
        if (err) {
          console.warn(`⚠️ [MQTT] Falha ao subscrever ${statusTopic}: ${err.message}`);
        }
      });
    }
    const statusEquipamentos = this.subscriptions.get(statusTopic)!;
    if (!statusEquipamentos.includes(equipId)) {
      statusEquipamentos.push(equipId);
    }

    // 2b) Subscribe ao <base>/diagnostics — o firmware publica a cada 60s runtime stats
    // ricos (modbus_ok/err, wifi_rssi, uptime, silence_sec, reset_reason...). Ingeridos em
    // iot_dispositivos_online → COA/diagnóstico e liveness (TON viva mesmo sem telemetria).
    const diagTopic = `${topic}/diagnostics`;
    if (!this.subscriptions.has(diagTopic)) {
      this.subscriptions.set(diagTopic, []);
      this.client?.subscribe(diagTopic, (err) => {
        if (err) console.warn(`⚠️ [MQTT] Falha ao subscrever ${diagTopic}: ${err.message}`);
      });
    }
    const diagEquipamentos = this.subscriptions.get(diagTopic)!;
    if (!diagEquipamentos.includes(equipId)) {
      diagEquipamentos.push(equipId);
    }

    // 3) Subscribe ao tópico de ack de comandos: <base>/cmd/ack
    // Usado por publishCommand() para resolver o Promise da chamada.
    const ackTopic = `${topic}/cmd/ack`;
    if (!this.subscriptions.has(ackTopic)) {
      this.subscriptions.set(ackTopic, []);
      this.client?.subscribe(ackTopic, { qos: 1 }, (err) => {
        if (err) {
          console.warn(`⚠️ [MQTT] Falha ao subscrever ${ackTopic}: ${err.message}`);
        }
      });
    }
    const ackEquipamentos = this.subscriptions.get(ackTopic)!;
    if (!ackEquipamentos.includes(equipId)) {
      ackEquipamentos.push(equipId);
    }

    // 4) Subscribe ao tópico de entradas digitais (BI): <base>/inputs
    // TON publica {d1..d6} on-change. Pra satellite LoRa, o gateway republica
    // em <base>/satellite/<MAC>/inputs — mesmo padrao <topico>/inputs.
    const inputsTopic = `${topic}/inputs`;
    if (!this.subscriptions.has(inputsTopic)) {
      this.subscriptions.set(inputsTopic, []);
      this.client?.subscribe(inputsTopic, { qos: 1 }, (err) => {
        if (err) {
          console.warn(`⚠️ [MQTT] Falha ao subscrever ${inputsTopic}: ${err.message}`);
        }
      });
    }
    const inputsEquipamentos = this.subscriptions.get(inputsTopic)!;
    if (!inputsEquipamentos.includes(equipId)) {
      inputsEquipamentos.push(equipId);
    }

    // 5) Subscribe ao tópico de eventos (SOE) de relé: <base>/evt
    // TON drena o buffer de eventos do relé e publica cada um JÁ CARIMBADO NA FONTE
    // (ms do próprio relé). Ver docs/IOT-SOE-EVENTOS-RELE.md.
    const evtTopic = `${topic}/evt`;
    if (!this.subscriptions.has(evtTopic)) {
      this.subscriptions.set(evtTopic, []);
      this.client?.subscribe(evtTopic, { qos: 1 }, (err) => {
        if (err) {
          console.warn(`⚠️ [MQTT] Falha ao subscrever ${evtTopic}: ${err.message}`);
        }
      });
    }
    const evtEquipamentos = this.subscriptions.get(evtTopic)!;
    if (!evtEquipamentos.includes(equipId)) {
      evtEquipamentos.push(equipId);
    }

    // 6) Bomba de combustível + carregador: <base>/abastecimento, <base>/bomba, <base>/carregador.
    for (const suf of ['abastecimento', 'bomba', 'carregador']) {
      const t = `${topic}/${suf}`;
      if (!this.subscriptions.has(t)) {
        this.subscriptions.set(t, []);
        this.client?.subscribe(t, { qos: 1 }, (err) => {
          if (err) console.warn(`⚠️ [MQTT] Falha ao subscrever ${t}: ${err.message}`);
        });
      }
      const arr = this.subscriptions.get(t)!;
      if (!arr.includes(equipId)) arr.push(equipId);
    }
  }

  /** Ingere uma transação de abastecimento publicada pela bomba em `<base>/abastecimento`. */
  private async ingerirAbastecimento(equipamentoId: string, d: any): Promise<void> {
    try {
      const eid = equipamentoId.trim();
      const pl = await this.prisma.$queryRaw<Array<{ planta_id: string; maquina_nome: string }>>`
        SELECT TRIM(u.planta_id) AS planta_id,
               (SELECT maquina_nome FROM rfid_autorizados r WHERE r.uid = ${String(d.uid ?? '')} LIMIT 1) AS maquina_nome
        FROM equipamentos e JOIN unidades u ON TRIM(u.id) = TRIM(e.unidade_id)
        WHERE TRIM(e.id) = ${eid} LIMIT 1`;
      const id = randomBytes(13).toString('hex');
      await this.prisma.$executeRaw`
        INSERT INTO abastecimentos (id, equipamento_id, uid, maquina_nome, planta_id, litros, nivel_antes, nivel_depois, status, created_at)
        VALUES (${id}, ${eid}, ${d.uid ?? null}, ${pl[0]?.maquina_nome ?? null}, ${pl[0]?.planta_id ?? null},
                ${d.litros ?? null}, ${d.nivel_antes ?? null}, ${d.nivel_depois ?? null}, ${d.status ?? null}, now())`;
    } catch (e) {
      console.warn(`[bomba] ingerir abastecimento falhou: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Atualiza o estado da bomba (nível/estado) publicado em `<base>/bomba` — pro modal. */
  private async atualizarBombaEstado(equipamentoId: string, d: any): Promise<void> {
    try {
      const eid = equipamentoId.trim();
      await this.prisma.$executeRaw`
        UPDATE bomba_combustivel_config
        SET ultimo_estado = ${d.estado ?? null}, ultimo_nivel_pct = ${d.nivel_pct ?? null}, ultima_leitura = now(), updated_at = now()
        WHERE TRIM(equipamento_id) = ${eid}`;
    } catch (e) {
      console.warn(`[bomba] atualizar estado falhou: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * Carregador elétrico: telemetria/energia em `<base>/carregador`.
   * Espera { kwh?, estado?, conectado?, evento? }. Atualiza kWh acumulado, o kWh
   * corrente da sessão ativa, e ao DESCONECTAR encerra a sessão (kwh_total + ocioso).
   */
  private async ingerirCarregador(equipamentoId: string, d: any): Promise<void> {
    try {
      const eid = equipamentoId.trim();
      const kwh = d.kwh ?? d.energia ?? d.kwh_total ?? null;
      const estado = d.estado ?? null;
      const desconectado =
        d.conectado === false ||
        d.evento === 'desconectado' ||
        String(d.estado ?? '').toLowerCase() === 'desconectado';
      if (kwh != null) {
        const existe = (await this.prisma.$queryRaw<any[]>`SELECT 1 FROM carregador_config WHERE TRIM(equipamento_id)=${eid} LIMIT 1`).length > 0;
        if (existe) {
          await this.prisma.$executeRaw`UPDATE carregador_config SET ultima_leitura_kwh=${kwh}, ultimo_estado=${estado}, ultima_leitura=now(), updated_at=now() WHERE TRIM(equipamento_id)=${eid}`;
        } else {
          await this.prisma.$executeRaw`INSERT INTO carregador_config (id, equipamento_id, ultima_leitura_kwh, ultimo_estado, ultima_leitura) VALUES (${randomBytes(13).toString('hex')}, ${eid}, ${kwh}, ${estado}, now())`;
        }
        await this.prisma.$executeRaw`
          UPDATE carregador_sessoes SET kwh_fim=${kwh},
            kwh_total = CASE WHEN kwh_inicio IS NOT NULL THEN GREATEST(${kwh}::numeric - kwh_inicio, 0) ELSE kwh_total END, updated_at=now()
          WHERE TRIM(equipamento_id)=${eid} AND status='ativa'`;
      } else if (estado) {
        await this.prisma.$executeRaw`UPDATE carregador_config SET ultimo_estado=${estado}, ultima_leitura=now(), updated_at=now() WHERE TRIM(equipamento_id)=${eid}`;
      }
      if (desconectado) {
        await this.prisma.$executeRaw`
          UPDATE carregador_sessoes
          SET fim=now(), kwh_fim=COALESCE(${kwh}::numeric, kwh_fim),
              kwh_total = CASE WHEN COALESCE(${kwh}::numeric, kwh_fim) IS NOT NULL AND kwh_inicio IS NOT NULL THEN GREATEST(COALESCE(${kwh}::numeric, kwh_fim) - kwh_inicio, 0) ELSE kwh_total END,
              ocioso_min = CASE WHEN ocioso_inicio IS NOT NULL THEN GREATEST(EXTRACT(EPOCH FROM (now() - ocioso_inicio))/60, 0)::int ELSE 0 END,
              status='encerrada', updated_at=now()
          WHERE TRIM(equipamento_id)=${eid} AND status='ativa'`;
      }
    } catch (e) {
      console.warn(`[carregador] ingerir falhou: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * SOE — ingere um evento de relé publicado pela TON em `<base>/evt`.
   *
   * O payload é CRU (type/fun/inf/ho/mi/ms/dpi/rt/fault/meas). Aqui:
   *  1. completa a DATA (o relé só manda hora:min:ms) usando a hora de leitura da TON;
   *  2. traduz fun/inf -> evento semântico (tabela `rele_evento_codigos`, DADO curável);
   *  3. grava append-only em `rele_eventos`.
   *
   * Modelo CANÔNICO: quando DNP3 entrar, muda só `origem_protocolo` e o tradutor —
   * a tabela, a API e a tela continuam iguais. Ver docs/IOT-SOE-EVENTOS-RELE.md.
   */
  private async processReleEvento(equipamentoId: string, d: any): Promise<void> {
    try {
      if (!d || d.type === undefined) return;
      const proto = String(d.proto ?? 'modbus_7sr');
      const fun = d.fun != null ? Number(d.fun) : null;
      const inf = d.inf != null ? Number(d.inf) : null;
      const tsFonte = this.tsFonteDoEvento(d);

      // Tradução fun/inf -> evento semântico. O mapa é POR MODELO: provado que o do
      // 7SR10 difere do 7SR5111 (explicava só 5% dos eventos). Precedência:
      //  1º regra do MODELO (catalog_id do evento) — fonte autoritativa (report Reydisp);
      //  2º regra genérica (catalog_id NULL) = base padrão IEC-103, só p/ FUN `padrao`
      //     (FUN privado herdando a norma rotula errado).
      // Sem match -> evento=null: NÃO se perde, vai pra fila de curadoria da tela.
      const catId = String(d.cat ?? '').trim() || null;
      let evento: string | null = null;
      if (inf != null) {
        const rows = await this.prisma.$queryRaw<Array<{ evento: string; ignorar: boolean }>>`
          SELECT c.evento, c.ignorar
          FROM rele_evento_codigos c
          WHERE c.protocolo = ${proto} AND c.inf = ${inf}
            AND (c.catalog_id = ${catId} OR c.catalog_id IS NULL)
            AND (
              c.fun = ${fun ?? -1}
              OR (c.fun = -1 AND EXISTS (
                    SELECT 1 FROM rele_evento_funs f
                    WHERE f.protocolo = ${proto} AND f.fun = ${fun ?? -1} AND f.padrao = true))
            )
          ORDER BY (c.catalog_id IS NULL) ASC, (c.fun = -1) ASC
          LIMIT 1
        `;
        // Telemetria cíclica (medidor de energia/wear/contador) NÃO é evento SOE — descarta.
        // A TON precisa drenar do buffer do relé (por isso ela lê e publica), mas aqui não
        // gravamos, senão a tabela de eventos vira lixeira de medição.
        if (rows[0]?.ignorar) return;
        evento = rows[0]?.evento ?? null;
      }

      const estado = d.dpi === 2 ? 'on' : d.dpi === 1 ? 'off' : null;
      const id = randomBytes(13).toString('hex');
      await this.prisma.$executeRaw`
        INSERT INTO rele_eventos
          (id, equipamento_id, device, catalog_id, origem_protocolo, ts_fonte, ts_recebido, hora_confiavel,
           tipo_registro, fun, inf, evento, estado, tempo_relativo_ms, falta_num, valor, raw, created_at)
        VALUES (${id}, ${equipamentoId.trim()}, ${String(d.dev ?? '?')}, ${catId}, ${proto},
                ${tsFonte}::timestamp, now(), ${d.hora_ok !== false},
                ${Number(d.type)}, ${fun}, ${inf}, ${evento}, ${estado},
                ${d.rt != null ? Number(d.rt) : null}, ${d.fault != null ? Number(d.fault) : null},
                ${d.meas != null ? Number(d.meas) : null},
                ${JSON.stringify(d)}::jsonb, now())
      `;
      console.log(
        `[SOE] ${d.dev} ${evento ?? `FUN=${fun}/INF=${inf}`} ${estado ?? ''} @ ${tsFonte ?? '?'}` +
          (d.hora_ok === false ? ' (HORA NAO CONFIAVEL)' : ''),
      );
    } catch (e) {
      console.error(`❌ [SOE] falha ao ingerir evento de ${equipamentoId}:`, e);
    }
  }

  /**
   * Completa a data do evento. O relé manda só hora:min:ms (sem data) — a data vem
   * de quando a TON leu (`ts_rx`, epoch). Trata a VIRADA DE MEIA-NOITE: como a TON
   * drena a fila em segundos, um evento "no futuro" > 1h só pode ser do dia anterior.
   * Retorna timestamp naive no fuso de SP (padrão do resto do sistema).
   */
  private tsFonteDoEvento(d: any): string | null {
    if (d?.ho == null || d?.mi == null || d?.ms == null) return null;
    const ho = Number(d.ho), mi = Number(d.mi);
    const msTot = Number(d.ms);              // ms DENTRO do minuto (0..59999)
    if (!Number.isFinite(ho) || !Number.isFinite(mi) || !Number.isFinite(msTot)) return null;
    const seg = Math.floor(msTot / 1000) % 60;
    const milli = msTot % 1000;

    const rx = new Date((Number(d.ts_rx) > 0 ? Number(d.ts_rx) : Date.now() / 1000) * 1000);
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(rx).map((p) => [p.type, p.value]),
    ) as Record<string, string>;

    let y = Number(parts.year), mo = Number(parts.month), da = Number(parts.day);
    const rxHora = parts.hour === '24' ? 0 : Number(parts.hour);
    const rxMin = rxHora * 60 + Number(parts.minute);
    const evMin = ho * 60 + mi;
    if (evMin - rxMin > 60) {
      const prev = new Date(Date.UTC(y, mo - 1, da));
      prev.setUTCDate(prev.getUTCDate() - 1);
      y = prev.getUTCFullYear(); mo = prev.getUTCMonth() + 1; da = prev.getUTCDate();
    }
    const p2 = (n: number) => String(n).padStart(2, '0');
    return `${y}-${p2(mo)}-${p2(da)} ${p2(ho)}:${p2(mi)}:${p2(seg)}.${String(milli).padStart(3, '0')}`;
  }

  /**
   * Remove subscrição de um tópico
   */
  public unsubscribeTopic(topic: string, equipamentoId: string, origin: SubscribeOrigin = 'manual') {
    if (!topic || !this.subscriptions.has(topic)) return;
    const equipId = equipamentoId.trim();

    const equipamentos = this.subscriptions.get(topic)!;
    const index = equipamentos.indexOf(equipId);
    if (index === -1) return;

    equipamentos.splice(index, 1);

    let removedFromBroker = false;
    if (equipamentos.length === 0) {
      this.client?.unsubscribe(topic);
      this.subscriptions.delete(topic);
      removedFromBroker = true;
    }

    if (origin !== 'boot' && this.logLevel !== 'minimal') {
      const flag = removedFromBroker ? 'broker-unsub' : 'remaining-' + equipamentos.length;
      console.log(`[MQTT][dyn] unsubscribe ${topic} (equipamento ${equipId}, ${flag}, origin=${origin})`);
    }
  }

  /**
   * Processa mensagem recebida.
   * Roteamento:
   *   - `<topic>/status` → processStatusAnnounce (auto-discovery de MAC)
   *   - `<topic>` exato  → processarDadosEquipamento (telemetria, fluxo legado)
   */
  private async handleMessage(topic: string, payload: Buffer, retained = false) {
    try {
      // Payload pode estar vazio (broker limpando retained); ignorar nesse caso.
      if (!payload || payload.length === 0) return;

      const dados = JSON.parse(payload.toString());

      // Discovery de bancada (modo simulação): registra MACs vivos publicando em
      // TESTE/.../satellite/<MAC>/... e captura o "sim":"<nome da TON>" do heartbeat
      // (auto-casa board↔TON no painel). Independente do subscriptions map; o ack do
      // TESTE/ ainda roteia abaixo.
      if (topic.startsWith('TESTE/')) this.trackBenchSatellite(topic, dados);

      // Acks de comando são roteados por cmd_id em pendingCommands,
      // não dependem de equipamentoIds — processar antes do lookup de subscription.
      if (topic.endsWith('/cmd/ack')) {
        this.processCommandAck(dados);
        return;
      }

      // OTA status: roteado por listener temporario (registrado por OtaService).
      // Nao deve cair em telemetria mesmo se topic estiver no `subscriptions` map.
      if (topic.endsWith('/ota/status')) {
        const handler = this.otaStatusListeners.get(topic);
        if (handler) {
          try { handler(dados); } catch (e) {
            console.error(`❌ Erro no ota status handler de ${topic}:`, e);
          }
        }
        return;
      }

      const equipamentoIds = this.subscriptions.get(topic);
      if (!equipamentoIds || equipamentoIds.length === 0) {
        return;
      }

      // Sinal de vida da TON: QUALQUER telemetria carimba last_seen da base
      // correspondente em iot_dispositivos_online. Antes só o birth `/status`
      // carimbava → flag `online` ficava presa e o COA não distinguia "TON viva,
      // equipamento mudo" (device/Modbus) de "sem sinal" (internet/energia).
      // O `/status` continua a cargo do processStatusAnnounce/markDispositivoOffline
      // (birth online=true / LWT online=false) — não carimbar aqui p/ não mascarar o LWT.
      // `retained` = dado antigo reentregue na reconexão → NÃO é sinal de vida.
      // /status e /diagnostics carimbam liveness pelo seu próprio handler (upsert).
      if (!retained && !topic.endsWith('/status') && !topic.endsWith('/diagnostics')) {
        this.touchLiveness(topic);
      }

      // SOE: evento de relé (já carimbado na fonte). Append-only.
      if (topic.endsWith('/evt')) {
        for (const equipamentoId of equipamentoIds) {
          await this.processReleEvento(equipamentoId, dados);
        }
        return;
      }

      // Bomba de combustível: transação de abastecimento / telemetria da bomba.
      if (topic.endsWith('/abastecimento')) {
        for (const equipamentoId of equipamentoIds) await this.ingerirAbastecimento(equipamentoId, dados);
        return;
      }
      if (topic.endsWith('/bomba')) {
        for (const equipamentoId of equipamentoIds) await this.atualizarBombaEstado(equipamentoId, dados);
        return;
      }
      // Carregador elétrico: energia/estado + fim de sessão na desconexão.
      if (topic.endsWith('/carregador')) {
        for (const equipamentoId of equipamentoIds) await this.ingerirCarregador(equipamentoId, dados);
        return;
      }

      // Roteamento por sub-path
      if (topic.endsWith('/status')) {
        for (const equipamentoId of equipamentoIds) {
          await this.processStatusAnnounce(equipamentoId, dados);
        }
        return;
      }

      // Diagnóstico periódico do firmware (<base>/diagnostics, ~60s): runtime stats ricos
      // → iot_dispositivos_online. Também é sinal de vida (TON viva mesmo sem telemetria).
      if (topic.endsWith('/diagnostics')) {
        for (const equipamentoId of equipamentoIds) {
          await this.processDiagnostics(equipamentoId, dados);
        }
        return;
      }

      // Entradas digitais (BI): TON publica {d1..d6} on-change.
      if (topic.endsWith('/inputs')) {
        for (const equipamentoId of equipamentoIds) {
          await this.processInputs(equipamentoId, dados);
        }
        return;
      }

      // Fluxo legado: telemetria
      for (const equipamentoId of equipamentoIds) {
        await this.processarDadosEquipamento(equipamentoId, dados, topic);
      }
    } catch (error) {
      console.error(`❌ Erro ao processar mensagem do tópico ${topic}:`, error);
    }
  }

  /**
   * Boards de bancada vivos (modo simulação): MAC -> {base, lastSeen, label}.
   * Populado por trackBenchSatellite. `label` é o nome da TON pra qual o firmware 🧪
   * foi gerado (campo "sim" do heartbeat) — permite o painel auto-casar board↔TON.
   */
  private readonly _benchSats = new Map<
    string,
    { mac: string; base: string; lastSeen: number; label: string | null }
  >();

  /**
   * Extrai e registra o MAC de um tópico TESTE/<base>/satellite/<MAC>/... .
   * Se o payload (heartbeat) traz "sim":"<nome>", grava como label (qual TON o
   * board representa). Em mensagens sem label, preserva o label anterior.
   */
  private trackBenchSatellite(topic: string, dados?: any) {
    const m = topic.match(
      /^TESTE\/(.+)\/satellite\/([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})(?:\/|$)/,
    );
    if (!m) return;
    const mac = m[2].toUpperCase();
    const prev = this._benchSats.get(mac);
    const label =
      typeof dados?.sim === 'string' && dados.sim.trim()
        ? dados.sim.trim()
        : prev?.label ?? null;
    this._benchSats.set(mac, { mac, base: m[1], lastSeen: Date.now(), label });
  }

  /**
   * Lista os boards de bancada vistos no TESTE/ dentro de maxAgeMs (default 90s),
   * mais recentes primeiro. `label` = nome da TON que o board representa (auto-casa
   * no painel, sem o usuário lidar com MAC). Escopo TESTE/ — nunca lista board real.
   */
  public getBenchSatellites(
    maxAgeMs = 90_000,
  ): Array<{ mac: string; base: string; ageMs: number; label: string | null }> {
    const now = Date.now();
    const out: Array<{
      mac: string;
      base: string;
      ageMs: number;
      label: string | null;
    }> = [];
    for (const v of this._benchSats.values()) {
      const ageMs = now - v.lastSeen;
      if (ageMs <= maxAgeMs)
        out.push({ mac: v.mac, base: v.base, ageMs, label: v.label });
    }
    return out.sort((a, b) => a.ageMs - b.ageMs);
  }

  /**
   * Processa entradas digitais (BI) publicadas pelo TON em `<topic_base>/inputs`.
   * Payload: { d1, d2, d3, d4, d5, d6 } com valores 0/1.
   *
   * Para satellites LoRa, o gateway republica em `<base>/satellite/<MAC>/inputs`,
   * que é exatamente `<topico_do_equipamento>/inputs` — mesmo handler.
   *
   * Guarda o estado atual em equipamento_io_estado (upsert) e emite evento WS
   * `equipamento_inputs`. O mapeamento dN → ponto semântico fica em ton_bi (resolvido
   * na leitura, não aqui).
   */
  private async processInputs(
    equipamentoId: string,
    dados: Record<string, any>,
  ): Promise<void> {
    try {
      // Normaliza para {d1..dN, s1} -> 0/1; ignora chaves desconhecidas.
      // v1 publica d1..d6; TON-V2 publica d1..d8 + s1 (SU+ IO48). Aceita
      // qualquer dN presente no payload pra nao descartar entradas de modelos
      // novos em silencio (armadilha 4.1 do IOT-TON-V2-BRIEFING.md).
      const estado: Record<string, number> = {};
      for (const [k, v] of Object.entries(dados)) {
        if (v === undefined || v === null) continue;
        if (/^d\d{1,2}$/.test(k) || k === 's1') estado[k] = v ? 1 : 0;
      }
      if (Object.keys(estado).length === 0) {
        return;
      }

      const json = JSON.stringify(estado);
      await this.prisma.$executeRaw`
        INSERT INTO equipamento_io_estado (equipamento_id, inputs, updated_at)
        VALUES (${equipamentoId}, ${json}::jsonb, now())
        ON CONFLICT (equipamento_id)
        DO UPDATE SET inputs = ${json}::jsonb, updated_at = now()
      `;

      if (this.logLevel === 'verbose') {
        console.log(`🔘 [MQTT] inputs ${equipamentoId}: ${json}`);
      }

      // Emite WS pra atualização ao vivo no supervisório.
      const equip = await this.prisma.equipamentos.findUnique({
        where: { id: equipamentoId },
        select: { diagrama_id: true },
      });
      this.emit('equipamento_inputs', {
        equipamentoId,
        diagramaId: equip?.diagrama_id ?? null,
        estado,
      });
    } catch (error) {
      console.error(`❌ [MQTT] Erro ao processar inputs de ${equipamentoId}:`, error);
    }
  }

  /**
   * Processa announce retained publicado pelo TON em `<topic_base>/status`.
   * Payload esperado:
   *   { online: true, version: "1.0.0", model: "TON1", mac: "AA:BB:CC:DD:EE:FF", ip: "..." }
   *
   * Comportamento:
   *   - Se equipamento ainda não tem mac_address e o announce traz um MAC válido,
   *     popula equipamentos.mac_address (auto-discovery).
   *   - Se já tem MAC e o announce traz outro, loga warning (TON foi trocado fisicamente?).
   *   - Em qualquer caso, emite evento WS para o gateway (futuro: badge online no UI).
   *
   * NÃO atualiza outras tabelas (telemetria continua indo só pelo fluxo legado).
   */
  private async processStatusAnnounce(
    equipamentoId: string,
    dados: StatusAnnouncePayload,
  ): Promise<void> {
    try {
      const equipamento = await this.prisma.equipamentos.findUnique({
        where: { id: equipamentoId },
        select: { id: true, nome: true, mac_address: true, topico_mqtt: true },
      });
      if (!equipamento) return;

      const isOnline = dados.online !== false;

      // LWT (online=false): marcar dispositivo offline e sair sem mexer no MAC.
      if (!isOnline) {
        if (this.logLevel === 'verbose') {
          console.log(`📴 [MQTT] ${equipamento.nome} (${equipamentoId}) reportou offline`);
        }
        await this.markDispositivoOffline(equipamento.topico_mqtt);
        return;
      }

      const macRaw = typeof dados.mac === 'string' ? dados.mac.trim().toUpperCase() : '';
      const isValidMac = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(macRaw);

      // Auto-discovery do MAC em equipamentos.mac_address — só roda se MAC valido.
      if (isValidMac) {
        if (!equipamento.mac_address) {
          try {
            await this.prisma.equipamentos.update({
              where: { id: equipamentoId },
              data: { mac_address: macRaw },
            });
            console.log(
              `🔗 [MQTT] Auto-discovery: equipamento ${equipamento.nome} (${equipamentoId}) ` +
                `vinculado ao MAC ${macRaw}`,
            );
          } catch (e: any) {
            if (e?.code === 'P2002') {
              console.warn(
                `⚠️ [MQTT] MAC ${macRaw} já vinculado a outro equipamento — ` +
                  `equipamento ${equipamento.nome} (${equipamentoId}) ficou sem vínculo.`,
              );
            } else {
              throw e;
            }
          }
        } else if (equipamento.mac_address.toUpperCase() !== macRaw) {
          // MAC mudou = troca de hardware. Substitui o vinculo pelo MAC novo
          // (o velho sai, o novo entra) para o banco e o target_mac do OTA
          // sempre refletirem a placa atual. Antes so' avisava e mantinha o
          // velho — deixava o cadastro defasado apos uma troca legitima.
          // Loga como evento de substituicao (trilha de auditoria); se isso
          // disparar repetidamente, indica DUAS TONs no mesmo topico (erro de
          // config), nao uma troca.
          try {
            await this.prisma.equipamentos.update({
              where: { id: equipamentoId },
              data: { mac_address: macRaw },
            });
            console.warn(
              `🔄 [MQTT] Substituição de hardware: ${equipamento.nome} (${equipamentoId}) ` +
                `MAC ${equipamento.mac_address} → ${macRaw} (atualizado automaticamente).`,
            );
          } catch (e: any) {
            if (e?.code === 'P2002') {
              // MAC novo ja' pertence a outro equipamento — nao sobrescreve.
              console.warn(
                `⚠️ [MQTT] MAC ${macRaw} ja' vinculado a outro equipamento; ` +
                  `${equipamento.nome} (${equipamentoId}) segue com ${equipamento.mac_address}.`,
              );
            } else {
              throw e;
            }
          }
        }
      }

      // Espelho em iot_dispositivos_online (independente de MAC valido — chave eh topico_mqtt).
      // Captura estado runtime: online, RSSI, heap, IP, etc — para dashboards e diagnostico.
      await this.upsertDispositivoOnline(equipamento, dados, isValidMac ? macRaw : null);
    } catch (error) {
      console.error(`❌ Erro processando status announce de ${equipamentoId}:`, error);
    }
  }

  /**
   * Ingestão do diagnóstico periódico (`<base>/diagnostics`, ~60s). Reusa
   * upsertDispositivoOnline — os campos batem 1:1 (wifi_rssi/free_heap/uptime_sec/
   * modbus_ok/modbus_err/mqtt_pub/sd_writes). Marca online=true + last_seen (sinal de
   * vida: TON viva mesmo quando não há telemetria). NÃO mexe no MAC (isso é do /status).
   */
  private async processDiagnostics(
    equipamentoId: string,
    dados: StatusAnnouncePayload,
  ): Promise<void> {
    try {
      const equipamento = await this.prisma.equipamentos.findUnique({
        where: { id: equipamentoId },
        select: { id: true, nome: true, mac_address: true, topico_mqtt: true },
      });
      if (!equipamento) return;
      const macRaw = typeof dados.mac === 'string' ? dados.mac.trim().toUpperCase() : '';
      const isValidMac = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(macRaw);
      await this.upsertDispositivoOnline(equipamento, dados, isValidMac ? macRaw : null);
    } catch (error) {
      console.error(`❌ Erro processando diagnostics de ${equipamentoId}:`, error);
    }
  }

  /**
   * Espelha o announce em iot_dispositivos_online por topico_mqtt UNIQUE.
   * Chave de upsert eh o topico (cada TON em campo tem topico unico).
   *
   * componente_id eh resolvido via FK iot_componentes.equipamento_id quando
   * existir vinculacao no diagrama IoT. Se nao houver, fica NULL — o
   * dispositivo aparece como "online no MQTT mas sem componente vinculado",
   * util pra detectar TONs nao registrados.
   *
   * Falhas de upsert sao logadas mas nao propagadas: nao podem quebrar o
   * fluxo de auto-discovery do MAC (que eh load-bearing).
   */
  private async upsertDispositivoOnline(
    equipamento: { id: string; nome: string; topico_mqtt: string | null },
    dados: StatusAnnouncePayload,
    macValido: string | null,
  ): Promise<void> {
    const topico = equipamento.topico_mqtt?.trim();
    if (!topico) return;

    try {
      const componente = await this.prisma.iot_componentes.findFirst({
        where: { equipamento_id: equipamento.id },
        select: { id: true },
      });

      const numericOrNull = (v: unknown): number | null =>
        typeof v === 'number' && Number.isFinite(v) ? v : null;
      const stringOrNull = (v: unknown, max: number): string | null =>
        typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, max) : null;
      const intOrZero = (v: unknown): number =>
        typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0;

      const ip = stringOrNull(dados.ip, 45);
      const hostname_ota = stringOrNull(dados.hostname_ota ?? dados.ota_hostname, 100);
      const wifi_rssi = numericOrNull(dados.wifi_rssi ?? dados.rssi);
      const free_heap = numericOrNull(dados.free_heap ?? dados.heap);
      const uptimeNum = numericOrNull(dados.uptime_sec ?? dados.uptime);
      const uptime_sec = uptimeNum !== null ? BigInt(Math.trunc(uptimeNum)) : null;
      const firmware_versao = numericOrNull(dados.firmware_versao);
      const modbus_ok = intOrZero(dados.modbus_ok);
      const modbus_err = intOrZero(dados.modbus_err);
      const mqtt_pub = intOrZero(dados.mqtt_pub);
      const sd_writes = intOrZero(dados.sd_writes);
      const device_name = equipamento.nome.slice(0, 100);

      await this.prisma.iot_dispositivos_online.upsert({
        where: { topico_mqtt: topico },
        create: {
          componente_id: componente?.id ?? null,
          device_name,
          mac_address: macValido,
          ip_address: ip,
          hostname_ota,
          topico_mqtt: topico,
          online: true,
          last_seen: new Date(),
          uptime_sec,
          wifi_rssi,
          free_heap,
          firmware_versao,
          modbus_ok,
          modbus_err,
          mqtt_pub,
          sd_writes,
        },
        update: {
          componente_id: componente?.id ?? undefined,
          device_name,
          mac_address: macValido,
          ip_address: ip,
          hostname_ota,
          online: true,
          last_seen: new Date(),
          uptime_sec,
          wifi_rssi,
          free_heap,
          firmware_versao,
          modbus_ok,
          modbus_err,
          mqtt_pub,
          sd_writes,
        },
      });
    } catch (e) {
      console.error(
        `❌ [MQTT] Falha upsert iot_dispositivos_online para topico ${topico}:`,
        e,
      );
    }
  }

  /** Throttle do carimbo de liveness: no máx. 1 update / 30s por tópico. */
  private readonly _livenessThrottle = new Map<string, number>();

  /**
   * Carimba `last_seen=now(), online=true` na TON cuja BASE (`topico_mqtt`) é o
   * tópico exato OU prefixo (base + '/') do tópico da mensagem. Torna o "sinal de
   * vida" confiável mesmo quando a TON publica só de outra unidade que ela serve.
   * Best-effort (fire-and-forget) + throttle p/ não martelar o banco. Usa
   * `starts_with` (não LIKE) porque os tópicos contêm '_' (coringa do LIKE).
   */
  private touchLiveness(topic: string): void {
    try {
      const now = Date.now();
      const last = this._livenessThrottle.get(topic) || 0;
      if (now - last < 30_000) return;
      this._livenessThrottle.set(topic, now);
      // Poda simples do mapa (evita crescer indefinidamente com tópicos raros).
      if (this._livenessThrottle.size > 5000) this._livenessThrottle.clear();
      void this.prisma.$executeRaw`
        UPDATE iot_dispositivos_online
        SET last_seen = now(), online = true
        WHERE topico_mqtt = ${topic} OR starts_with(${topic}, topico_mqtt || '/')
      `.catch((e) =>
        console.error(`❌ [MQTT] touchLiveness falhou (${topic}):`, e?.message || e),
      );
    } catch {
      /* liveness é best-effort — nunca deve quebrar o handler de mensagem */
    }
  }

  /**
   * LWT do TON: marca dispositivo offline em iot_dispositivos_online.
   * No-op se nao houver topico ou linha previa para o topico (criar linha so
   * com online=false sem MAC nem device_name nao agrega valor — TON nunca
   * subiu nesse topico).
   */
  private async markDispositivoOffline(
    topicoMqtt: string | null,
  ): Promise<void> {
    const topico = topicoMqtt?.trim();
    if (!topico) return;

    try {
      await this.prisma.iot_dispositivos_online.updateMany({
        where: { topico_mqtt: topico },
        data: { online: false, last_seen: new Date() },
      });
    } catch (e) {
      console.error(
        `❌ [MQTT] Falha marcar iot_dispositivos_online offline para topico ${topico}:`,
        e,
      );
    }
  }

  /**
   * Processa ack vindo do TON em <base>/cmd/ack:
   *   { cmd_id: "<uuid>", status: "ok"|"error"|"duplicate", msg: "...", ts: 123 }
   * Resolve o Promise pendente em pendingCommands se houver.
   */
  private processCommandAck(dados: any): void {
    const cmd_id = typeof dados?.cmd_id === 'string' ? dados.cmd_id : '';
    if (!cmd_id) return;

    const pending = this.pendingCommands.get(cmd_id);
    if (!pending) {
      // Ack chegou tarde demais (já rejeitado por timeout) ou cmd_id desconhecido
      return;
    }

    clearTimeout(pending.timer);
    this.pendingCommands.delete(cmd_id);

    const result: CmdAckResult = {
      cmd_id,
      status: (dados.status as CmdAckStatus) || 'error',
      msg: typeof dados.msg === 'string' ? dados.msg : '',
      ts: typeof dados.ts === 'number' ? dados.ts : Math.floor(Date.now() / 1000),
    };
    pending.resolve(result);
  }

  /**
   * Publica um comando em <topicoBase>/cmd com envelope {cmd_id, cmd} e
   * aguarda ack em <topicoBase>/cmd/ack. Retransmite até maxAttempts vezes
   * em caso de timeout.
   *
   * @param topicoBase  Mesmo valor de equipamentos.topico_mqtt (ex.: "AUPUS_TESTE")
   * @param cmd         String ("r1 on") ou objeto ({device, cmd}) — TON aceita ambos
   * @param opts        timeoutMs default 5000, maxAttempts default 3
   * @returns CmdAckResult com status do TON. Status "duplicate" é tratado como sucesso.
   * @throws Error em timeout final (todas as tentativas esgotadas)
   */
  public publishCommand(
    topicoBase: string,
    cmd: string | object,
    opts: { timeoutMs?: number; maxAttempts?: number } = {},
  ): Promise<CmdAckResult> {
    if (!topicoBase || !topicoBase.trim()) {
      return Promise.reject(new Error('topicoBase vazio'));
    }
    if (!this.client?.connected) {
      return Promise.reject(new Error('MQTT client not connected'));
    }

    const cmd_id = randomUUID();
    const topic = `${topicoBase}/cmd`;
    const envelope = JSON.stringify({ cmd_id, cmd });
    const timeoutMs = opts.timeoutMs ?? 5000;
    const maxAttempts = opts.maxAttempts ?? 3;

    // Garante inscrição no ack do tópico PASSADO. A inscrição por-equipamento só
    // cobre o ack do tópico REAL; em SIMULAÇÃO (topicoBase = TESTE/<base>) o ack
    // chega em TESTE/<base>/cmd/ack, e sem esta inscrição ele nunca seria recebido
    // (o comando dava timeout mesmo a TON respondendo). Idempotente no caso real.
    const ackTopic = `${topic}/ack`;
    if (!this.subscriptions.has(ackTopic)) {
      this.subscriptions.set(ackTopic, []);
      this.client?.subscribe(ackTopic, { qos: 1 }, (err) => {
        if (err) console.warn(`⚠️ [MQTT] Falha ao subscrever ${ackTopic}: ${err.message}`);
      });
    }

    return new Promise<CmdAckResult>((resolve, reject) => {
      const pending: PendingCommand = {
        cmd_id,
        topic,
        envelope,
        resolve,
        reject,
        attempt: 1,
        maxAttempts,
        timeoutMs,
        timer: undefined as unknown as NodeJS.Timeout,
      };

      const armTimer = () => {
        pending.timer = setTimeout(() => {
          if (!this.pendingCommands.has(cmd_id)) return; // já resolvido
          if (pending.attempt >= maxAttempts) {
            this.pendingCommands.delete(cmd_id);
            reject(new Error(`Timeout: comando ${cmd_id} sem ack após ${maxAttempts} tentativas`));
            return;
          }
          pending.attempt++;
          console.warn(`⚠️ [MQTT-CMD] Retry ${pending.attempt}/${maxAttempts} cmd_id=${cmd_id}`);
          this.client.publish(topic, envelope, { qos: 1, retain: false }, (err) => {
            if (err) console.warn(`⚠️ [MQTT-CMD] Republish falhou: ${err.message}`);
          });
          armTimer();
        }, timeoutMs);
      };

      this.pendingCommands.set(cmd_id, pending);

      this.client.publish(topic, envelope, { qos: 1, retain: false }, (err) => {
        if (err) {
          this.pendingCommands.delete(cmd_id);
          return reject(err);
        }
      });

      armTimer();
    });
  }

  /**
   * Valida dados contra JSON Schema
   */
  private validarDadosContraSchema(dados: any, schema: any): { valido: boolean; erros?: string[] } {
    if (!schema) {
      // Se não há schema, considera válido
      return { valido: true };
    }

    try {
      const validate = this.ajv.compile(schema);
      const valido = validate(dados);

      if (!valido) {
        const erros = validate.errors?.map((err) => {
          return `${err.instancePath || '/'} ${err.message}`;
        }) || [];

        return {
          valido: false,
          erros,
        };
      }

      return { valido: true };
    } catch (error) {
      // Schema inválido ou incompatível - silenciar erro pois não bloqueia operação
      // O schema armazenado no banco usa formato customizado, não JSON Schema padrão
      // Em caso de erro no schema, considera válido para não bloquear
      return { valido: true };
    }
  }

  // ✅ Cache para equipamentos MQTT (evita N+1)
  private equipamentosCache = new Map<string, { data: any; timestamp: number }>();
  private readonly CACHE_TTL_MQTT = 300000; // 5 minutos

  /**
   * Processa e salva dados de um equipamento
   */
  private async processarDadosEquipamento(
    equipamentoId: string,
    dados: any,
    topic: string,
  ) {
    try {
      // ✅ Buscar equipamento com cache (SQL raw otimizado)
      const cacheKey = `equip_${equipamentoId}`;
      const cached = this.equipamentosCache.get(cacheKey);

      let equipamento: any;
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MQTT) {
        equipamento = cached.data;
      } else {
        // SQL raw otimizado - apenas colunas necessárias
        const equipamentoIdTrimmed = equipamentoId.trim();
        const result = await this.prisma.$queryRaw<any[]>`
          SELECT
            e.id,
            e.nome,
            e.diagrama_id,
            te.id as tipo_id,
            te.codigo as tipo_codigo,
            te.nome as tipo_nome,
            te.mqtt_schema as tipo_schema,
            ce.nome as categoria_nome
          FROM equipamentos e
          LEFT JOIN tipos_equipamentos te ON te.id = e.tipo_equipamento_id
          LEFT JOIN categorias_equipamentos ce ON ce.id = te.categoria_id
          WHERE TRIM(e.id) = ${equipamentoIdTrimmed}
          LIMIT 1
        `;

        if (result.length === 0) {
          return;
        }

        // Mapear resultado para formato esperado
        equipamento = {
          id: result[0].id,
          nome: result[0].nome,
          diagrama_id: result[0].diagrama_id,
          tipo_equipamento_rel: result[0].tipo_id ? {
            id: result[0].tipo_id,
            codigo: result[0].tipo_codigo,
            nome: result[0].tipo_nome,
            mqtt_schema: result[0].tipo_schema,
            categoria_nome: result[0].categoria_nome,
          } : null
        };

        this.equipamentosCache.set(cacheKey, {
          data: equipamento,
          timestamp: Date.now()
        });
      }

      if (!equipamento) {
        // console.warn(`⚠️ Equipamento ${equipamentoId} não encontrado`);
        return;
      }

      // Validar dados contra o schema do tipo
      let qualidade = dados.qualidade || 'GOOD';
      const schema = equipamento.tipo_equipamento_rel?.mqtt_schema; // ✅ CORRIGIDO: usar mqtt_schema

      if (schema) {
        const validacao = this.validarDadosContraSchema(dados, schema);

        if (!validacao.valido) {
          // console.warn(
          //   `⚠️ Dados inválidos para equipamento ${equipamento.nome} (${equipamento.tipo_equipamento_rel?.nome}):`,
          //   validacao.erros,
          // );
          qualidade = 'BAD';
          // Adicionar erros aos dados
          dados._validation_errors = validacao.erros;
        }
      }

      // Salvar dados no banco. Resolve a HORA DO DADO em ordem de preferencia:
      //   1) dados.ts        -> epoch (s/ms) carimbado pelo buffer SD (store-and-forward)
      //      do TON = hora de CAPTURA. Correta inclusive pra dado RETROATIVO/bufferado
      //      (drenado depois de uma queda/OTA), que nao deve usar a hora de chegada.
      //   2) dados.timestamp -> epoch (num/string) OU datetime "DD/MM/YYYY HH:MM:SS"
      //      (horario local da TON, -03:00).
      //   3) fallback        -> hora de chegada no servidor.
      // Sentinelas de TON sem NTP ("sem_ntp"/"0"/1970) sao invalidos -> proxima fonte.
      const MIN_VALID_TS_S = 1577836800; // 2020-01-01 (segundos)
      const tsFromEpoch = (v: any): Date | null => {
        const n = typeof v === 'number' ? v : (typeof v === 'string' ? Number(v) : NaN);
        if (!Number.isFinite(n)) return null;
        if (n >= MIN_VALID_TS_S && n < 10000000000) return new Date(n * 1000); // segundos
        if (n >= MIN_VALID_TS_S * 1000) return new Date(n);                    // milissegundos
        return null;
      };
      const tsFromDatetimeStr = (v: any): Date | null => {
        if (typeof v !== 'string') return null;
        // Formato do firmware: "DD/MM/YYYY HH:MM:SS" no fuso da TON (-03:00).
        const m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
        if (!m) return null;
        const d = new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}-03:00`);
        return isNaN(d.getTime()) || d.getTime() < MIN_VALID_TS_S * 1000 ? null : d;
      };
      const timestampDados: Date =
        tsFromEpoch((dados as any).ts) ??
        tsFromEpoch(dados.timestamp) ??
        tsFromDatetimeStr(dados.timestamp) ??
        new Date();

      // 🛑 Frame de inversor com overflow UINT do Modbus (leitura corrompida):
      // total_yield=2^32, daily_yield=2^16/10, info.output_type=65535, etc.
      // Recorrente (~1.4/dia nos inversores). Descarta o frame inteiro — nao
      // bufferiza, nao emite, nao grava. O filtro read-time continua como rede de
      // seguranca pro historico ja gravado.
      const glitchUint = detectarOverflowUint(dados);
      if (glitchUint.glitch) {
        console.warn(
          `🛑 [GLITCH UINT] Frame descartado de ${equipamento?.nome || equipamentoId.trim()} ` +
          `@ ${timestampDados.toISOString()} — sinais: ${glitchUint.motivos.join(', ')}`,
        );
        return;
      }

      // ✅ Se é Gateway (categoria 'Gateway' — A-966 SSU e variantes),
      // processar com extrator específico (path data.phf/phr, conversão KD).
      const categoriaNome = equipamento.tipo_equipamento_rel?.categoria_nome;
      const codigo = equipamento.tipo_equipamento_rel?.codigo;
      const isGateway = categoriaNome === 'Gateway';
      const isM160 = codigo === 'M-160' || codigo === 'M160' || codigo === 'METER_M160';

      if (isGateway) {
        try {
          await this.salvarDadosGateway(equipamentoId, dados, timestampDados, qualidade);
        } catch (error) {
          console.error(`❌ [Gateway] Erro ao processar dados:`, error);
        }
      } else if (isM160) {
        try {
          // ✅ SUPORTE A DOIS FORMATOS:
          // 1. Formato novo: JSON com campo "Resumo" (dados agregados de 30s)
          // 2. Formato direto: Dados na raiz do JSON (P666 e equipamentos CHINT)

          if (dados.Resumo && typeof dados.Resumo === 'object') {
            // Formato com campo Resumo
            await this.salvarDadosM160Resumo(equipamentoId, dados, timestampDados, qualidade);
          } else if (dados.Va !== undefined || dados.consumo_phf !== undefined) {
            // Formato direto - dados na raiz (P666/CHINT)
            // Envolver os dados em um objeto Resumo para usar a mesma função
            await this.salvarDadosM160Resumo(equipamentoId, { Resumo: dados }, timestampDados, qualidade);
          } else {
            console.warn(`⚠️ [M-160] Formato JSON desconhecido para equipamento ${equipamentoId}. Esperado campo "Resumo" ou dados na raiz. Chaves recebidas:`, Object.keys(dados));
          }

          // ⚠️ NÃO adicionar M-160 ao buffer para evitar conflito de UNIQUE constraint
          // O processamento já salvou a leitura diretamente no banco
        } catch (error) {
          console.error(`❌ [M-160] Erro ao processar dados:`, error);
          // Em caso de erro, não adicionar ao buffer - apenas logar o erro
          // Não queremos processar dados M160 pelo fluxo de buffer que foi feito para inversores
        }
      } else {
        // Adicionar ao buffer para outros equipamentos (inversores, etc)
        this.addToBuffer(equipamentoId, timestampDados, dados, qualidade);
      }

      // Emitir evento para WebSocket (com dados em tempo real)
      this.emit('equipamento_dados', {
        equipamentoId,
        diagramaId: equipamento.diagrama_id,
        dados: {
          id: `temp_${Date.now()}`,
          equipamento_id: equipamentoId,
          dados: dados as any,
          timestamp_dados: timestampDados,
          qualidade,
        },
      });

      // Verificar regras de logs MQTT
      if (this.regrasLogsMqttEngine) {
        this.regrasLogsMqttEngine.verificar(equipamentoId, dados).catch((err) => {
          console.error(`❌ Erro ao verificar regras de log para ${equipamentoId}:`, err.message);
        });
      }
    } catch (error) {
      console.error(
        `❌ Erro ao processar dados do equipamento ${equipamentoId}:`,
        error,
      );
    }
  }

  /**
   * Adiciona novo tópico dinamicamente.
   * Implementa IMqttBroker — chamado pelo EquipamentosService (api-shared) via configurarMqtt().
   */
  public adicionarTopico(equipamentoId: string, topic: string) {
    this.subscribeTopic(topic, equipamentoId, 'manual');
  }

  /**
   * Remove tópico dinamicamente. Tambem desinscreve `<topic>/status` e
   * `<topic>/cmd/ack` pareados.
   */
  public removerTopico(equipamentoId: string, topic: string) {
    this.unsubscribeTopic(topic, equipamentoId, 'manual');
    if (topic && !topic.endsWith('/status') && !topic.endsWith('/cmd/ack')) {
      this.unsubscribeTopic(`${topic}/status`, equipamentoId, 'manual');
      this.unsubscribeTopic(`${topic}/cmd/ack`, equipamentoId, 'manual');
    }
  }

  /**
   * Handler de evento emitido pelo CRUD de equipamentos (idealmente dentro
   * do EquipamentosService em src/core, apos commit da transacao).
   * Idempotente: chamar duas vezes com o mesmo payload e seguro.
   */
  @OnEvent(EQUIPAMENTO_MQTT_CHANGED, { async: true })
  async handleEquipamentoMqttChanged(payload: Partial<EquipamentoMqttChangedPayload>): Promise<void> {
    const equipamentoId = payload?.equipamentoId?.trim();
    if (!equipamentoId) {
      console.warn('[MQTT][dyn] evento equipamento.mqtt.changed sem equipamentoId');
      return;
    }
    const topicoAntigo = payload.topicoAntigo?.trim() || null;
    const topicoNovo = payload.topicoNovo?.trim() || null;
    const habilitado = !!payload.habilitado;

    if (topicoAntigo && topicoAntigo !== topicoNovo) {
      this.unsubscribeTopic(topicoAntigo, equipamentoId, 'event');
      this.unsubscribeTopic(`${topicoAntigo}/status`, equipamentoId, 'event');
      this.unsubscribeTopic(`${topicoAntigo}/cmd/ack`, equipamentoId, 'event');
    }

    if (habilitado && topicoNovo) {
      this.subscribeTopic(topicoNovo, equipamentoId, 'event');
    } else if (!habilitado && topicoNovo) {
      // Desabilitado — garantir que nao estamos mais inscritos
      this.unsubscribeTopic(topicoNovo, equipamentoId, 'event');
      this.unsubscribeTopic(`${topicoNovo}/status`, equipamentoId, 'event');
      this.unsubscribeTopic(`${topicoNovo}/cmd/ack`, equipamentoId, 'event');
    }
  }

  /**
   * Le o estado desejado do banco e ajusta as subscriptions atuais. Idempotente.
   * Defesa contra drift se um evento for perdido (deploy no meio de update,
   * crash entre commit e emit, etc.).
   */
  public async reconcileSubscriptions(): Promise<ReconcileResult> {
    const desired = await this.prisma.equipamentos.findMany({
      where: {
        mqtt_habilitado: true,
        topico_mqtt: { not: null },
        NOT: { topico_mqtt: '' },
        deleted_at: null,
      },
      select: { id: true, topico_mqtt: true },
    });

    // equipamentoId -> topicoPrimario (ja trim/validado)
    const desiredMap = new Map<string, string>();
    for (const e of desired) {
      const id = e.id?.trim();
      const topic = e.topico_mqtt?.trim();
      if (id && this.isValidTopic(topic)) {
        desiredMap.set(id, topic!);
      }
    }

    // equipamentoId -> Set<topicoPrimario>. Subtópicos DERIVADOS (criados por
    // subscribeTopic a partir do primário) não podem entrar aqui: se entrarem, o
    // reconcile os vê como primário "não desejado" e os desinscreve — foi o que
    // acontecia com /inputs e /evt (a ingestão parava após o 1º reconcile).
    const DERIVADOS = ['/status', '/diagnostics', '/cmd/ack', '/inputs', '/evt'];
    const currentMap = new Map<string, Set<string>>();
    for (const [topic, equipIds] of this.subscriptions.entries()) {
      if (DERIVADOS.some((suf) => topic.endsWith(suf))) continue;
      for (const equipId of equipIds) {
        const id = equipId.trim();
        if (!currentMap.has(id)) currentMap.set(id, new Set());
        currentMap.get(id)!.add(topic);
      }
    }

    const added: Array<{ equipamentoId: string; topic: string }> = [];
    const removed: Array<{ equipamentoId: string; topic: string }> = [];

    // Adicionar o que esta no desejado mas nao no atual
    for (const [equipamentoId, topic] of desiredMap.entries()) {
      const currentTopics = currentMap.get(equipamentoId);
      if (!currentTopics || !currentTopics.has(topic)) {
        this.subscribeTopic(topic, equipamentoId, 'reconcile');
        added.push({ equipamentoId, topic });
      }
    }

    // Remover o que esta no atual mas nao bate com o desejado
    for (const [equipamentoId, currentTopics] of currentMap.entries()) {
      const desiredTopic = desiredMap.get(equipamentoId);
      for (const topic of currentTopics) {
        if (desiredTopic !== topic) {
          this.unsubscribeTopic(topic, equipamentoId, 'reconcile');
          // Leva junto os derivados do primário removido.
          for (const suf of DERIVADOS) {
            this.unsubscribeTopic(`${topic}${suf}`, equipamentoId, 'reconcile');
          }
          removed.push({ equipamentoId, topic });
        }
      }
    }

    if (this.logLevel !== 'minimal') {
      if (added.length === 0 && removed.length === 0) {
        console.log(`[MQTT][reconcile] ok (${desiredMap.size} topicos)`);
      } else {
        console.log(`[MQTT][reconcile] +${added.length} -${removed.length} (alvo: ${desiredMap.size})`);
      }
    }

    return { added, removed, total: desiredMap.size };
  }

  /**
   * Reconciliacao periodica defensiva (a cada 5 min). Se um evento foi perdido
   * (deploy, crash, condicao de corrida), o estado converge na proxima rodada.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async scheduledReconcile(): Promise<void> {
    const mqttMode = process.env.MQTT_MODE || 'production';
    if (mqttMode === 'disabled') return;
    if (!this.client) return;

    try {
      await this.reconcileSubscriptions();
    } catch (error: any) {
      console.error('[MQTT][reconcile] erro:', error?.message || error);
    }
  }

  /**
   * Desconecta do MQTT
   */
  public disconnect() {
    if (this.client) {
      this.client.end();
      // console.log('🔌 MQTT desconectado');
    }
  }

  /**
   * Verifica se o MQTT está conectado (para health check)
   */
  public isConnected(): boolean {
    return this.client?.connected || false;
  }

  /**
   * Publica uma mensagem MQTT. Usa QoS 1 e retained=false por padrão.
   * @returns Promise que resolve quando o broker ackar (QoS 1) ou após envio (QoS 0).
   * @throws Error se o cliente não estiver conectado ou se o publish falhar.
   */
  public publish(
    topic: string,
    payload: string | Buffer,
    opts: { qos?: 0 | 1 | 2; retain?: boolean } = {},
  ): Promise<void> {
    if (!this.client || !this.client.connected) {
      return Promise.reject(new Error('MQTT client not connected'));
    }
    const qos = (opts.qos ?? 1) as 0 | 1 | 2;
    const retain = opts.retain ?? false;
    return new Promise<void>((resolve, reject) => {
      this.client.publish(topic, payload, { qos, retain }, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  /**
   * Registra listener temporario para `<topic_base>/ota/status`.
   * Subscreve no broker se ainda nao estava subscrito. Sobrescreve handler
   * anterior do mesmo topico (so um OTA por equipamento por vez).
   * Usado pelo OtaService para limpar o retained do cmd assim que TON confirma.
   */
  public addOtaStatusListener(topic: string, handler: (data: any) => void): void {
    const alreadyRegistered = this.otaStatusListeners.has(topic);
    this.otaStatusListeners.set(topic, handler);
    if (alreadyRegistered) return;
    this.client?.subscribe(topic, { qos: 1 }, (err) => {
      if (err) {
        console.warn(`⚠️ [MQTT] Falha subscrevendo ota/status ${topic}: ${err.message}`);
      }
    });
  }

  /**
   * Remove listener de ota/status e desinscreve do broker.
   */
  public removeOtaStatusListener(topic: string): void {
    if (!this.otaStatusListeners.has(topic)) return;
    this.otaStatusListeners.delete(topic);
    this.client?.unsubscribe(topic, (err) => {
      if (err) {
        console.warn(`⚠️ [MQTT] Falha desinscrevendo ota/status ${topic}: ${err.message}`);
      }
    });
  }

  /**
   * Retorna o número de tópicos subscritos (para health check)
   */
  public getSubscribedTopicsCount(): number {
    return this.subscriptions.size;
  }

  /**
   * Retorna lista de tópicos subscritos (para debug/monitoring)
   */
  public getSubscribedTopics(): string[] {
    return Array.from(this.subscriptions.keys());
  }

  /**
   * Determina qualidade dos dados M160 baseado nos valores reais
   */
  private determinarQualidadeM160(resumo: any): 'boa' | 'parcial' | 'ruim' {
    // Verificar se tem tensões
    const temTensao = (resumo.Va > 0 || resumo.Vb > 0 || resumo.Vc > 0);

    // Verificar se tem corrente
    const temCorrente = (resumo.Ia > 0 || resumo.Ib > 0 || resumo.Ic > 0);

    // Verificar se tem potência
    const temPotencia = (resumo.Pa > 0 || resumo.Pb > 0 || resumo.Pc > 0 || resumo.Pt > 0);

    // Regras de qualidade:
    // BOA: Tem tensão + corrente + potência (consumo real)
    // PARCIAL: Tem tensão mas sem corrente (instalação sem carga - normal)
    // RUIM: Sem tensão (desligado/desconectado)

    if (!temTensao) {
      return 'ruim'; // Sem tensão = equipamento desligado/problema
    }

    if (temCorrente && temPotencia) {
      return 'boa'; // Tudo funcionando, medindo consumo real
    }

    // Tem tensão mas sem corrente = instalação energizada mas sem carga
    // Isso é NORMAL em muitos casos (ex: noite, final de semana)
    return 'parcial';
  }

  /**
   * Salva dados do M160 no novo formato (Resumo)
   * Novo formato: JSON chega agregado de 30 em 30 segundos
   */
  /**
   * Persiste leitura do Gateway A-966 SSU (categoria 'Gateway') em
   * equipamentos_dados, extraindo phf/phr de `dados.data` (path aninhado,
   * fallback pro path direto) e convertendo pulsos em kWh via KD.
   *
   * Convenção bidirecional usada pelo agregado de demanda:
   *   energia_kwh   = (phr − phf) × KD  → positivo = geração líquida
   *   potencia_kw   = energia_kwh × 4   → bucket nominal de 15 min
   * Esse formato bate com o sinal +1 do BIDIRECIONAL no frontend
   * (categoria-fluxo.ts) — o agregado V2 (potencia_ativa_kw / energia_kwh)
   * funciona sem refactor adicional.
   *
   * Filtros aplicados (Z em vez de gravar 0 que polui agregados):
   *   - sts !== 1       → boot/init; grava bruto, energia/potencia NULL
   *   - cdo == null     → firmware antigo (payload {}); idem
   *   - NSU === 1       → primeira leitura pós-boot, dump cumulativo
   *                       do downtime; preserva bruto mas energia/potencia NULL
   *   - phf alto + phr alto no mesmo bucket → glitch isolado (pulso vazado
   *                       do contador phr pro phf); zera phf antes do delta
   *
   * Constantes duplicadas com gateway-dashboard.service.ts /
   * useGatewayGraficos.ts / a966-modal.tsx — extrair pra util compartilhada
   * num próximo refactor (ver "depois vamos revisar essa função").
   */
  private async salvarDadosGateway(
    equipamentoId: string,
    dados: any,
    timestamp: Date,
    qualidadeOriginal: string,
  ) {
    const KD_A966_SSU = 0.048;        // pulsos → kWh
    const BUCKET_HORAS = 0.25;        // 15 min nominal
    const GLITCH_PHF_THRESHOLD = 100; // pulsos; ≈ 4.8 kWh em 15min

    const mqttMode = process.env.MQTT_MODE || 'production';
    const payload = dados?.data && typeof dados.data === 'object' ? dados.data : dados;

    // cdo distingue firmware novo (presente) de antigo (payload {} → null). Em
    // alguns firmwares o meta-field vem dentro de `data` em vez do envelope, então
    // lê defensivo (inner → envelope), espelhando o COALESCE(data->>x, ->>x) que os
    // leitores do gateway já usam pra phf/phr. Superset do comportamento anterior:
    // quando cdo está no envelope, `payload?.cdo` é undefined e cai no fallback.
    const cdo = payload?.cdo ?? dados?.cdo;
    const nsu = Number(dados?.NSU ?? dados?.nsu ?? NaN);
    const sts = Number(payload?.sts ?? NaN);

    // Filtros: situações em que NÃO confiamos no valor de energia da leitura.
    // Persistimos a leitura crua (pra debug/auditoria) mas zeramos as colunas
    // que entram no agregado.
    const ehBootInit = sts !== 1;
    const ehFirmwareAntigo = cdo == null;
    const ehDumpPosBoot = nsu === 1;
    const ignorarParaAgregado = ehBootInit || ehFirmwareAntigo || ehDumpPosBoot;

    let phf = Number(payload?.phf ?? 0);
    const phr = Number(payload?.phr ?? 0);

    // Glitch detector: equipamento gerador puro tem phf=0 sempre. Quando
    // chega phf > THRESHOLD junto com phr > THRESHOLD num mesmo bucket, é
    // pulso vazado do contador phr pro phf (~1 ocorrência por 2 semanas
    // observada em prod). Zera phf antes do delta. Bruto fica intacto no JSONB.
    const glitchPhf =
      !ignorarParaAgregado &&
      phf > GLITCH_PHF_THRESHOLD &&
      phr > GLITCH_PHF_THRESHOLD;
    if (glitchPhf) {
      phf = 0;
    }

    let potenciaMediaKw: number | null = null;
    let energiaKwh: number | null = null;
    if (!ignorarParaAgregado) {
      const pulsosLiquidos = phr - phf;       // + = geração, − = consumo
      energiaKwh = pulsosLiquidos * KD_A966_SSU;
      potenciaMediaKw = energiaKwh / BUCKET_HORAS;
    }

    // Limpar campos que não vieram do MQTT antes de salvar.
    const dadosProcessados: any = { ...dados };
    delete dadosProcessados._validation_errors;
    if (glitchPhf) {
      dadosProcessados._aupus_glitch_phf = true;
    }
    if (ehDumpPosBoot) {
      dadosProcessados._aupus_post_boot_dump = true;
    }

    // P_direto / P_rev separados (importação / exportação) pro COA (carga = geração +
    // líquido do medidor). phf=forward (importada), phr=reverse (exportada); phf/phr já
    // são pulsos do bucket → potência média (kW) = pulsos × KD / horas. Não altera o
    // potencia_ativa_kw (net geração, usado no agregado de demanda) — só ADICIONA no JSON.
    if (!ignorarParaAgregado) {
      const _fpul = KD_A966_SSU / BUCKET_HORAS; // pulso do bucket → kW / kVAr
      const _pDir = Number(phf) * _fpul;   // importada (kW)
      const _pRev = Number(phr) * _fpul;   // exportada (kW)
      // Reativo (kVAr): 4 quadrantes — indutivo(+) qhfi/qhri, capacitivo(−) qhfc/qhrc.
      // Mesma KD do ativo (pulso→kVArh) — assumido; ajustar se o A966 usar constante própria.
      const _qInd = (Number(payload?.qhfi ?? 0) + Number(payload?.qhri ?? 0));
      const _qCap = (Number(payload?.qhfc ?? 0) + Number(payload?.qhrc ?? 0));
      const _qLiq = (_qInd - _qCap) * _fpul;   // reativo líquido (indutivo +)
      const _pNet = _pDir - _pRev;             // ativo líquido (import +)
      const _sMag = Math.sqrt(_pNet * _pNet + _qLiq * _qLiq);
      dadosProcessados.P_direto = Math.round(_pDir * 1000) / 1000;
      dadosProcessados.P_rev = Math.round(_pRev * 1000) / 1000;
      dadosProcessados.Q_liquido = Math.round(_qLiq * 1000) / 1000;   // kVAr (indutivo +)
      dadosProcessados.FP_calc = _sMag > 0.001 ? Math.round((Math.abs(_pNet) / _sMag) * 1000) / 1000 : 1;
    }

    if (mqttMode === 'development') {
      console.log(`📨 [DEV] Gateway recebido (não salva):`, {
        equipamento: equipamentoId,
        sts,
        nsu,
        phf,
        phr,
        energia: energiaKwh,
        potencia: potenciaMediaKw,
        flags: { ehBootInit, ehFirmwareAntigo, ehDumpPosBoot, glitchPhf },
      });
      return;
    }

    try {
      await this.prisma.equipamentos_dados.upsert({
        where: {
          uk_equipamento_timestamp: {
            equipamento_id: equipamentoId,
            timestamp_dados: timestamp,
          },
        },
        update: {
          dados: dadosProcessados as any,
          fonte: 'MQTT',
          timestamp_fim: timestamp,
          num_leituras: 1,
          qualidade: qualidadeOriginal,
          potencia_ativa_kw: potenciaMediaKw,
          energia_kwh: energiaKwh,
        },
        create: {
          equipamento_id: equipamentoId,
          dados: dadosProcessados as any,
          fonte: 'MQTT',
          timestamp_dados: timestamp,
          timestamp_fim: timestamp,
          num_leituras: 1,
          qualidade: qualidadeOriginal,
          potencia_ativa_kw: potenciaMediaKw,
          energia_kwh: energiaKwh,
        },
      });
    } catch (error) {
      console.error(`❌ [Gateway] Falha ao salvar no PostgreSQL.`, error);
      if (this.redisBuffer) {
        await this.redisBuffer.salvarNoBuffer(equipamentoId, timestamp, dadosProcessados);
      }
      throw error;
    }

    if (ignorarParaAgregado) {
      console.log(
        `⚠️ [Gateway] ${equipamentoId.substring(0, 8)} | ` +
        `bruto-only (${ehBootInit ? 'sts!=1 ' : ''}${ehFirmwareAntigo ? 'cdo=null ' : ''}${ehDumpPosBoot ? 'NSU=1' : ''})`,
      );
    } else {
      console.log(
        `✅ [Gateway] ${equipamentoId.substring(0, 8)} | ` +
        `${(energiaKwh ?? 0).toFixed(3)}kWh | ${(potenciaMediaKw ?? 0).toFixed(2)}kW | ` +
        `phf=${phf} phr=${phr}${glitchPhf ? ' (phf glitch zerado)' : ''}`,
      );
    }
  }

  private async salvarDadosM160Resumo(
    equipamentoId: string,
    dados: any,
    timestamp: Date,
    qualidadeOriginal: string,
  ) {
    const mqttMode = process.env.MQTT_MODE || 'production';

    try {
      const resumo = dados.Resumo;

      // ✅ Determinar qualidade baseado nos DADOS REAIS, não no campo qualidade do MQTT
      const qualidadeReal = this.determinarQualidadeM160(resumo);

      // Extrair timestamp do Resumo (se disponível) ou usar o fornecido
      let timestampDados = timestamp;
      if (resumo.timestamp) {
        if (typeof resumo.timestamp === 'number') {
          // Timestamp numérico (epoch em segundos ou milissegundos)
          const ts = resumo.timestamp;
          if (ts < 10000000000) {
            timestampDados = new Date(ts * 1000);
          } else {
            timestampDados = new Date(ts);
          }
        } else if (typeof resumo.timestamp === 'string') {
          // Timestamp string - pode ser formato brasileiro "DD/MM/YYYY HH:mm:ss"
          const tsString = resumo.timestamp.trim();

          // Tentar formato brasileiro: DD/MM/YYYY HH:mm:ss
          const brazilianDateMatch = tsString.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
          if (brazilianDateMatch) {
            const [_, day, month, year, hour, minute, second] = brazilianDateMatch;
            // ✅ CORREÇÃO CRÍTICA: O timestamp do M160 vem no horário de Brasília (BRT/BRST = UTC-3)
            // Precisamos converter para UTC adicionando 3 horas antes de criar o Date
            // Isso garante que ao salvar no PostgreSQL o timestamp esteja correto em UTC
            const isoString = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:${second.padStart(2, '0')}-03:00`;
            timestampDados = new Date(isoString);
          } else {
            // Tentar parse ISO ou outros formatos
            const ts = parseInt(tsString);
            if (!isNaN(ts)) {
              if (ts < 10000000000) {
                timestampDados = new Date(ts * 1000);
              } else {
                timestampDados = new Date(ts);
              }
            } else {
              // Tentar Date parse direto. Se falhar (ex: TON envia "sem_ntp"
              // quando NTP nao sincronizou), manter o timestamp default em
              // vez de gerar Invalid Date — Prisma rejeita Invalid Date no
              // upsert. Cai no `timestamp` recebido como parametro (now do server).
              const parsed = new Date(tsString);
              if (!isNaN(parsed.getTime())) {
                timestampDados = parsed;
              }
            }
          }
        }
      }

      // Guard final: timestamp invalido OU implausivel (TON sem NTP manda "0" ou
      // "sem_ntp"). "sem_ntp" -> parseInt = NaN -> Invalid Date. "0" -> new Date(0)
      // = 1970-01-01 (valido mas absurdo). Sem este guard, ts "0" salvava tudo em
      // 1970 e o upsert por (equipamento_id, timestamp_dados) colapsava TODAS as
      // leituras numa unica linha — sumindo do grafico/custos. Qualquer data antes
      // de 2020 vira hora do servidor.
      const MIN_VALID_TS_MS = Date.UTC(2020, 0, 1);
      if (isNaN(timestampDados.getTime()) || timestampDados.getTime() < MIN_VALID_TS_MS) {
        timestampDados =
          (!isNaN(timestamp.getTime()) && timestamp.getTime() >= MIN_VALID_TS_MS)
            ? timestamp
            : new Date();
      }

      // Calcular energia e potência do período
      // 30 segundos = 30/3600 horas = 0.00833... horas
      const tempoHoras = 30 / 3600; // 30 segundos em horas

      // ✅ PRIORIDADE 1: consumo_phf (energia real medida pelo equipamento nos últimos 30s)
      let energiaKwh = resumo.consumo_phf || 0;
      let potenciaMediaKw = 0;

      // Opção 2: energia_total (formato alternativo)
      if (energiaKwh === 0 && resumo.energia_total) {
        energiaKwh = resumo.energia_total;
      }

      // Opção 3: calcular baseado na potência Pt (em W) - FALLBACK apenas se não tiver consumo_phf
      if (energiaKwh === 0 && resumo.Pt) {
        potenciaMediaKw = resumo.Pt / 1000; // W para kW
        energiaKwh = potenciaMediaKw * tempoHoras; // kW × horas = kWh
      }

      // Calcular potência se já tem energia
      if (energiaKwh > 0 && potenciaMediaKw === 0) {
        potenciaMediaKw = energiaKwh / tempoHoras;
      }

      // Se tem Pt no JSON, usar como potência (mais preciso)
      if (resumo.Pt) {
        potenciaMediaKw = resumo.Pt / 1000;
      }

      // ✅ Guarda anti-outlier no consumo_phf
      //
      // Firmware envia consumo_phf como delta da janela de ~30s (modo 'delta').
      // Há um bug conhecido em que a "primeira amostra" da janela fica num
      // snapshot antigo/zerado em NVM, fazendo consumo_phf ≈ phf cumulativo
      // (ex: consumo_phf=10381 com phf=10557). Mais de 5 kWh em 30s equivale
      // a > 600 kW — fisicamente impossível neste medidor.
      //
      // Quando detectado, substituímos o valor pelo delta-phf real
      // (phf_atual - phf_anterior). Mantém phf cru intocado.
      // Falha da query NÃO bloqueia a gravação — fallback é manter como veio.
      const MAX_CONSUMO_PHF_POR_LEITURA = 5; // kWh
      if (typeof resumo.consumo_phf === 'number' && resumo.consumo_phf > MAX_CONSUMO_PHF_POR_LEITURA) {
        try {
          const ultima = await this.prisma.equipamentos_dados.findFirst({
            where: {
              equipamento_id: equipamentoId,
              timestamp_dados: { lt: timestamp },
            },
            orderBy: { timestamp_dados: 'desc' },
            select: { dados: true },
          });

          const phfAtual = Number(resumo.phf ?? 0);
          const phfAnterior = ultima ? Number((ultima.dados as any)?.phf ?? 0) : 0;
          const deltaPhf = phfAtual - phfAnterior;
          const corrigido = deltaPhf >= 0 ? deltaPhf : 0;

          console.warn(
            `[M-160] consumo_phf outlier corrigido em ${equipamentoId} @ ` +
            `${timestamp.toISOString()}: ${resumo.consumo_phf} → ${corrigido} ` +
            `(phf ${phfAnterior} → ${phfAtual})`,
          );

          resumo.consumo_phf = corrigido;
        } catch (err) {
          console.warn(
            `[M-160] Falha ao calcular delta-phf de fallback em ${equipamentoId}: ` +
            `${err instanceof Error ? err.message : String(err)}. Salvando consumo_phf como veio.`,
          );
        }
      }

      // ✅ SALVAR APENAS JSON ORIGINAL (sem adicionar campos extras)
      // Remover campos que não vieram do MQTT (_validation_errors, etc.)
      const dadosProcessados = { ...resumo };
      delete dadosProcessados._validation_errors;

      // Em modo DEVELOPMENT: Apenas logar, NÃO salvar no banco
      if (mqttMode === 'development') {
        console.log(`📨 [DEV] M-160 Resumo recebido (não salva):`, {
          equipamento: equipamentoId,
          energia: energiaKwh.toFixed(4) + ' kWh',
          potencia: potenciaMediaKw.toFixed(2) + ' kW',
          leituras: resumo.total_leituras || 1,
          timestamp: timestampDados.toISOString()
        });
        return;
      }

      // PRODUÇÃO: Salvar diretamente no banco (sem buffer) - usar upsert para evitar conflito de UNIQUE constraint
      try {
        await this.prisma.equipamentos_dados.upsert({
          where: {
            uk_equipamento_timestamp: {
              equipamento_id: equipamentoId,
              timestamp_dados: timestampDados,
            },
          },
          update: {
            dados: dadosProcessados as any,
            fonte: 'MQTT',
            timestamp_fim: timestampDados,
            num_leituras: resumo.total_leituras || 1,
            qualidade: qualidadeReal, // ✅ Usar qualidade calculada baseada nos dados reais
            // ✅ CAMPOS CRÍTICOS PARA CÁLCULO DE CUSTOS
            potencia_ativa_kw: potenciaMediaKw,
            energia_kwh: energiaKwh,
          },
          create: {
            equipamento_id: equipamentoId,
            dados: dadosProcessados as any,
            fonte: 'MQTT',
            timestamp_dados: timestampDados,
            timestamp_fim: timestampDados,
            num_leituras: resumo.total_leituras || 1,
            qualidade: qualidadeReal, // ✅ Usar qualidade calculada baseada nos dados reais
            // ✅ CAMPOS CRÍTICOS PARA CÁLCULO DE CUSTOS
            potencia_ativa_kw: potenciaMediaKw,
            energia_kwh: energiaKwh,
          },
        });
      } catch (error) {
        // ❌ FALHA AO SALVAR NO BANCO: Usar buffer Redis
        console.error(`❌ [M-160] Falha ao salvar no PostgreSQL. Salvando no buffer Redis...`, error);

        if (this.redisBuffer) {
          await this.redisBuffer.salvarNoBuffer(equipamentoId, timestampDados, dadosProcessados);
          console.log(`✅ [M-160] Dados salvos no buffer Redis para retry automático`);
        } else {
          console.error(`❌ [M-160] Buffer Redis não disponível! Dados perdidos.`);
        }

        // Re-throw para propagar o erro
        throw error;
      }

      // ✅ LOG COMPACTO (otimizado para performance)
      const qualidadeIcon = qualidadeReal === 'boa' ? '✅' : qualidadeReal === 'parcial' ? '⚠️' : '❌';
      console.log(
        `${qualidadeIcon} [M-160] ${equipamentoId.substring(0, 8)} | ` +
        `${qualidadeReal.toUpperCase()} | ` +
        `${energiaKwh.toFixed(4)}kWh | ` +
        `${(resumo.Pt || 0)}W | ` +
        `V:${resumo.Va?.toFixed(1)}/${resumo.Vb?.toFixed(1)}/${resumo.Vc?.toFixed(1)} | ` +
        `I:${resumo.Ia?.toFixed(1)}/${resumo.Ib?.toFixed(1)}/${resumo.Ic?.toFixed(1)}A | ` +
        `${resumo.total_leituras || 1}x`,
      );


      // ✅ NOVO FORMATO: Não precisa processar PHF via MqttIngestionService
      // O novo formato já vem com energia calculada (energia_total) e não tem PHF acumulado
      // O campo somatorio_phf é apenas informativo, não precisa calcular delta

    } catch (error) {
      console.error(`❌ [M-160 Resumo] Erro ao salvar dados:`, error);
      throw error;
    }
  }

  /**
   * Adiciona dados ao buffer de agregação
   */
  private addToBuffer(
    equipamentoId: string,
    timestamp: Date,
    dados: any,
    qualidade: string,
  ) {
    let buffer = this.buffers.get(equipamentoId);

    if (!buffer) {
      buffer = {
        equipamentoId,
        leituras: [],
        timestamp_inicio: new Date(),
      };
      this.buffers.set(equipamentoId, buffer);
      // console.log(`📊 [Buffer] Criado buffer para equipamento ${equipamentoId}`);
    }

    buffer.leituras.push({
      timestamp,
      dados: { ...dados, _qualidade: qualidade },
    });
  }

  /**
   * Flush de todos os buffers
   */
  private async flushAllBuffers() {
    const equipamentoIds = Array.from(this.buffers.keys());

    if (equipamentoIds.length === 0) {
      return;
    }

    // console.log(`🔄 [Buffer] Flush de ${equipamentoIds.length} buffers...`);

    for (const equipamentoId of equipamentoIds) {
      const buffer = this.buffers.get(equipamentoId);
      if (buffer) {
        await this.flushBuffer(equipamentoId, buffer);
      }
    }
  }

  /**
   * Flush de um buffer específico
   */
  private async flushBuffer(equipamentoId: string, buffer: BufferData) {
    if (buffer.leituras.length === 0) {
      return;
    }

    const mqttMode = process.env.MQTT_MODE || 'production';

    // Copiar leituras antes de tentar salvar
    const leiturasSalvar = [...buffer.leituras];

    try {
      // ✅ Buscar tópico MQTT do equipamento com cache
      const cacheKey = `equip_${equipamentoId}`;
      const cached = this.equipamentosCache.get(cacheKey);

      let equipamento: any;
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MQTT) {
        equipamento = cached.data;
      } else {
        // SQL raw otimizado - apenas colunas necessárias
        const result = await this.prisma.$queryRaw<any[]>`
          SELECT id, topico_mqtt, nome
          FROM equipamentos
          WHERE TRIM(id) = ${equipamentoId.trim()}
          LIMIT 1
        `;

        equipamento = result[0] || null;

        if (equipamento) {
          this.equipamentosCache.set(cacheKey, {
            data: equipamento,
            timestamp: Date.now()
          });
        }
      }

      const timestamp_fim = new Date();

      // Calcular agregações para inversores
      const dadosAgregados = this.calcularAgregacoes(leiturasSalvar, equipamento?.topico_mqtt);

      // Determinar qualidade geral do período
      const qualidades = leiturasSalvar.map((l) => l.dados._qualidade);
      const numGood = qualidades.filter((q) => q === 'GOOD').length;
      const qualidadeGeral =
        numGood > leiturasSalvar.length / 2 ? 'bom' : numGood > 0 ? 'parcial' : 'ruim';

      // Em modo DEVELOPMENT: Apenas logar, NÃO salvar no banco
      if (mqttMode === 'development') {
        console.log(`📨 [DEV] Buffer flush simulado (não salva):`, {
          equipamento: equipamentoId,
          leituras: leiturasSalvar.length,
          qualidade: qualidadeGeral,
          timestamp_inicio: buffer.timestamp_inicio,
          dados_amostra: dadosAgregados.power?.active_total
            ? `${dadosAgregados.power.active_total}W`
            : dadosAgregados.Dados?.Pa
            ? `${dadosAgregados.Dados.Pa}W`
            : 'N/A'
        });

        // Limpar buffer mesmo sem salvar
        buffer.leituras = [];
        buffer.timestamp_inicio = new Date();
        return;
      }

      // ✅ EXTRAIR energia_kwh e potencia_ativa_kw dos dados agregados
      let energiaKwh: number | null = null;
      let potenciaAtivaKw: number | null = null;

      // Para inversores: energy.period_energy_kwh e power.active_total
      if (dadosAgregados.energy?.period_energy_kwh !== undefined) {
        energiaKwh = dadosAgregados.energy.period_energy_kwh;
      }
      if (dadosAgregados.power?.active_total !== undefined) {
        potenciaAtivaKw = dadosAgregados.power.active_total / 1000; // W para kW
      }

      // PRODUÇÃO: Salvar normalmente no banco
      // ✅ CORREÇÃO CRÍTICA: Usar upsert() em vez de create() para evitar erro P2002
      // quando múltiplas instâncias tentam salvar o mesmo dado
      try {
        await this.prisma.equipamentos_dados.upsert({
          where: {
            uk_equipamento_timestamp: {
              equipamento_id: equipamentoId,
              timestamp_dados: buffer.timestamp_inicio,
            },
          },
          update: {
            dados: dadosAgregados as any,
            fonte: 'MQTT',
            timestamp_fim,
            num_leituras: leiturasSalvar.length,
            qualidade: qualidadeGeral,
            // ✅ CAMPOS CRÍTICOS PARA CÁLCULO DE CUSTOS
            energia_kwh: energiaKwh,
            potencia_ativa_kw: potenciaAtivaKw,
          },
          create: {
            equipamento_id: equipamentoId,
            dados: dadosAgregados as any,
            fonte: 'MQTT',
            timestamp_dados: buffer.timestamp_inicio,
            timestamp_fim,
            num_leituras: leiturasSalvar.length,
            qualidade: qualidadeGeral,
            // ✅ CAMPOS CRÍTICOS PARA CÁLCULO DE CUSTOS
            energia_kwh: energiaKwh,
            potencia_ativa_kw: potenciaAtivaKw,
          },
        });
      } catch (error) {
        // ❌ FALHA AO SALVAR NO BANCO: Usar buffer Redis
        console.error(`❌ [Buffer] Falha ao salvar no PostgreSQL. Salvando no buffer Redis...`, error);

        if (this.redisBuffer) {
          // Salvar cada leitura individualmente no buffer
          for (const leitura of leiturasSalvar) {
            await this.redisBuffer.salvarNoBuffer(equipamentoId, leitura.timestamp, leitura.dados);
          }
          console.log(`✅ [Buffer] ${leiturasSalvar.length} leituras salvas no buffer Redis para retry automático`);
        } else {
          console.error(`❌ [Buffer] Buffer Redis não disponível! ${leiturasSalvar.length} leituras perdidas.`);
        }

        // Re-throw para propagar o erro e manter as leituras no buffer local
        throw error;
      }

      // console.log(
      //   `✅ [Buffer] Flush ${equipamentoId}: ${leiturasSalvar.length} leituras agregadas (${qualidadeGeral})`,
      // );

      // Log de informações por tipo de equipamento
      // if (dadosAgregados.Dados) {
      //   // M-160 - Multimedidor
      //   const potTotal = dadosAgregados.Dados.Pa + dadosAgregados.Dados.Pb + dadosAgregados.Dados.Pc;
      //   console.log(`   📊 [M-160] Potência Total: ${potTotal.toFixed(2)} W (${(potTotal / 1000).toFixed(2)} kW)`);
      //   console.log(`   📊 [M-160] Por Fase: A=${dadosAgregados.Dados.Pa.toFixed(2)}W | B=${dadosAgregados.Dados.Pb.toFixed(2)}W | C=${dadosAgregados.Dados.Pc.toFixed(2)}W`);
      //   console.log(`   🔌 [M-160] Tensões: Va=${dadosAgregados.Dados.Va.toFixed(1)}V | Vb=${dadosAgregados.Dados.Vb.toFixed(1)}V | Vc=${dadosAgregados.Dados.Vc.toFixed(1)}V`);
      //   console.log(`   ⚡ [M-160] Energia Importada: ${dadosAgregados.Dados.phf.toFixed(2)} kWh | Exportada: ${dadosAgregados.Dados.phr.toFixed(2)} kWh`);
      //   if (dadosAgregados.Dados.period_energy_kwh) {
      //     console.log(`   ⏱️ [M-160] Energia no período: ${dadosAgregados.Dados.period_energy_kwh} kWh`);
      //   }
      // } else if (dadosAgregados.power?.active_total !== undefined) {
      //   // Inversores
      //   console.log(
      //     `   📊 Potência Ativa: ${dadosAgregados.power.active_total} W (${(dadosAgregados.power.active_total / 1000).toFixed(2)} kW)`,
      //   );
      //   if (dadosAgregados.energy?.period_energy_kwh) {
      //     console.log(`   ⚡ Energia no período: ${dadosAgregados.energy.period_energy_kwh} kWh`);
      //   }
      // } else if (dadosAgregados.power_avg !== undefined) {
      //   // Estrutura legada
      //   console.log(
      //     `   📊 Potência: min=${dadosAgregados.power_min?.toFixed(2)} avg=${dadosAgregados.power_avg?.toFixed(2)} max=${dadosAgregados.power_max?.toFixed(2)} kW`,
      //   );
      //   console.log(`   ⚡ Energia: ${dadosAgregados.energia_kwh?.toFixed(4)} kWh`);
      // }

      // ✅ CORREÇÃO: Só limpar buffer após salvar com sucesso
      buffer.leituras = [];
      buffer.timestamp_inicio = new Date();
    } catch (error) {
      // ❌ CORREÇÃO: Não limpar buffer se deu erro - manter dados para próxima tentativa
      console.error(
        `❌ [Buffer] Erro ao fazer flush do buffer ${equipamentoId} (mantendo ${buffer.leituras.length} leituras para retry):`,
        error
      );
    }
  }

  /**
   * Calcula agregações dos dados (média, min, max, etc)
   * Preserva a estrutura aninhada dos dados do inversor
   */
  private calcularAgregacoes(
    leituras: Array<{ timestamp: Date; dados: any }>,
    topicoMqtt?: string,
  ): any {
    if (leituras.length === 0) {
      return {};
    }

    const ultimaLeitura = leituras[leituras.length - 1].dados;
    const primeiraLeitura = leituras[0];

    // Estrutura base: timestamp e status da última leitura
    const agregado: any = {
      timestamp: ultimaLeitura.timestamp,
    };

    // Copiar status da última leitura
    if (ultimaLeitura.status) {
      agregado.status = ultimaLeitura.status;
    }

    // Copiar info se existir
    if (ultimaLeitura.info) {
      agregado.info = ultimaLeitura.info;
    }

    // Verificar tipo de estrutura
    const isInversorData = ultimaLeitura.power && typeof ultimaLeitura.power === 'object';
    const isM160Data = ultimaLeitura.Dados && typeof ultimaLeitura.Dados === 'object';

    if (isM160Data) {
      // ⚠️ ATENÇÃO: Esta lógica NÃO É MAIS USADA para M160!
      // M160 agora envia dados no formato "Resumo" e são salvos diretamente via salvarDadosM160Resumo()
      // M160 NÃO passa pelo buffer, portanto esta função nunca será chamada para M160
      // Este código permanece apenas para retrocompatibilidade com possíveis equipamentos legados

      // ESTRUTURA M-160 LEGADA - Multimedidor 4Q
      // Estrutura: { Dados: { phf, phr, qhfi, qhri, Va, Vb, Vc, Ia, Ib, Ic, Pa, Pb, Pc, FPA, FPB, FPC, freq, timestamp } }

      const dadosM160 = leituras.map(l => l.dados.Dados);

      // Tensões (V)
      const Va = dadosM160.map(d => d.Va).filter(v => v != null);
      const Vb = dadosM160.map(d => d.Vb).filter(v => v != null);
      const Vc = dadosM160.map(d => d.Vc).filter(v => v != null);

      // Correntes (A)
      const Ia = dadosM160.map(d => d.Ia).filter(v => v != null);
      const Ib = dadosM160.map(d => d.Ib).filter(v => v != null);
      const Ic = dadosM160.map(d => d.Ic).filter(v => v != null);

      // Potências (W)
      const Pa = dadosM160.map(d => d.Pa).filter(v => v != null);
      const Pb = dadosM160.map(d => d.Pb).filter(v => v != null);
      const Pc = dadosM160.map(d => d.Pc).filter(v => v != null);

      // Fatores de Potência
      const FPA = dadosM160.map(d => d.FPA).filter(v => v != null);
      const FPB = dadosM160.map(d => d.FPB).filter(v => v != null);
      const FPC = dadosM160.map(d => d.FPC).filter(v => v != null);

      // Energia (kWh)
      const phf = dadosM160.map(d => d.phf).filter(v => v != null); // Energia ativa importada
      const phr = dadosM160.map(d => d.phr).filter(v => v != null); // Energia ativa exportada
      const qhfi = dadosM160.map(d => d.qhfi).filter(v => v != null); // Energia reativa indutiva
      const qhri = dadosM160.map(d => d.qhri).filter(v => v != null); // Energia reativa capacitiva

      // Frequência (Hz)
      const freq = dadosM160.map(d => d.freq).filter(v => v != null);

      agregado.Dados = {
        // Tensões (média)
        Va: Va.length > 0 ? parseFloat(this.mean(Va).toFixed(2)) : 0,
        Vb: Vb.length > 0 ? parseFloat(this.mean(Vb).toFixed(2)) : 0,
        Vc: Vc.length > 0 ? parseFloat(this.mean(Vc).toFixed(2)) : 0,

        // Correntes (média)
        Ia: Ia.length > 0 ? parseFloat(this.mean(Ia).toFixed(2)) : 0,
        Ib: Ib.length > 0 ? parseFloat(this.mean(Ib).toFixed(2)) : 0,
        Ic: Ic.length > 0 ? parseFloat(this.mean(Ic).toFixed(2)) : 0,

        // Potências (média)
        Pa: Pa.length > 0 ? parseFloat(this.mean(Pa).toFixed(2)) : 0,
        Pb: Pb.length > 0 ? parseFloat(this.mean(Pb).toFixed(2)) : 0,
        Pc: Pc.length > 0 ? parseFloat(this.mean(Pc).toFixed(2)) : 0,

        // Fatores de potência (média)
        FPA: FPA.length > 0 ? parseFloat(this.mean(FPA).toFixed(3)) : 0,
        FPB: FPB.length > 0 ? parseFloat(this.mean(FPB).toFixed(3)) : 0,
        FPC: FPC.length > 0 ? parseFloat(this.mean(FPC).toFixed(3)) : 0,

        // Energia (última leitura - são valores cumulativos)
        phf: ultimaLeitura.Dados.phf || 0,
        phr: ultimaLeitura.Dados.phr || 0,
        qhfi: ultimaLeitura.Dados.qhfi || 0,
        qhri: ultimaLeitura.Dados.qhri || 0,

        // Frequência (média)
        freq: freq.length > 0 ? parseFloat(this.mean(freq).toFixed(2)) : 0,

        // Timestamp (última leitura)
        timestamp: ultimaLeitura.Dados.timestamp,
      };

      // Calcular energia do período (kWh)
      const potenciaTotal = (agregado.Dados.Pa + agregado.Dados.Pb + agregado.Dados.Pc) / 1000; // kW
      const intervalo_horas =
        (leituras[leituras.length - 1].timestamp.getTime() - primeiraLeitura.timestamp.getTime()) / (1000 * 3600);
      agregado.Dados.period_energy_kwh = parseFloat((potenciaTotal * intervalo_horas).toFixed(4));

    } else if (isInversorData) {
      // ESTRUTURA DE INVERSOR - preservar nested objects

      // ========== POWER ==========
      if (ultimaLeitura.power) {
        agregado.power = {};

        // active_total
        const activeTotals = leituras.map(l => l.dados.power?.active_total).filter(v => v != null);
        if (activeTotals.length > 0) {
          agregado.power.active_total = Math.round(this.mean(activeTotals));
        }

        // reactive_total
        const reactiveTotals = leituras.map(l => l.dados.power?.reactive_total).filter(v => v != null);
        if (reactiveTotals.length > 0) {
          agregado.power.reactive_total = Math.round(this.mean(reactiveTotals));
        }

        // apparent_total
        const apparentTotals = leituras.map(l => l.dados.power?.apparent_total).filter(v => v != null);
        if (apparentTotals.length > 0) {
          agregado.power.apparent_total = Math.round(this.mean(apparentTotals));
        }

        // power_factor
        const powerFactors = leituras.map(l => l.dados.power?.power_factor).filter(v => v != null);
        if (powerFactors.length > 0) {
          agregado.power.power_factor = parseFloat(this.mean(powerFactors).toFixed(3));
        }

        // frequency
        const frequencies = leituras.map(l => l.dados.power?.frequency).filter(v => v != null);
        if (frequencies.length > 0) {
          agregado.power.frequency = parseFloat(this.mean(frequencies).toFixed(2));
        }
      }

      // ========== VOLTAGE ==========
      if (ultimaLeitura.voltage) {
        agregado.voltage = {};

        // phase_a-b
        const voltageAB = leituras.map(l => l.dados.voltage?.['phase_a-b']).filter(v => v != null);
        if (voltageAB.length > 0) {
          agregado.voltage['phase_a-b'] = parseFloat(this.mean(voltageAB).toFixed(1));
        }

        // phase_b-c
        const voltageBC = leituras.map(l => l.dados.voltage?.['phase_b-c']).filter(v => v != null);
        if (voltageBC.length > 0) {
          agregado.voltage['phase_b-c'] = parseFloat(this.mean(voltageBC).toFixed(1));
        }

        // phase_c-a
        const voltageCA = leituras.map(l => l.dados.voltage?.['phase_c-a']).filter(v => v != null);
        if (voltageCA.length > 0) {
          agregado.voltage['phase_c-a'] = parseFloat(this.mean(voltageCA).toFixed(1));
        }
      }

      // ========== CURRENT ==========
      if (ultimaLeitura.current) {
        agregado.current = {};

        // phase_a
        const currentA = leituras.map(l => l.dados.current?.phase_a).filter(v => v != null);
        if (currentA.length > 0) {
          agregado.current.phase_a = parseFloat(this.mean(currentA).toFixed(1));
        }

        // phase_b
        const currentB = leituras.map(l => l.dados.current?.phase_b).filter(v => v != null);
        if (currentB.length > 0) {
          agregado.current.phase_b = parseFloat(this.mean(currentB).toFixed(1));
        }

        // phase_c
        const currentC = leituras.map(l => l.dados.current?.phase_c).filter(v => v != null);
        if (currentC.length > 0) {
          agregado.current.phase_c = parseFloat(this.mean(currentC).toFixed(1));
        }
      }

      // ========== TEMPERATURE ==========
      if (ultimaLeitura.temperature) {
        agregado.temperature = {};

        const internalTemps = leituras.map(l => l.dados.temperature?.internal).filter(v => v != null);
        if (internalTemps.length > 0) {
          agregado.temperature.internal = parseFloat(this.mean(internalTemps).toFixed(1));
        }
      }

      // ========== DC (MPPT e Strings) ==========
      if (ultimaLeitura.dc) {
        agregado.dc = {};

        // total_power
        const dcTotalPowers = leituras.map(l => l.dados.dc?.total_power).filter(v => v != null);
        if (dcTotalPowers.length > 0) {
          agregado.dc.total_power = Math.round(this.mean(dcTotalPowers));
        }

        // MPPTs (mppt1_voltage, mppt2_voltage, etc.)
        const mpptKeys = Object.keys(ultimaLeitura.dc).filter(k => k.startsWith('mppt') && k.endsWith('_voltage'));
        for (const key of mpptKeys) {
          const values = leituras.map(l => l.dados.dc?.[key]).filter(v => v != null);
          if (values.length > 0) {
            agregado.dc[key] = parseFloat(this.mean(values).toFixed(1));
          }
        }

        // Strings (string1_current, string2_current, etc.)
        const stringKeys = Object.keys(ultimaLeitura.dc).filter(k => k.startsWith('string') && k.endsWith('_current'));
        for (const key of stringKeys) {
          const values = leituras.map(l => l.dados.dc?.[key]).filter(v => v != null);
          if (values.length > 0) {
            agregado.dc[key] = parseFloat(this.mean(values).toFixed(2));
          }
        }
      }

      // ========== ENERGY ==========
      if (ultimaLeitura.energy) {
        agregado.energy = {};

        // Para energia, usar valores da última leitura (são cumulativos)
        if (ultimaLeitura.energy.daily_yield != null) {
          agregado.energy.daily_yield = parseFloat(ultimaLeitura.energy.daily_yield.toFixed(2));
        }
        if (ultimaLeitura.energy.total_yield != null) {
          agregado.energy.total_yield = parseFloat(ultimaLeitura.energy.total_yield.toFixed(2));
        }
        if (ultimaLeitura.energy.total_running_time != null) {
          agregado.energy.total_running_time = ultimaLeitura.energy.total_running_time;
        }
        if (ultimaLeitura.energy.daily_running_time != null) {
          agregado.energy.daily_running_time = ultimaLeitura.energy.daily_running_time;
        }

        // Calcular energia gerada no período (kWh)
        // CORREÇÃO: Somar energia de cada leitura (potência × tempo), não fazer média!
        const activePowers = leituras.map(l => l.dados.power?.active_total).filter(v => v != null);
        if (activePowers.length > 0) {
          // Cada leitura representa 1 minuto de consumo
          // Energia = Soma de (Potência em W / 1000 / 60) para converter W·min para kWh
          const energiaTotal = activePowers.reduce((sum, power) => {
            return sum + (power / 1000 / 60); // W para kW, minutos para horas
          }, 0);
          agregado.energy.period_energy_kwh = parseFloat(energiaTotal.toFixed(4));

          // LOG compacto com tópico MQTT
          const potenciaMedia = Math.round(this.mean(activePowers));
          console.log(
            `✅ [INVERSOR] ${topicoMqtt || 'N/A'} | ` +
            `${energiaTotal.toFixed(4)}kWh | ` +
            `${potenciaMedia}W | ` +
            `${activePowers.length}x leituras`
          );
        }
      }

      // ========== PROTECTION ==========
      if (ultimaLeitura.protection) {
        agregado.protection = {};

        const insulationResistances = leituras.map(l => l.dados.protection?.insulation_resistance).filter(v => v != null);
        if (insulationResistances.length > 0) {
          agregado.protection.insulation_resistance = parseFloat(this.mean(insulationResistances).toFixed(1));
        }

        const busVoltages = leituras.map(l => l.dados.protection?.bus_voltage).filter(v => v != null);
        if (busVoltages.length > 0) {
          agregado.protection.bus_voltage = parseFloat(this.mean(busVoltages).toFixed(1));
        }
      }

      // ========== PID ==========
      if (ultimaLeitura.pid) {
        // PID é status, manter último valor
        agregado.pid = ultimaLeitura.pid;
      }

    } else {
      // ESTRUTURA SIMPLES/LEGADA - dados não aninhados
      // Fallback genérico: preserva última leitura inteira para tipos sem agregador
      // específico (ex: Gateway/A966). Garante que payloads de categorias novas
      // funcionem sem código novo. Agregados de power/voltage/etc abaixo sobrescrevem
      // quando os campos legados existirem.
      const { _qualidade, ...payloadFallback } = ultimaLeitura;
      Object.assign(agregado, payloadFallback);

      const potencias = leituras.map((l) => l.dados.power).filter((p) => p != null && p > 0);
      const tensoes = leituras.map((l) => l.dados.voltage || l.dados.v1).filter((v) => v != null);
      const correntes = leituras.map((l) => l.dados.current || l.dados.i1).filter((c) => c != null);
      const temperaturas = leituras.map((l) => l.dados.temperature || l.dados.temp).filter((t) => t != null);

      if (potencias.length > 0) {
        agregado.power_avg = this.mean(potencias);
        agregado.power_min = Math.min(...potencias);
        agregado.power_max = Math.max(...potencias);

        const intervalo_horas =
          (leituras[leituras.length - 1].timestamp.getTime() - primeiraLeitura.timestamp.getTime()) / (1000 * 3600);
        agregado.energia_kwh = agregado.power_avg * intervalo_horas;
      }

      if (tensoes.length > 0) {
        agregado.voltage_avg = this.mean(tensoes);
        agregado.voltage_min = Math.min(...tensoes);
        agregado.voltage_max = Math.max(...tensoes);
      }

      if (correntes.length > 0) {
        agregado.current_avg = this.mean(correntes);
        agregado.current_min = Math.min(...correntes);
        agregado.current_max = Math.max(...correntes);
      }

      if (temperaturas.length > 0) {
        agregado.temperature_avg = this.mean(temperaturas);
        agregado.temperature_min = Math.min(...temperaturas);
        agregado.temperature_max = Math.max(...temperaturas);
      }
    }

    return agregado;
  }

  /**
   * Calcula média de um array
   */
  private mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, val) => sum + val, 0) / values.length;
  }

  /**
   * Calcula desvio padrão
   */
  private standardDeviation(values: number[]): number {
    if (values.length === 0) return 0;
    const avg = this.mean(values);
    const squareDiffs = values.map((val) => Math.pow(val - avg, 2));
    const avgSquareDiff = this.mean(squareDiffs);
    return Math.sqrt(avgSquareDiff);
  }
}
