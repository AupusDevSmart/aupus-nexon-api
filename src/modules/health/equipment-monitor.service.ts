import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '@aupus/api-shared';
import * as nodemailer from 'nodemailer';

/**
 * Monitor de equipamentos offline (restaurado do antigo aupus-service-api).
 *
 * A cada 5 min varre os `equipamentos` com `mqtt_habilitado`, olha o último
 * `equipamentos_dados.timestamp_dados` e considera OFFLINE quem está sem dado há mais que
 * OFFLINE_THRESHOLD_MINUTES. Guarda o estado em memória e **só notifica na TRANSIÇÃO**
 * (online→offline dispara alerta; offline→online dispara "voltou"). No boot o estado é
 * inicializado a partir do banco SEM notificar — logo não há spam ao subir o processo.
 *
 * Destinatários: só a equipe Aupus (super_admin/admin). Como super_admin já enxerga todas as
 * plantas no app, não há quebra de isolamento entre clientes (a régua de tenant vale pra
 * proprietário/operador, que aqui NÃO são notificados). Ver feedback_tenant_isolation.
 */
interface EquipRow {
  id: string;
  nome: string;
  topico_mqtt: string | null;
  unidade_nome: string;
  planta_nome: string;
  planta_id: string;
  last_data: Date | null;
}
type OfflineRow = EquipRow & { minutesOffline: number };

@Injectable()
export class EquipmentMonitorService implements OnModuleInit {
  private readonly logger = new Logger(EquipmentMonitorService.name);
  private readonly equipmentState = new Map<string, { online: boolean }>();
  private initialized = false;
  private readonly OFFLINE_THRESHOLD_MINUTES = 30;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.initializeStateFromDB();
  }

  /** Consulta base: equipamentos MQTT ativos + timestamp do último dado recebido. */
  private async fetchEquipments(): Promise<EquipRow[]> {
    return this.prisma.$queryRaw<EquipRow[]>`
      SELECT e.id, e.nome, e.topico_mqtt,
             u.nome AS unidade_nome, p.nome AS planta_nome, p.id AS planta_id,
             ed.last_data
      FROM equipamentos e
      JOIN unidades u ON u.id = e.unidade_id
      JOIN plantas  p ON p.id = u.planta_id
      LEFT JOIN LATERAL (
        SELECT max(d.timestamp_dados) AS last_data
        FROM equipamentos_dados d
        WHERE d.equipamento_id = e.id
      ) ed ON true
      WHERE e.mqtt_habilitado = true
        AND e.deleted_at IS NULL
        AND u.deleted_at IS NULL
        AND p.deleted_at IS NULL
        AND (e.topico_mqtt IS NULL OR e.topico_mqtt NOT LIKE 'TESTE/%')
    `;
  }

  private minutesSince(last: Date | null, now: Date): number {
    return last ? (now.getTime() - new Date(last).getTime()) / 60000 : Infinity;
  }

  /** Semeia o estado a partir do banco SEM notificar (evita spam no boot/restart). */
  private async initializeStateFromDB(): Promise<void> {
    try {
      const equipments = await this.fetchEquipments();
      const now = new Date();
      for (const eq of equipments) {
        const online = this.minutesSince(eq.last_data, now) < this.OFFLINE_THRESHOLD_MINUTES;
        this.equipmentState.set(eq.id, { online });
      }
      this.initialized = true;
      const online = [...this.equipmentState.values()].filter((s) => s.online).length;
      this.logger.log(
        `📋 Monitor inicializado: ${online} online, ${equipments.length - online} offline de ${equipments.length} equipamentos (limiar ${this.OFFLINE_THRESHOLD_MINUTES} min)`,
      );
    } catch (error: any) {
      this.logger.error('❌ Erro ao inicializar estado do monitor:', error?.message);
      this.initialized = true; // não trava o cron; a 1ª rodada semeia o que faltar
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async checkEquipmentStatus(): Promise<void> {
    if (!this.initialized) return;
    try {
      const equipments = await this.fetchEquipments();
      const now = new Date();
      const wentOffline: OfflineRow[] = [];
      const recovered: EquipRow[] = [];

      for (const eq of equipments) {
        const mins = this.minutesSince(eq.last_data, now);
        const isOnline = mins < this.OFFLINE_THRESHOLD_MINUTES;
        const prev = this.equipmentState.get(eq.id);
        const wasOnline = prev?.online ?? isOnline; // equipamento novo entra no estado atual, sem alerta

        if (wasOnline && !isOnline) {
          this.logger.warn(
            `🔴 OFFLINE: ${eq.nome} (${eq.unidade_nome} / ${eq.planta_nome}) — sem dados há ${Math.round(mins)} min`,
          );
          wentOffline.push({ ...eq, minutesOffline: Math.round(mins) });
        } else if (!wasOnline && isOnline) {
          this.logger.log(`✅ ONLINE: ${eq.nome} (${eq.unidade_nome} / ${eq.planta_nome}) voltou`);
          recovered.push(eq);
        }
        this.equipmentState.set(eq.id, { online: isOnline });
      }

      if (wentOffline.length > 0) await this.notifyOffline(wentOffline);
      if (recovered.length > 0) await this.notifyRecovered(recovered);
    } catch (error: any) {
      this.logger.error('❌ Erro ao verificar equipamentos:', error?.message);
    }
  }

  /** Equipe Aupus (super_admin/admin) com e-mail válido. Único conjunto de destinatários. */
  private async getRecipients(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ email: string }>>`
      SELECT DISTINCT u.email
      FROM usuarios u
      WHERE u.deleted_at IS NULL
        AND u.email IS NOT NULL AND u.email <> ''
        AND u.role IN ('super_admin', 'admin')
    `;
    return rows.map((r) => r.email).filter(Boolean);
  }

  private transporter(): nodemailer.Transporter | null {
    const host = process.env.SMTP_HOST;
    if (!host) {
      this.logger.warn('⚠️ SMTP_HOST não configurado — alerta só no log');
      return null;
    }
    return nodemailer.createTransport({
      host,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }

  private from(): string {
    return `"NexOn Alertas" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`;
  }

  /** Agrupa por planta e devolve o HTML de seções (planta → tabela de equipamentos). */
  private secoesPorPlanta(equipments: OfflineRow[]): string {
    const byPlant = new Map<string, OfflineRow[]>();
    for (const eq of equipments) {
      const arr = byPlant.get(eq.planta_nome) ?? [];
      arr.push(eq);
      byPlant.set(eq.planta_nome, arr);
    }
    let html = '';
    for (const [planta, eqs] of byPlant) {
      const linhas = eqs
        .map(
          (e) => `<tr>
            <td style="padding:8px 12px;border-bottom:1px solid #eee">${e.nome}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #eee">${e.unidade_nome}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#e53e3e;font-weight:bold">${e.minutesOffline} min</td>
            <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:11px;color:#666">${e.topico_mqtt || '-'}</td>
          </tr>`,
        )
        .join('');
      html += `
        <p style="margin:18px 0 6px;font-weight:bold;color:#16213e">${planta}</p>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:#f7f7f7">
            <th style="padding:8px 12px;text-align:left;font-size:13px">Equipamento</th>
            <th style="padding:8px 12px;text-align:left;font-size:13px">Unidade</th>
            <th style="padding:8px 12px;text-align:left;font-size:13px">Sem dados há</th>
            <th style="padding:8px 12px;text-align:left;font-size:13px">Tópico MQTT</th>
          </tr></thead>
          <tbody>${linhas}</tbody>
        </table>`;
    }
    return html;
  }

  private async notifyOffline(equipments: OfflineRow[]): Promise<void> {
    const transporter = this.transporter();
    if (!transporter) return;
    const recipients = await this.getRecipients();
    if (recipients.length === 0) {
      this.logger.warn('⚠️ Sem destinatários (super_admin/admin) — alerta offline não enviado');
      return;
    }
    const plantas = new Set(equipments.map((e) => e.planta_nome)).size;
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto">
        <div style="background:#16213e;padding:20px;border-radius:8px 8px 0 0">
          <h2 style="color:#fff;margin:0">🔴 Equipamento(s) offline</h2>
          <p style="color:#9fb0c9;margin:4px 0 0">${equipments.length} equipamento(s) em ${plantas} planta(s)</p>
        </div>
        <div style="padding:20px;background:#fff;border:1px solid #eee;border-top:none">
          <p>Os seguintes equipamentos estão <strong style="color:#e53e3e">sem enviar dados</strong> há mais de ${this.OFFLINE_THRESHOLD_MINUTES} min:</p>
          ${this.secoesPorPlanta(equipments)}
          <p style="margin-top:20px;font-size:12px;color:#888">NexON — monitoramento automático de equipamentos. Você recebe este alerta por ser administrador da plataforma.</p>
        </div>
      </div>`;
    try {
      await transporter.sendMail({
        from: this.from(),
        to: recipients.join(', '),
        subject: `🔴 [OFFLINE] ${equipments.length} equipamento(s) sem dados`,
        html,
      });
      this.logger.log(`📧 Alerta OFFLINE enviado para ${recipients.length} destinatário(s)`);
    } catch (error: any) {
      this.logger.error('❌ Falha ao enviar alerta OFFLINE:', error?.message);
    }
  }

  private async notifyRecovered(equipments: EquipRow[]): Promise<void> {
    const transporter = this.transporter();
    if (!transporter) return;
    const recipients = await this.getRecipients();
    if (recipients.length === 0) return;
    const nomes = equipments.map((e) => e.nome).join(', ');
    const linhas = equipments
      .map(
        (e) => `<tr>
          <td style="padding:8px 12px;border-bottom:1px solid #eee">${e.nome}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee">${e.unidade_nome}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee">${e.planta_nome}</td>
        </tr>`,
      )
      .join('');
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto">
        <div style="background:#1f7a3d;padding:20px;border-radius:8px 8px 0 0">
          <h2 style="color:#fff;margin:0">✅ Equipamento(s) de volta online</h2>
        </div>
        <div style="padding:20px;background:#fff;border:1px solid #eee;border-top:none">
          <p>Os seguintes equipamentos <strong style="color:#1f7a3d">voltaram a enviar dados</strong>:</p>
          <table style="width:100%;border-collapse:collapse;margin-top:8px">
            <thead><tr style="background:#f7f7f7">
              <th style="padding:8px 12px;text-align:left;font-size:13px">Equipamento</th>
              <th style="padding:8px 12px;text-align:left;font-size:13px">Unidade</th>
              <th style="padding:8px 12px;text-align:left;font-size:13px">Planta</th>
            </tr></thead>
            <tbody>${linhas}</tbody>
          </table>
        </div>
      </div>`;
    try {
      await transporter.sendMail({
        from: this.from(),
        to: recipients.join(', '),
        subject: `✅ [ONLINE] ${nomes} voltou`,
        html,
      });
      this.logger.log(`📧 Alerta ONLINE (recuperação) enviado para ${recipients.length} destinatário(s)`);
    } catch (error: any) {
      this.logger.error('❌ Falha ao enviar alerta ONLINE:', error?.message);
    }
  }
}
