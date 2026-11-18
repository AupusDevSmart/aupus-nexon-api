import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { randomUUID } from 'crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { decidirConexao, EstacaoOcpp, normalizarIdentidade, respostaRecusa } from './ocpp-conexao';
import {
  Chamada,
  ErroPayload,
  IdTagInfo,
  lerMedicoes,
  lerQuadro,
  Medicao,
  montarCall,
  montarErro,
  montarResultado,
  SUBPROTOCOLO,
  validarEntrada,
} from './ocpp-protocolo';
import { OcppRepositorio } from './ocpp.repositorio';

/** Por que uma chamada ao carregador não deu certo. */
export class ErroOcpp extends Error {
  constructor(
    readonly tipo: 'offline' | 'timeout' | 'erro_carregador',
    mensagem: string,
    /** Código do CALLERROR (NotSupported, NotImplemented...), quando o carregador respondeu erro. */
    readonly codigo?: string,
  ) {
    super(mensagem);
  }
}

/**
 * Quem recebe o que o carregador diz (o módulo do carregador registra um ouvinte).
 * Tudo aqui roda ANTES da resposta ao carregador: nada de esperar uma chamada de volta
 * a ele dentro do ouvinte (use uma tarefa depois).
 */
export interface OuvinteOcpp {
  aoConectar?(e: EstacaoOcpp): Promise<void> | void;
  aoDesconectar?(e: EstacaoOcpp): Promise<void> | void;
  aoBoot?(e: EstacaoOcpp, p: { vendor: string; model: string; serial: string | null; firmware: string | null }): Promise<void> | void;
  aoStatus?(e: EstacaoOcpp, p: { connectorId: number; status: string; errorCode: string; vendorErrorCode: string | null; info: string | null; quando: Date }): Promise<void> | void;
  autorizar?(e: EstacaoOcpp, idTag: string): Promise<IdTagInfo>;
  aoIniciar?(e: EstacaoOcpp, p: { transactionId: number; connectorId: number; idTag: string; meterStartWh: number; quando: Date; autorizacao: IdTagInfo; repetida: boolean }): Promise<void> | void;
  aoMedicoes?(e: EstacaoOcpp, p: { transactionId: number | null; connectorId: number; medicoes: Array<Medicao & { quando: Date }> }): Promise<void> | void;
  aoParar?(e: EstacaoOcpp, p: { transactionId: number; meterStopWh: number; quando: Date; motivo: string; repetida: boolean; conhecida: boolean }): Promise<void> | void;
}

interface Conexao {
  estacao: EstacaoOcpp;
  ws: WebSocket;
  ip: string | null;
  desde: number;
  ultimoTrafego: number;
  /** Mensagens do carregador, uma de cada vez e na ordem em que chegaram. */
  entrada: Promise<void>;
  /** Chamadas ao carregador, uma de cada vez (o OCPP-J só admite uma pendente). */
  saida: Promise<unknown>;
  pendente: { id: string; resolver: (v: Record<string, any>) => void; rejeitar: (e: Error) => void } | null;
}

export interface TentativaRecusada { quando: string; identidade: string; motivo: string; ip: string | null }

const HEARTBEAT_S = 240; // < proxy_read_timeout 300 s do nginx
const PING_MS = 50_000;
const SEM_TRAFEGO_MS = 10 * 60_000;
const RECARGA_CADASTRO_MS = 60_000;

/**
 * Central OCPP 1.6-J (Central System). Servidor WebSocket em `/ocpp/...` (subprotocolo
 * `ocpp1.6`) preso ao MESMO servidor HTTP do Nest: coexiste com o socket.io de
 * `/ws/diagramas` porque só trata o caminho `/ocpp/`.
 *
 * Só conecta carregador cadastrado e com a chave (ocpp-conexao.ts). A decisão sai do
 * cadastro em memória, sem ir ao banco: o engine.io derruba em 1 s o upgrade que ninguém
 * respondeu. Este serviço cuida de conexão, quadros, fila e do registro bruto
 * (`ocpp_*`); o que cada mensagem significa para a recarga está no ouvinte
 * (carregador-eletrico/carregador-ocpp.service.ts).
 */
@Injectable()
export class OcppService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('OCPP');
  private wss?: WebSocketServer;
  private readonly conexoes = new Map<string, Conexao>(); // identidade normalizada → conexão
  private estacoes: EstacaoOcpp[] = [];
  private cadastroCarregado = false;
  private ouvinte: OuvinteOcpp = {};
  private readonly recusadas: TentativaRecusada[] = [];
  private timers: NodeJS.Timeout[] = [];
  /** Prazo da resposta do carregador a uma chamada (os testes encurtam). */
  timeoutMs = 30_000;

  constructor(
    private readonly repo: OcppRepositorio,
    private readonly httpHost: HttpAdapterHost,
  ) {}

  registrarOuvinte(o: OuvinteOcpp): void {
    this.ouvinte = o;
  }

  async onApplicationBootstrap(): Promise<void> {
    const server: any = this.httpHost?.httpAdapter?.getHttpServer?.();
    if (!server) {
      this.logger.error('Servidor HTTP indisponível: central OCPP NÃO anexada.');
      return;
    }
    this.wss = new WebSocketServer({
      noServer: true,
      // StopTransaction com as leituras da recarga inteira cabe com folga; nada legítimo passa disso.
      maxPayload: 1024 * 1024,
      handleProtocols: (protocolos: Set<string>) => (protocolos.has(SUBPROTOCOLO) ? SUBPROTOCOLO : false),
    });
    server.on('upgrade', (req: any, socket: any, head: any) => this.aoUpgrade(req, socket, head));
    await this.repo.marcarTodasDesconectadas().catch((e) => this.logger.warn(`marcar desconectadas: ${e?.message}`));
    await this.recarregarCadastro();
    const t1 = setInterval(() => void this.recarregarCadastro(), RECARGA_CADASTRO_MS);
    const t2 = setInterval(() => this.manterVivas(), PING_MS);
    t1.unref();
    t2.unref();
    this.timers = [t1, t2];
    this.logger.log(`Central OCPP 1.6-J em wss://<host>/ocpp/ (${this.estacoes.length} carregador(es) cadastrado(s))`);
  }

  onModuleDestroy(): void {
    this.timers.forEach((t) => clearInterval(t));
    for (const c of this.conexoes.values()) {
      try { c.ws.terminate(); } catch { /* já fechado */ }
    }
    this.conexoes.clear();
    this.wss?.close();
  }

  /** Relê o cadastro do banco. Chamar depois de vincular, trocar a chave ou desvincular. */
  async recarregarCadastro(): Promise<void> {
    try {
      this.estacoes = await this.repo.listarEstacoes();
      this.cadastroCarregado = true;
    } catch (e: any) {
      this.logger.warn(`cadastro de carregadores não lido: ${e?.message}`);
    }
  }

  // ---- entrada do carregador -------------------------------------------------
  private aoUpgrade(req: any, socket: any, head: any): void {
    const url: string = req.url || '';
    if (!url.startsWith('/ocpp/')) return; // outro caminho: socket.io e os demais cuidam
    const ip = this.ipDe(req);
    const recusar = (http: number, motivo: string, identidade: string) => {
      this.anotarRecusa(identidade, motivo, ip);
      try {
        socket.write(respostaRecusa(http));
        socket.destroy();
      } catch { /* socket já foi */ }
    };
    if (!this.cadastroCarregado) return recusar(503, 'Cadastro de carregadores indisponível', '');
    const d = decidirConexao(
      { url, authorization: req.headers?.authorization, protocolos: req.headers?.['sec-websocket-protocol'] },
      this.estacoes,
    );
    if (d.ok === false) return recusar(d.http, d.motivo, d.identidade);
    this.wss!.handleUpgrade(req, socket, head, (ws) => this.aoConectar(d.estacao, ws, ip));
  }

  private ipDe(req: any): string | null {
    const socketIp: string = req.socket?.remoteAddress || '';
    const local = /^(::1|127\.|::ffff:127\.)/.test(socketIp);
    const real = req.headers?.['x-real-ip'];
    const ip = local && typeof real === 'string' && real ? real : socketIp;
    return ip ? ip.replace(/^::ffff:/, '').slice(0, 64) : null;
  }

  /** Guarda as últimas recusas (memória) para a tela de conexão; no log, uma linha por minuto por identidade. */
  private readonly ultimoAviso = new Map<string, number>();
  private anotarRecusa(identidade: string, motivo: string, ip: string | null): void {
    this.recusadas.unshift({ quando: new Date().toISOString(), identidade: identidade.slice(0, 64), motivo, ip });
    this.recusadas.length = Math.min(this.recusadas.length, 30);
    const k = `${identidade}|${motivo}`;
    const agora = Date.now();
    if (agora - (this.ultimoAviso.get(k) ?? 0) > 60_000) {
      this.ultimoAviso.set(k, agora);
      if (this.ultimoAviso.size > 200) this.ultimoAviso.clear();
      this.logger.warn(`conexão recusada [${identidade || '?'}] ${motivo} (ip ${ip ?? '?'})`);
    }
  }

  tentativasRecusadas(): TentativaRecusada[] {
    return [...this.recusadas];
  }

  private aoConectar(estacao: EstacaoOcpp, ws: WebSocket, ip: string | null): void {
    const chave = normalizarIdentidade(estacao.chargePointId);
    const anterior = this.conexoes.get(chave);
    const con: Conexao = {
      estacao, ws, ip, desde: Date.now(), ultimoTrafego: Date.now(),
      entrada: Promise.resolve(), saida: Promise.resolve(), pendente: null,
    };
    this.conexoes.set(chave, con);
    // Ouvintes ANTES de qualquer await: o BootNotification chega logo após o 101.
    ws.on('message', (dado) => this.aoReceber(con, dado.toString()));
    ws.on('pong', () => { con.ultimoTrafego = Date.now(); });
    ws.on('error', (e: any) => this.logger.warn(`[${estacao.chargePointId}] erro no socket: ${e?.message || e}`));
    ws.on('close', () => this.aoFechar(con));
    if (anterior) {
      // O carregador reconectou sem fechar a conexão velha (queda de rede): vale a nova.
      try { anterior.ws.terminate(); } catch { /* */ }
    }
    this.logger.log(`[${estacao.chargePointId}] conectado (ip ${ip ?? '?'})`);
    con.entrada = con.entrada
      .then(() => this.repo.conectou(estacao.id, ip))
      .then(() => this.ouvinte.aoConectar?.(estacao))
      .catch((e) => this.logger.warn(`[${estacao.chargePointId}] ao conectar: ${e?.message || e}`));
  }

  private aoFechar(con: Conexao): void {
    const chave = normalizarIdentidade(con.estacao.chargePointId);
    con.pendente?.rejeitar(new ErroOcpp('offline', 'O carregador desconectou antes de responder.'));
    con.pendente = null;
    if (this.conexoes.get(chave) !== con) return; // já havia uma conexão nova no lugar
    this.conexoes.delete(chave);
    this.logger.log(`[${con.estacao.chargePointId}] desconectado`);
    void this.repo.desconectou(con.estacao.id)
      .then(() => this.ouvinte.aoDesconectar?.(con.estacao))
      .catch((e) => this.logger.warn(`[${con.estacao.chargePointId}] ao desconectar: ${e?.message || e}`));
  }

  private manterVivas(): void {
    const agora = Date.now();
    for (const con of this.conexoes.values()) {
      if (agora - con.ultimoTrafego > SEM_TRAFEGO_MS) {
        this.logger.warn(`[${con.estacao.chargePointId}] sem tráfego há 10 min: conexão encerrada`);
        try { con.ws.terminate(); } catch { /* */ }
        continue;
      }
      try { con.ws.ping(); } catch { /* fecha sozinho */ }
    }
  }

  private aoReceber(con: Conexao, texto: string): void {
    con.ultimoTrafego = Date.now();
    const q = lerQuadro(texto);
    const cp = con.estacao.chargePointId;
    if (q.tipo === 'resultado' || q.tipo === 'erro') {
      // Resposta a uma chamada nossa: resolve na hora, fora da fila de entrada (quem
      // espera a resposta pode estar dentro dela).
      const p = con.pendente;
      if (!p || p.id !== q.id) return;
      con.pendente = null;
      if (q.tipo === 'resultado') p.resolver(q.payload as Record<string, any>);
      else p.rejeitar(new ErroOcpp('erro_carregador', `${q.codigo}${q.descricao ? `: ${q.descricao}` : ''}`, q.codigo));
      return;
    }
    if (q.tipo === 'invalido') {
      this.logger.warn(`[${cp}] quadro inválido: ${q.descricao}`);
      if (q.id) this.enviar(con, montarErro(q.id, q.codigo, q.descricao));
      return;
    }
    con.entrada = con.entrada.then(async () => {
      try {
        const resposta = await this.tratar(con.estacao, q.acao, q.payload);
        this.enviar(con, montarResultado(q.id, resposta));
      } catch (e: any) {
        if (e instanceof ErroPayload) {
          this.logger.warn(`[${cp}] ${q.acao} recusada: ${e.codigo} ${e.message}`);
          this.enviar(con, montarErro(q.id, e.codigo, e.message));
        } else {
          this.logger.error(`[${cp}] ${q.acao} falhou: ${e?.message || e}`);
          this.enviar(con, montarErro(q.id, 'InternalError', 'Erro interno da central'));
        }
      }
    });
  }

  private enviar(con: Conexao, quadro: string): void {
    if (con.ws.readyState !== WebSocket.OPEN) return;
    con.ws.send(quadro, (err) => {
      if (err) this.logger.warn(`[${con.estacao.chargePointId}] envio falhou: ${err.message}`);
    });
  }

  /** Hora do carregador, se plausível (não no futuro; até 30 dias atrás, para o que ficou na fila offline). */
  private quando(d: Date | null): Date {
    const agora = Date.now();
    if (!d) return new Date(agora);
    const t = d.getTime();
    return t > agora + 10 * 60_000 || t < agora - 30 * 86_400_000 ? new Date(agora) : d;
  }

  // ---- mensagens do carregador (perfil Core) ---------------------------------
  private async tratar(e: EstacaoOcpp, acao: string, bruto: Record<string, unknown>): Promise<Record<string, unknown>> {
    const p = validarEntrada(acao, bruto);
    const cp = e.chargePointId;
    switch (acao) {
      case 'BootNotification': {
        const dados = {
          vendor: p.chargePointVendor, model: p.chargePointModel,
          serial: p.chargePointSerialNumber ?? p.chargeBoxSerialNumber ?? null, firmware: p.firmwareVersion ?? null,
        };
        await this.repo.boot(e.id, dados);
        await this.ouvinte.aoBoot?.(e, dados);
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: HEARTBEAT_S };
      }
      case 'Heartbeat':
        await this.repo.heartbeat(e.id);
        return { currentTime: new Date().toISOString() };
      case 'StatusNotification':
        await this.ouvinte.aoStatus?.(e, {
          connectorId: p.connectorId, status: p.status, errorCode: p.errorCode,
          vendorErrorCode: p.vendorErrorCode ?? null, info: p.info ?? null, quando: this.quando(p.timestamp),
        });
        return {};
      case 'Authorize':
        return { idTagInfo: await this.autorizar(e, p.idTag) };
      case 'StartTransaction': {
        const quando = this.quando(p.timestamp);
        const autorizacao = await this.autorizar(e, p.idTag);
        let txId = await this.repo.transacaoIgual(cp, p.connectorId, p.idTag, p.meterStart, quando);
        const repetida = txId !== null;
        if (txId === null) {
          txId = await this.repo.novaTransacao({ cp, connectorId: p.connectorId, idTag: p.idTag, moradorId: null, meterStartWh: p.meterStart, inicio: quando });
        }
        this.logger.log(`[${cp}] StartTransaction #${txId} (${autorizacao.status})${repetida ? ' repetida' : ''}`);
        await this.ouvinte.aoIniciar?.(e, {
          transactionId: txId, connectorId: p.connectorId, idTag: p.idTag, meterStartWh: p.meterStart, quando, autorizacao, repetida,
        });
        return { transactionId: txId, idTagInfo: autorizacao };
      }
      case 'StopTransaction': {
        const quando = this.quando(p.timestamp);
        const tx = await this.repo.transacao(cp, p.transactionId);
        const motivo = p.reason || 'Local';
        if (tx && tx.status !== 'encerrada') await this.repo.encerrarTransacao(cp, p.transactionId, { meterStopWh: p.meterStop, fim: quando, motivo });
        this.logger.log(`[${cp}] StopTransaction #${p.transactionId} (${motivo})${tx ? '' : ' desconhecida'}`);
        await this.ouvinte.aoParar?.(e, {
          transactionId: p.transactionId, meterStopWh: p.meterStop, quando, motivo,
          repetida: tx?.status === 'encerrada', conhecida: !!tx,
        });
        return { idTagInfo: { status: 'Accepted' } };
      }
      case 'MeterValues': {
        const medicoes = lerMedicoes(p.meterValue).map((m) => ({ ...m, quando: this.quando(m.ts) }));
        const txId: number | null = p.transactionId ?? null;
        const brutos = Array.isArray(p.meterValue) ? p.meterValue : [];
        for (let i = 0; i < medicoes.length; i++) {
          await this.repo.gravarMedicao({ cp, transactionId: txId, connectorId: p.connectorId, ts: medicoes[i].quando, m: medicoes[i], raw: brutos[i] });
        }
        await this.ouvinte.aoMedicoes?.(e, { transactionId: txId, connectorId: p.connectorId, medicoes });
        return {};
      }
      case 'DataTransfer':
        // Mensagem do fabricante: o manual não documenta nenhuma, então nenhuma é aceita.
        return { status: 'UnknownVendorId' };
      default:
        // FirmwareStatusNotification, DiagnosticsStatusNotification: só confirma o recebimento.
        return {};
    }
  }

  private async autorizar(e: EstacaoOcpp, idTag: string): Promise<IdTagInfo> {
    if (!this.ouvinte.autorizar) return { status: 'Invalid' };
    try {
      return await this.ouvinte.autorizar(e, idTag);
    } catch (err: any) {
      this.logger.warn(`[${e.chargePointId}] autorização falhou: ${err?.message || err}`);
      return { status: 'Invalid' };
    }
  }

  // ---- chamadas ao carregador -------------------------------------------------
  /**
   * Manda uma chamada ao carregador e espera a resposta. Uma de cada vez por carregador.
   * Lança `ErroOcpp`: `offline` (não conectado), `timeout` (não respondeu) ou
   * `erro_carregador` (respondeu CALLERROR, por exemplo NotSupported).
   */
  chamar(chargePointId: string, c: Chamada): Promise<Record<string, any>> {
    const con = this.conexoes.get(normalizarIdentidade(chargePointId));
    if (!con || con.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new ErroOcpp('offline', 'Carregador sem comunicação.'));
    }
    const executar = () =>
      new Promise<Record<string, any>>((resolver, rejeitar) => {
        if (con.ws.readyState !== WebSocket.OPEN) return rejeitar(new ErroOcpp('offline', 'Carregador sem comunicação.'));
        const id = randomUUID();
        const timer = setTimeout(() => {
          if (con.pendente?.id === id) con.pendente = null;
          rejeitar(new ErroOcpp('timeout', `O carregador não respondeu (${c.acao}).`));
        }, this.timeoutMs);
        con.pendente = {
          id,
          resolver: (v) => { clearTimeout(timer); resolver(v); },
          rejeitar: (err) => { clearTimeout(timer); rejeitar(err); },
        };
        con.ws.send(montarCall(id, c.acao, c.payload), (err) => {
          if (!err || con.pendente?.id !== id) return;
          con.pendente.rejeitar(new ErroOcpp('offline', 'Falha ao enviar para o carregador.'));
          con.pendente = null;
        });
      });
    const p = con.saida.then(executar, executar);
    con.saida = p.catch(() => undefined);
    return p;
  }

  conectado(chargePointId: string): boolean {
    return this.conexoes.get(normalizarIdentidade(chargePointId))?.ws.readyState === WebSocket.OPEN;
  }

  conectados(): string[] {
    return [...this.conexoes.values()].filter((c) => c.ws.readyState === WebSocket.OPEN).map((c) => c.estacao.chargePointId);
  }

  /** Fecha a conexão do carregador (chave trocada, vínculo desfeito). Ele reconecta sozinho se ainda puder. */
  derrubar(chargePointId: string): void {
    const con = this.conexoes.get(normalizarIdentidade(chargePointId));
    if (!con) return;
    try { con.ws.close(1000, 'Cadastro alterado'); } catch { /* */ }
  }

  /** Espera a fila de entrada de um carregador esvaziar (testes e desligamento). */
  async entradaOciosa(chargePointId: string): Promise<void> {
    await this.conexoes.get(normalizarIdentidade(chargePointId))?.entrada;
  }
}
