import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '@/core';
import type { EstacaoOcpp } from './ocpp-conexao';
import type { Medicao } from './ocpp-protocolo';

export interface TransacaoOcpp {
  transactionId: number;
  status: 'ativa' | 'encerrada';
  connectorId: number | null;
  idTag: string | null;
  meterStartWh: number | null;
}

/**
 * Banco da central OCPP (`ocpp_charge_points`, `ocpp_transactions`, `ocpp_meter_values`):
 * o registro do que o carregador disse, antes de virar recarga do NexON. SQL à parte do
 * serviço para os testes trocarem por memória (ver testing/ocpp-repositorio.memoria.ts).
 *
 * Datas: o banco roda em UTC e estas colunas são `timestamp` sem fuso → tudo UTC.
 */
@Injectable()
export class OcppRepositorio {
  constructor(private readonly prisma: PrismaService) {}

  private novoId(): string {
    return randomBytes(13).toString('hex');
  }

  /** Estações cadastradas (não excluídas): o cadastro que decide quem conecta. */
  async listarEstacoes(): Promise<EstacaoOcpp[]> {
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT TRIM(id) AS id, charge_point_id, TRIM(equipamento_id) AS equipamento_id, TRIM(planta_id) AS planta_id,
             connector_id, chave_hash
      FROM ocpp_charge_points WHERE deleted_at IS NULL`;
    return rows.map((r) => ({
      id: r.id,
      chargePointId: r.charge_point_id,
      equipamentoId: r.equipamento_id || null,
      plantaId: r.planta_id || null,
      conector: Number(r.connector_id) || 1,
      chaveHash: r.chave_hash || null,
    }));
  }

  /** No boot da API ninguém está conectado: o que sobrou do processo anterior é mentira. */
  async marcarTodasDesconectadas(): Promise<void> {
    await this.prisma.$executeRaw`UPDATE ocpp_charge_points SET conectado = false, ultima_desconexao = now() WHERE conectado = true`;
  }

  async conectou(id: string, ip: string | null): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE ocpp_charge_points SET conectado = true, ultima_conexao = now(), ip = ${ip}, updated_at = now() WHERE id = ${id}::bpchar`;
  }

  async desconectou(id: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE ocpp_charge_points SET conectado = false, ultima_desconexao = now(), updated_at = now() WHERE id = ${id}::bpchar`;
  }

  async boot(id: string, p: { vendor: string; model: string; serial: string | null; firmware: string | null }): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE ocpp_charge_points
      SET vendor = ${p.vendor}, model = ${p.model}, serial_number = ${p.serial}, firmware_version = ${p.firmware},
          ultimo_boot = now(), conectado = true, updated_at = now()
      WHERE id = ${id}::bpchar`;
  }

  async heartbeat(id: string): Promise<void> {
    await this.prisma.$executeRaw`UPDATE ocpp_charge_points SET ultimo_heartbeat = now() WHERE id = ${id}::bpchar`;
  }

  /** StartTransaction repetido (o carregador reenvia quando não recebe a resposta): mesma transação. */
  async transacaoIgual(cp: string, connectorId: number, idTag: string, meterStartWh: number, inicio: Date): Promise<number | null> {
    const r = await this.prisma.$queryRaw<Array<{ transaction_id: bigint }>>`
      SELECT transaction_id FROM ocpp_transactions
      WHERE charge_point_id = ${cp} AND connector_id = ${connectorId} AND id_tag = ${idTag}
        AND meter_start = ${meterStartWh} AND inicio = ${inicio}
      ORDER BY created_at DESC LIMIT 1`;
    return r[0] ? Number(r[0].transaction_id) : null;
  }

  async novaTransacao(p: { cp: string; connectorId: number; idTag: string; moradorId: string | null; meterStartWh: number; inicio: Date }): Promise<number> {
    const seq = await this.prisma.$queryRaw<Array<{ nextval: bigint }>>`SELECT nextval('ocpp_transaction_seq') AS nextval`;
    const txId = Number(seq[0].nextval);
    await this.prisma.$executeRaw`
      INSERT INTO ocpp_transactions (id, transaction_id, charge_point_id, connector_id, id_tag, morador_id, meter_start, inicio, status, created_at, updated_at)
      VALUES (${this.novoId()}, ${txId}, ${p.cp}, ${p.connectorId}, ${p.idTag}, ${p.moradorId}, ${p.meterStartWh}, ${p.inicio}, 'ativa', now(), now())`;
    return txId;
  }

  async transacao(cp: string, transactionId: number): Promise<TransacaoOcpp | null> {
    const r = await this.prisma.$queryRaw<any[]>`
      SELECT transaction_id, status, connector_id, id_tag, meter_start
      FROM ocpp_transactions WHERE transaction_id = ${transactionId} AND charge_point_id = ${cp} LIMIT 1`;
    if (!r[0]) return null;
    return {
      transactionId: Number(r[0].transaction_id),
      status: r[0].status === 'encerrada' ? 'encerrada' : 'ativa',
      connectorId: r[0].connector_id ?? null,
      idTag: r[0].id_tag ?? null,
      meterStartWh: r[0].meter_start ?? null,
    };
  }

  async encerrarTransacao(cp: string, transactionId: number, p: { meterStopWh: number; fim: Date; motivo: string }): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE ocpp_transactions
      SET meter_stop = ${p.meterStopWh},
          energia_kwh = CASE WHEN meter_start IS NOT NULL THEN GREATEST(${p.meterStopWh}::int - meter_start, 0) / 1000.0 ELSE energia_kwh END,
          fim = ${p.fim}, motivo_fim = ${p.motivo.slice(0, 32)}, status = 'encerrada', updated_at = now()
      WHERE transaction_id = ${transactionId} AND charge_point_id = ${cp}`;
  }

  async gravarMedicao(p: { cp: string; transactionId: number | null; connectorId: number; ts: Date; m: Medicao; raw: unknown }): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO ocpp_meter_values (id, transaction_id, charge_point_id, connector_id, ts, energia_wh, potencia_w, corrente_a, tensao_v, temperatura_c, soc, raw, created_at)
      VALUES (${this.novoId()}, ${p.transactionId}, ${p.cp}, ${p.connectorId}, ${p.ts}, ${p.m.energiaWh}, ${p.m.potenciaW},
              ${p.m.correnteA}, ${p.m.tensaoV}, ${p.m.temperaturaC}, ${p.m.soc}, ${JSON.stringify(p.raw ?? {})}::jsonb, now())`;
  }
}
