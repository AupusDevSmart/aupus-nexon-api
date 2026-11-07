import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/core';
import { MailService } from '@/core/mail/mail.service';
import { ChamadosService } from '../chamados/chamados.service';
import { emailDoAlerta, horaLocal, tituloEvento } from './cameras-regras';
import type { NomeId } from './cameras.tipos';

export interface AlertaCamera {
  evento: { id: string; tipo: string; inicio_em: Date; confianca: number | null };
  camera: { id: string; nome: string; equipamento_id: string | null; unidade_id: string };
  unidade: NomeId | null;
  planta: NomeId | null;
  config: { abrir_chamado: boolean; notificar_emails: string[] } | null;
}

/** Mesmo alerta de câmera não manda e-mail de novo dentro deste intervalo. */
export const COOLDOWN_EMAIL_MS = 5 * 60_000;
/** Alerta novo da mesma câmera reaproveita o chamado aberto há menos que isto. */
export const REUSO_CHAMADO_MS = 60 * 60_000;

/**
 * O que acontece quando um evento vira alerta (pessoa/veículo armado, câmera sem sinal):
 * linha em logs_mqtt (tela de alarmes) quando a câmera tem equipamento, chamado opcional
 * (config.abrir_chamado, também só com equipamento) e e-mail para config.notificar_emails.
 * Push fica para depois (NotificacoesPushService ainda é stub). Nunca lança.
 */
@Injectable()
export class CamerasNotificacaoService {
  private readonly logger = new Logger(CamerasNotificacaoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly chamados: ChamadosService,
  ) {}

  linkUnidade(unidadeId: string): string {
    const base = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
    return `${base}/supervisorio/sinoptico-ativo/${unidadeId.trim()}`;
  }

  async alertar(a: AlertaCamera, agora = new Date()): Promise<{ chamado_id: string | null; emails_enviados: number }> {
    const titulo = tituloEvento(a.evento.tipo);
    const link = this.linkUnidade(a.camera.unidade_id);

    if (a.camera.equipamento_id) await this.registrarAlarme(a, titulo);

    let chamadoId: string | null = null;
    if (a.camera.equipamento_id && a.config?.abrir_chamado) chamadoId = await this.abrirOuReusarChamado(a, titulo, link, agora);

    let enviados = 0;
    const emails = [...new Set((a.config?.notificar_emails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean))];
    if (emails.length && !(await this.emCooldown(a, agora))) {
      const { assunto, html } = emailDoAlerta({
        tipo: a.evento.tipo,
        inicio_em: a.evento.inicio_em,
        confianca: a.evento.confianca,
        camera_nome: a.camera.nome,
        unidade_nome: a.unidade?.nome ?? null,
        planta_nome: a.planta?.nome ?? null,
        link,
      });
      for (const to of emails) {
        try {
          if (await this.mail.sendAviso(to, assunto, html)) enviados++;
          else this.logger.warn(`[cameras] e-mail de alerta não enviado para ${to} (SMTP ausente ou recusou)`);
        } catch (e) {
          this.logger.warn(`[cameras] e-mail de alerta para ${to}: ${(e as Error).message}`);
        }
      }
    }
    return { chamado_id: chamadoId, emails_enviados: enviados };
  }

  /** Tela de alarmes (GET /logs-mqtt): mesma forma do TRIP do relé (soe-trip-alarme.service). */
  private async registrarAlarme(a: AlertaCamera, titulo: string): Promise<void> {
    try {
      await this.prisma.logs_mqtt.create({
        data: {
          regra_id: null,
          equipamento_id: a.camera.equipamento_id!,
          tipo: 'alerta',
          severidade: 'ALTA',
          mensagem: `Câmera ${a.camera.nome} — ${titulo}`.slice(0, 500),
          valor_lido: null,
          dados_snapshot: {
            kind: 'camera',
            camera_id: a.camera.id,
            evento_id: a.evento.id,
            tipo: a.evento.tipo,
            unidade_id: a.camera.unidade_id,
            inicio_em: a.evento.inicio_em.toISOString(),
          },
        },
      });
    } catch (e) {
      this.logger.warn(`[cameras] alarme em logs_mqtt não gravado (câmera ${a.camera.id}): ${(e as Error).message}`);
    }
  }

  private async abrirOuReusarChamado(a: AlertaCamera, titulo: string, link: string, agora: Date): Promise<string | null> {
    try {
      const recente = await this.prisma.cameras_eventos.findFirst({
        where: {
          camera_id: a.camera.id,
          chamado_id: { not: null },
          inicio_em: { gte: new Date(agora.getTime() - REUSO_CHAMADO_MS) },
          id: { not: a.evento.id },
        },
        orderBy: { inicio_em: 'desc' },
        select: { chamado_id: true },
      });
      let chamadoId = recente?.chamado_id ?? null;
      if (!chamadoId) {
        const local = [a.unidade ? `instalação ${a.unidade.nome}` : null, a.planta ? `(${a.planta.nome})` : null].filter(Boolean).join(' ');
        const r = await this.chamados.abrir(
          {
            equipamento_id: a.camera.equipamento_id!,
            titulo: `Câmera ${a.camera.nome}: ${titulo}`.slice(0, 200),
            descricao:
              `${titulo} em ${horaLocal(a.evento.inicio_em)} (Brasília) pela câmera "${a.camera.nome}"${local ? ` da ${local}` : ''}.` +
              `${a.evento.confianca != null ? ` Confiança ${Math.round(a.evento.confianca * 100)}%.` : ''} Veja o evento no NexON: ${link}`,
            motivo: 'ALARME',
            prioridade: 'ALTA',
          },
          { nome: 'Câmeras NexON (alerta automático)' },
          undefined,
        );
        chamadoId = r.id;
      }
      await this.prisma.cameras_eventos.update({ where: { id: a.evento.id }, data: { chamado_id: chamadoId } });
      return chamadoId;
    } catch (e) {
      this.logger.warn(`[cameras] chamado do alerta não aberto (câmera ${a.camera.id}): ${(e as Error).message}`);
      return null;
    }
  }

  private async emCooldown(a: AlertaCamera, agora: Date): Promise<boolean> {
    try {
      const n = await this.prisma.cameras_eventos.count({
        where: {
          camera_id: a.camera.id,
          alerta: true,
          id: { not: a.evento.id },
          inicio_em: { gte: new Date(agora.getTime() - COOLDOWN_EMAIL_MS), lte: agora },
        },
      });
      return n > 0;
    } catch {
      return false;
    }
  }
}
