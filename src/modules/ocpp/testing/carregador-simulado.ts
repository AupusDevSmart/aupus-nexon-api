import { WebSocket } from 'ws';

/**
 * Carregador OCPP 1.6-J simulado (cliente WebSocket) para os testes e para ensaio manual
 * contra a API local (testing/simular.ts). Fala o protocolo de verdade: abre o WebSocket
 * com o subprotocolo `ocpp1.6`, manda CALLs e responde às CALLs da central.
 *
 * Por padrão aceita tudo que a central pede; `responder(ação, fn)` troca a resposta de uma
 * ação (`{ status: 'Rejected' }`, `ERRO('NotSupported')` para CALLERROR, `SILENCIO` para não
 * responder).
 */
export const SILENCIO = Symbol('silencio');
export const ERRO = (codigo: string, descricao = '') => ({ __erro: codigo, descricao });

type Resposta = Record<string, unknown> | typeof SILENCIO | ReturnType<typeof ERRO>;

export interface OpcoesSimulado {
  /** HTTP Basic no upgrade (perfil de segurança do OCPP 1.6). */
  basic?: { usuario: string; senha: string | Buffer };
  /** Subprotocolo oferecido; null = nenhum. Padrão `ocpp1.6`. */
  subprotocolo?: string | null;
}

export class CarregadorSimulado {
  private ws?: WebSocket;
  private seq = 0;
  private readonly pendentes = new Map<string, { resolver: (v: any) => void; rejeitar: (e: any) => void }>();
  private readonly respostas = new Map<string, (payload: any) => Resposta | Promise<Resposta>>();
  private readonly esperas: Array<{ acao: string; resolver: (p: any) => void }> = [];
  /** CALLs recebidas da central, na ordem. */
  readonly recebidas: Array<{ acao: string; payload: any; vista?: boolean }> = [];
  /** Preenchido quando a conexão fecha. */
  fechado: { codigo: number } | null = null;

  constructor(private readonly url: string, private readonly opcoes: OpcoesSimulado = {}) {
    const aceita = () => ({ status: 'Accepted' });
    for (const acao of ['RemoteStartTransaction', 'RemoteStopTransaction', 'Reset', 'ChangeAvailability', 'ChangeConfiguration',
      'SetChargingProfile', 'ClearChargingProfile', 'TriggerMessage']) this.respostas.set(acao, aceita);
    this.respostas.set('UnlockConnector', () => ({ status: 'Unlocked' }));
    this.respostas.set('GetConfiguration', () => ({
      configurationKey: [
        { key: 'SupportedFeatureProfiles', readonly: true, value: 'Core,SmartCharging,RemoteTrigger' },
        { key: 'MeterValueSampleInterval', readonly: false, value: '60' },
        { key: 'NumberOfConnectors', readonly: true, value: '1' },
      ],
    }));
  }

  responder(acao: string, fn: (payload: any) => Resposta | Promise<Resposta>): this {
    this.respostas.set(acao, fn);
    return this;
  }

  /** Abre a conexão. Recusa do servidor vira erro `HTTP <status>`. */
  conectar(): Promise<void> {
    return new Promise((resolver, rejeitar) => {
      const headers: Record<string, string> = {};
      if (this.opcoes.basic) {
        const senha = Buffer.isBuffer(this.opcoes.basic.senha) ? this.opcoes.basic.senha : Buffer.from(this.opcoes.basic.senha, 'utf8');
        headers.Authorization = `Basic ${Buffer.concat([Buffer.from(`${this.opcoes.basic.usuario}:`, 'utf8'), senha]).toString('base64')}`;
      }
      const sub = this.opcoes.subprotocolo === undefined ? 'ocpp1.6' : this.opcoes.subprotocolo;
      const ws = sub ? new WebSocket(this.url, sub, { headers }) : new WebSocket(this.url, { headers });
      this.ws = ws;
      ws.on('open', () => resolver());
      ws.on('unexpected-response', (_req, res) => rejeitar(new Error(`HTTP ${res.statusCode}`)));
      ws.on('error', (e) => rejeitar(e));
      ws.on('close', (codigo) => {
        this.fechado = { codigo };
        for (const p of this.pendentes.values()) p.rejeitar(new Error('conexão fechada'));
        this.pendentes.clear();
      });
      ws.on('message', (dado) => void this.aoReceber(dado.toString()));
    });
  }

  get conectado(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async fechar(): Promise<void> {
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((r) => {
      this.ws!.once('close', () => r());
      this.ws!.close();
    });
  }

  private async aoReceber(texto: string): Promise<void> {
    const f = JSON.parse(texto);
    if (f[0] === 3 || f[0] === 4) {
      const p = this.pendentes.get(f[1]);
      if (!p) return;
      this.pendentes.delete(f[1]);
      if (f[0] === 3) p.resolver(f[2]);
      else p.rejeitar({ codigo: f[2], descricao: f[3] });
      return;
    }
    const [, id, acao, payload] = f;
    const item = { acao, payload, vista: false };
    this.recebidas.push(item);
    const i = this.esperas.findIndex((e) => e.acao === acao);
    if (i >= 0) {
      item.vista = true;
      this.esperas.splice(i, 1)[0].resolver(payload);
    }
    const fn = this.respostas.get(acao);
    const r: Resposta = fn ? await fn(payload) : ERRO('NotImplemented');
    if (r === SILENCIO) return;
    if (r && typeof r === 'object' && '__erro' in r) this.ws!.send(JSON.stringify([4, id, (r as any).__erro, (r as any).descricao ?? '', {}]));
    else this.ws!.send(JSON.stringify([3, id, r]));
  }

  /** Próxima CALL da central com esta ação (já recebida e ainda não vista, ou a que chegar). */
  esperar(acao: string, prazoMs = 2000): Promise<any> {
    const ja = this.recebidas.find((r) => r.acao === acao && !r.vista);
    if (ja) {
      ja.vista = true;
      return Promise.resolve(ja.payload);
    }
    return new Promise((resolver, rejeitar) => {
      const espera = { acao, resolver: (p: any) => { clearTimeout(timer); resolver(p); } };
      const timer = setTimeout(() => {
        const i = this.esperas.indexOf(espera);
        if (i >= 0) this.esperas.splice(i, 1);
        rejeitar(new Error(`a central não mandou ${acao} em ${prazoMs} ms`));
      }, prazoMs);
      this.esperas.push(espera);
    });
  }

  /** Manda uma CALL e devolve o payload da resposta; CALLERROR rejeita com `{ codigo, descricao }`. */
  chamar(acao: string, payload: Record<string, unknown> = {}): Promise<any> {
    const id = `sim-${++this.seq}`;
    return new Promise((resolver, rejeitar) => {
      this.pendentes.set(id, { resolver, rejeitar });
      this.ws!.send(JSON.stringify([2, id, acao, payload]));
    });
  }

  /** Manda texto cru (quadros malformados nos testes de protocolo). */
  cru(texto: string): void {
    this.ws!.send(texto);
  }

  // ---- roteiros de um carregador real ---------------------------------------
  boot(extra: Record<string, unknown> = {}) {
    return this.chamar('BootNotification', {
      chargePointVendor: 'CHINT', chargePointModel: 'NTW-EC2A22W1-L', chargePointSerialNumber: '20260703000025', firmwareVersion: '1.0.0', ...extra,
    });
  }

  status(status: string, extra: Record<string, unknown> = {}) {
    return this.chamar('StatusNotification', { connectorId: 1, errorCode: 'NoError', status, timestamp: new Date().toISOString(), ...extra });
  }

  async autorizar(idTag: string): Promise<string> {
    return (await this.chamar('Authorize', { idTag })).idTagInfo.status;
  }

  /** StartTransaction → `{ transactionId, status }` (status da autorização da tag). */
  async iniciar(idTag: string, meterStartWh: number, quando: Date = new Date()): Promise<{ transactionId: number; status: string }> {
    const r = await this.chamar('StartTransaction', { connectorId: 1, idTag, meterStart: meterStartWh, timestamp: quando.toISOString() });
    return { transactionId: r.transactionId, status: r.idTagInfo.status };
  }

  /** MeterValues de uma amostra: registrador de energia (Wh) e, se dados, potência, corrente, tensão e temperatura. */
  medir(transactionId: number | null, m: { energiaWh: number; potenciaW?: number; correnteA?: number; tensaoV?: number; temperaturaC?: number; soc?: number }, quando: Date = new Date()) {
    const sampledValue: Array<Record<string, string>> = [{ value: String(m.energiaWh), measurand: 'Energy.Active.Import.Register', unit: 'Wh' }];
    if (m.potenciaW !== undefined) sampledValue.push({ value: String(m.potenciaW), measurand: 'Power.Active.Import', unit: 'W' });
    if (m.correnteA !== undefined) sampledValue.push({ value: String(m.correnteA), measurand: 'Current.Import', unit: 'A' });
    if (m.tensaoV !== undefined) sampledValue.push({ value: String(m.tensaoV), measurand: 'Voltage', unit: 'V' });
    if (m.temperaturaC !== undefined) sampledValue.push({ value: String(m.temperaturaC), measurand: 'Temperature', unit: 'Celsius' });
    if (m.soc !== undefined) sampledValue.push({ value: String(m.soc), measurand: 'SoC', unit: 'Percent' });
    return this.chamar('MeterValues', {
      connectorId: 1, ...(transactionId === null ? {} : { transactionId }),
      meterValue: [{ timestamp: quando.toISOString(), sampledValue }],
    });
  }

  parar(transactionId: number, meterStopWh: number, reason = 'Local', quando: Date = new Date()) {
    return this.chamar('StopTransaction', { transactionId, meterStop: meterStopWh, timestamp: quando.toISOString(), reason });
  }
}
