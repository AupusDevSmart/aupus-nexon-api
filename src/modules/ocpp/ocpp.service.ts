import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { PrismaService } from '@/core';
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes } from 'crypto';

/**
 * CSMS OCPP 1.6-J (Central System) — MVP perfil Core.
 *
 * Servidor WebSocket em `/ocpp/:chargePointId` (subprotocolo `ocpp1.6`), anexado ao
 * mesmo HTTP server do Nest (coexiste com o socket.io de `/ws/diagramas` — filtramos por path).
 * Qualquer carregador OCPP 1.6 comercial conecta aqui. Nossa lógica de condomínio
 * (moradores/whitelist, R$/mês) fica POR CIMA das transações.
 *
 * Framing OCPP-J: mensagem = array JSON `[MessageTypeId, UniqueId, ...]`
 *   CALL=2 [2, uid, action, payload] · CALLRESULT=3 [3, uid, payload] · CALLERROR=4 [4, uid, code, desc, details]
 *
 * ⚠️ MVP: sem auth (Basic/TLS) na conexão nem smart charging — ver roadmap. Aceita e
 * auto-registra qualquer chargePointId (como o auto-discovery da TON).
 */
@Injectable()
export class OcppService implements OnApplicationBootstrap {
  private readonly logger = new Logger('OCPP');
  private wss?: WebSocketServer;
  private readonly clients = new Map<string, WebSocket>(); // chargePointId -> socket
  private readonly pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void; timer: NodeJS.Timeout }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpHost: HttpAdapterHost,
  ) {}

  onApplicationBootstrap() {
    const server: any = this.httpHost?.httpAdapter?.getHttpServer?.();
    if (!server) {
      this.logger.error('HTTP server indisponível — CSMS OCPP NÃO anexado.');
      return;
    }
    this.wss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols: Set<string>) => (protocols.has('ocpp1.6') ? 'ocpp1.6' : false),
    });
    server.on('upgrade', (req: any, socket: any, head: any) => {
      const url: string = req.url || '';
      if (!url.startsWith('/ocpp/')) return; // não é OCPP → deixa socket.io / outros tratarem
      const cpId = decodeURIComponent(url.slice('/ocpp/'.length).split('?')[0].replace(/\/+$/, ''));
      if (!cpId) { try { socket.destroy(); } catch { /* */ } return; }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.onConnect(cpId, ws));
    });
    this.logger.log('CSMS OCPP 1.6-J escutando em ws(s)://<host>/ocpp/:chargePointId');
  }

  // ---- conexão -------------------------------------------------------------
  private onConnect(cpId: string, ws: WebSocket) {
    this.clients.set(cpId, ws);
    // Listeners ANTES de qualquer await — senão o BootNotification chega antes do
    // handler de 'message' e se perde (a mensagem não fica em buffer).
    ws.on('message', (data) => this.onMessage(cpId, ws, data));
    ws.on('close', () => {
      if (this.clients.get(cpId) === ws) this.clients.delete(cpId);
      this.upsertCp(cpId, { conectado: false }).catch(() => {});
      this.logger.log(`[${cpId}] desconectado`);
    });
    ws.on('error', (e: any) => this.logger.warn(`[${cpId}] erro ws: ${e?.message || e}`));
    this.logger.log(`[${cpId}] conectado (proto=${(ws as any).protocol || '—'})`);
    this.upsertCp(cpId, { conectado: true }).catch(() => {});
  }

  private async onMessage(cpId: string, ws: WebSocket, data: any) {
    let frame: any;
    try { frame = JSON.parse(data.toString()); } catch { return; }
    if (!Array.isArray(frame) || frame.length < 2) return;
    const [type, uniqueId] = frame;

    if (type === 2) {
      const action = frame[2];
      const payload = frame[3] || {};
      try {
        const result = await this.handleCall(cpId, action, payload);
        ws.send(JSON.stringify([3, uniqueId, result ?? {}]));
      } catch (e: any) {
        this.logger.warn(`[${cpId}] ${action} erro: ${e?.message || e}`);
        ws.send(JSON.stringify([4, uniqueId, 'InternalError', String(e?.message || e).slice(0, 200), {}]));
      }
    } else if (type === 3) {
      const p = this.pending.get(uniqueId);
      if (p) { clearTimeout(p.timer); this.pending.delete(uniqueId); p.resolve(frame[2]); }
    } else if (type === 4) {
      const p = this.pending.get(uniqueId);
      if (p) { clearTimeout(p.timer); this.pending.delete(uniqueId); p.reject(new Error(`${frame[2]}: ${frame[3]}`)); }
    }
  }

  // ---- handlers inbound (perfil Core) --------------------------------------
  private async handleCall(cpId: string, action: string, p: any): Promise<any> {
    switch (action) {
      case 'BootNotification':
        await this.upsertCp(cpId, {
          vendor: p.chargePointVendor, model: p.chargePointModel,
          firmware_version: p.firmwareVersion, serial_number: p.chargePointSerialNumber || p.chargeBoxSerialNumber,
          ultimo_boot: new Date(), conectado: true,
        });
        // interval 240s (heartbeat) < proxy_read_timeout 300s do nginx → conexão não expira ociosa.
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 240 };
      case 'Heartbeat':
        await this.upsertCp(cpId, { ultimo_heartbeat: new Date() });
        return { currentTime: new Date().toISOString() };
      case 'StatusNotification':
        await this.upsertCp(cpId, { status: p.status });
        return {};
      case 'Authorize':
        return { idTagInfo: await this.authorize(cpId, p.idTag) };
      case 'StartTransaction':
        return this.onStart(cpId, p);
      case 'StopTransaction':
        return this.onStop(cpId, p);
      case 'MeterValues':
        await this.onMeterValues(cpId, p);
        return {};
      case 'DataTransfer':
        return { status: 'Rejected' };
      case 'FirmwareStatusNotification':
      case 'DiagnosticsStatusNotification':
        return {};
      default:
        this.logger.warn(`[${cpId}] ação não tratada: ${action}`);
        return {};
    }
  }

  /** Autoriza a tag contra o whitelist de moradores (tag_uid). Escopa pela planta do CP se houver. */
  private async authorize(cpId: string, idTag?: string): Promise<{ status: string; expiryDate?: string }> {
    const tag = String(idTag || '').trim().toUpperCase();
    if (!tag) return { status: 'Invalid' };
    try {
      const rows = await this.prisma.$queryRaw<Array<{ id: string; ativo: boolean }>>`
        SELECT TRIM(m.id) AS id, m.ativo
        FROM moradores m
        WHERE UPPER(TRIM(m.tag_uid)) = ${tag} AND m.deleted_at IS NULL
          AND (${cpId} NOT IN (SELECT charge_point_id FROM ocpp_charge_points WHERE planta_id IS NOT NULL)
               OR TRIM(m.planta_id) = (SELECT TRIM(planta_id) FROM ocpp_charge_points WHERE charge_point_id = ${cpId}))
        LIMIT 1
      `;
      const m = rows?.[0];
      if (!m) return { status: 'Invalid' };
      return { status: m.ativo ? 'Accepted' : 'Blocked' };
    } catch (e: any) {
      this.logger.warn(`[${cpId}] authorize falhou: ${e?.message}`);
      return { status: 'Invalid' };
    }
  }

  private async onStart(cpId: string, p: any) {
    const idTag = String(p.idTag || '').trim();
    const idTagInfo = await this.authorize(cpId, idTag);
    const seq = await this.prisma.$queryRaw<Array<{ nextval: bigint }>>`SELECT nextval('ocpp_transaction_seq') AS nextval`;
    const txId = Number(seq?.[0]?.nextval ?? Date.now());
    const morador = await this.resolveMorador(cpId, idTag);
    const inicio = p.timestamp ? new Date(p.timestamp) : new Date();
    await this.prisma.$executeRaw`
      INSERT INTO ocpp_transactions (id, transaction_id, charge_point_id, connector_id, id_tag, morador_id, meter_start, inicio, status, created_at, updated_at)
      VALUES (${this.novoId()}, ${txId}, ${cpId}, ${this.intOrNull(p.connectorId)}, ${idTag || null}, ${morador}, ${this.intOrNull(p.meterStart)}, ${inicio}, 'ativa', now(), now())
    `;
    this.logger.log(`[${cpId}] StartTransaction #${txId} tag=${idTag} (${idTagInfo.status})`);
    return { transactionId: txId, idTagInfo };
  }

  private async onStop(cpId: string, p: any) {
    const txId = Number(p.transactionId);
    const fim = p.timestamp ? new Date(p.timestamp) : new Date();
    const stop = this.intOrNull(p.meterStop);
    await this.prisma.$executeRaw`
      UPDATE ocpp_transactions
      SET meter_stop = ${stop},
          energia_kwh = CASE WHEN meter_start IS NOT NULL AND ${stop}::int IS NOT NULL
                             THEN GREATEST(${stop}::int - meter_start, 0) / 1000.0 ELSE energia_kwh END,
          fim = ${fim}, motivo_fim = ${String(p.reason || 'Local').slice(0, 32)}, status = 'encerrada', updated_at = now()
      WHERE transaction_id = ${txId}
    `;
    this.logger.log(`[${cpId}] StopTransaction #${txId} (${p.reason || 'Local'})`);
    return { idTagInfo: { status: 'Accepted' } };
  }

  private async onMeterValues(cpId: string, p: any) {
    const txId = this.intOrNull(p.transactionId);
    const connectorId = this.intOrNull(p.connectorId);
    for (const mv of p.meterValue || []) {
      const ts = mv.timestamp ? new Date(mv.timestamp) : new Date();
      let energia: number | null = null, potencia: number | null = null;
      for (const sv of mv.sampledValue || []) {
        const val = Number(sv.value);
        if (!Number.isFinite(val)) continue;
        const measurand = sv.measurand || 'Energy.Active.Import.Register';
        if (measurand === 'Energy.Active.Import.Register') energia = sv.unit === 'kWh' ? val * 1000 : val;
        else if (measurand === 'Power.Active.Import') potencia = sv.unit === 'kW' ? val * 1000 : val;
      }
      await this.prisma.$executeRaw`
        INSERT INTO ocpp_meter_values (id, transaction_id, charge_point_id, connector_id, ts, energia_wh, potencia_w, raw, created_at)
        VALUES (${this.novoId()}, ${txId}, ${cpId}, ${connectorId}, ${ts}, ${energia}, ${potencia}, ${JSON.stringify(mv)}::jsonb, now())
      `;
    }
  }

  // ---- calls de SAÍDA (CSMS → carregador) ----------------------------------
  private sendCall(cpId: string, action: string, payload: any): Promise<any> {
    const ws = this.clients.get(cpId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Carregador não conectado.'));
    }
    const uid = randomBytes(8).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(uid); reject(new Error('Timeout aguardando resposta do carregador.')); }, 30000);
      this.pending.set(uid, { resolve, reject, timer });
      ws.send(JSON.stringify([2, uid, action, payload]));
    });
  }

  remoteStart(cpId: string, idTag: string, connectorId?: number) {
    return this.sendCall(cpId, 'RemoteStartTransaction', { idTag, ...(connectorId ? { connectorId } : {}) });
  }
  remoteStop(cpId: string, transactionId: number) {
    return this.sendCall(cpId, 'RemoteStopTransaction', { transactionId });
  }
  reset(cpId: string, type: 'Soft' | 'Hard' = 'Soft') {
    return this.sendCall(cpId, 'Reset', { type });
  }
  changeAvailability(cpId: string, connectorId: number, type: 'Operative' | 'Inoperative') {
    return this.sendCall(cpId, 'ChangeAvailability', { connectorId, type });
  }

  conectados(): string[] {
    return Array.from(this.clients.entries()).filter(([, ws]) => ws.readyState === WebSocket.OPEN).map(([id]) => id);
  }

  // ---- helpers -------------------------------------------------------------
  private novoId(): string { return randomBytes(13).toString('hex'); }
  private intOrNull(v: any): number | null { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : null; }

  private async resolveMorador(cpId: string, idTag: string): Promise<string | null> {
    const tag = String(idTag || '').trim().toUpperCase();
    if (!tag) return null;
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT TRIM(id) AS id FROM moradores WHERE UPPER(TRIM(tag_uid)) = ${tag} AND deleted_at IS NULL LIMIT 1
    `;
    return rows?.[0]?.id ?? null;
  }

  private async upsertCp(cpId: string, data: Record<string, any>) {
    // upsert dinâmico dos campos informados (só os presentes). Colunas fixas (whitelist).
    const cols = ['vendor', 'model', 'firmware_version', 'serial_number', 'status', 'conectado', 'ultimo_boot', 'ultimo_heartbeat'];
    const set = cols.filter((c) => data[c] !== undefined);
    try {
      // garante a linha
      await this.prisma.$executeRaw`
        INSERT INTO ocpp_charge_points (id, charge_point_id, conectado, created_at, updated_at)
        VALUES (${this.novoId()}, ${cpId}, ${data.conectado ?? false}, now(), now())
        ON CONFLICT (charge_point_id) DO NOTHING
      `;
      for (const c of set) {
        // cada campo isolado (valores parametrizados; nomes de coluna são whitelist fixa acima)
        await this.prisma.$executeRawUnsafe(
          `UPDATE ocpp_charge_points SET ${c} = $1, updated_at = now() WHERE charge_point_id = $2`,
          data[c], cpId,
        );
      }
    } catch (e: any) {
      this.logger.warn(`[${cpId}] upsertCp falhou: ${e?.message}`);
    }
  }
}
