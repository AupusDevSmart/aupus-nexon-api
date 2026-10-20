import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import axios from 'axios';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/core';
import { MailService } from '@/core/mail/mail.service';
import { WhatsappService } from '../monitoramento-fv/notificacao/whatsapp.service';
import { ChamadosService } from './chamados.service';
import { emailDoChamado, MAX_TENTATIVAS, textoWhatsapp, type ChamadoParaMensagem } from './chamados-regras';

/**
 * Fila de encaminhamento dos chamados (chamados_encaminhamentos). Sem Bull: um intervalo
 * curto e uma trava em memória, como o entrega.worker da sincronização.
 *
 * - EMAIL → MailService (SMTP do NexON).
 * - WHATSAPP → WhatsappService (wpp.aupusenergia, credencial em bdo.configuracoes).
 * - SMART_SERVICE → POST {SMART_SERVICE_URL}/integracoes/nexon/chamados com Bearer
 *   SMART_SERVICE_TOKEN. Sem as duas variáveis, fica AGUARDANDO_INTEGRACAO e sai sozinho
 *   quando forem configuradas. Contrato em docs/CHAMADOS.md.
 */
@Injectable()
export class ChamadosEncaminhamentoWorker {
  private readonly logger = new Logger(ChamadosEncaminhamentoWorker.name);
  private rodando = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly whatsapp: WhatsappService,
    private readonly chamados: ChamadosService,
  ) {}

  static smartServiceConfigurado(): boolean {
    return !!(process.env.SMART_SERVICE_URL && process.env.SMART_SERVICE_TOKEN);
  }

  @Interval(15_000)
  async tick() {
    if (this.rodando || process.env.CHAMADOS_WORKER === 'off') return;
    this.rodando = true;
    try {
      await this.processar();
    } catch (e) {
      this.logger.warn(`[chamados] fila: ${(e as Error).message}`);
    } finally {
      this.rodando = false;
    }
  }

  async processar(limite = 20): Promise<number> {
    const status = ChamadosEncaminhamentoWorker.smartServiceConfigurado()
      ? ['PENDENTE', 'AGUARDANDO_INTEGRACAO']
      : ['PENDENTE'];
    const fila = await this.prisma.chamados_encaminhamentos.findMany({
      where: { status: { in: status } },
      orderBy: { created_at: 'asc' },
      take: limite,
      include: { chamado: true },
    });
    for (const enc of fila) await this.enviar(enc);
    return fila.length;
  }

  private async enviar(enc: Prisma.chamados_encaminhamentosGetPayload<{ include: { chamado: true } }>) {
    const c = enc.chamado;
    // Falhou antes: espera 2 min por tentativa antes de insistir.
    if (enc.tentativas > 0 && Date.now() - enc.updated_at.getTime() < enc.tentativas * 120_000) return;

    if (enc.destino === 'SMART_SERVICE' && !ChamadosEncaminhamentoWorker.smartServiceConfigurado()) {
      await this.prisma.chamados_encaminhamentos.update({
        where: { id: enc.id },
        data: { status: 'AGUARDANDO_INTEGRACAO', ultimo_erro: 'Integração com o Smart Service ainda não configurada' },
      });
      return;
    }

    const ctx = await this.chamados.contexto(c.equipamento_id, c.planta_id);
    const msg: ChamadoParaMensagem = {
      numero: c.numero,
      titulo: c.titulo,
      descricao: c.descricao,
      motivo: c.motivo,
      prioridade: c.prioridade,
      autor_nome: c.autor_nome,
      created_at: c.created_at,
      equipamento: ctx.equipamento,
      unidade: ctx.unidade,
      planta: ctx.planta,
    };

    let referencia: string | null = null;
    let erro: string | null = null;
    try {
      if (enc.destino === 'EMAIL') {
        const { assunto, html } = emailDoChamado(msg, enc.observacao);
        if (!(await this.mail.sendAviso(enc.contato ?? '', assunto, html))) erro = 'SMTP recusou ou não está configurado';
      } else if (enc.destino === 'WHATSAPP') {
        await this.whatsapp.enviarParaNumero(enc.contato ?? '', textoWhatsapp(msg, enc.observacao));
      } else if (enc.destino === 'SMART_SERVICE') {
        const { data } = await axios.post(
          `${process.env.SMART_SERVICE_URL!.replace(/\/$/, '')}/integracoes/nexon/chamados`,
          {
            nexon_chamado_id: c.id,
            numero: c.numero,
            titulo: c.titulo,
            descricao: c.descricao,
            motivo: c.motivo,
            prioridade: c.prioridade,
            equipamento_id: c.equipamento_id,
            unidade_id: c.unidade_id,
            planta_id: c.planta_id,
            proprietario_id: c.proprietario_id,
            autor_nome: c.autor_nome,
            aberto_em: c.created_at.toISOString(),
            observacao: enc.observacao,
          },
          { headers: { Authorization: `Bearer ${process.env.SMART_SERVICE_TOKEN}` }, timeout: 15_000 },
        );
        const d = data?.data ?? data;
        referencia = d?.id ? String(d.id).slice(0, 100) : null;
      }
    } catch (e: any) {
      erro = (e?.response?.data?.message ?? e?.message ?? String(e)).toString();
    }

    const tentativas = enc.tentativas + 1;
    if (!erro) {
      await this.prisma.chamados_encaminhamentos.update({
        where: { id: enc.id },
        data: { status: 'ENVIADO', tentativas, enviado_em: new Date(), ultimo_erro: null, referencia_externa: referencia },
      });
      await this.chamados.auditarEnvio(c.id, { ...enc, tentativas }, { ok: true, referencia });
      return;
    }

    const desistiu = tentativas >= MAX_TENTATIVAS;
    await this.prisma.chamados_encaminhamentos.update({
      where: { id: enc.id },
      data: { status: desistiu ? 'FALHOU' : 'PENDENTE', tentativas, ultimo_erro: erro.slice(0, 500) },
    });
    this.logger.warn(`[chamados] #${c.numero} ${enc.destino} tentativa ${tentativas}: ${erro}`);
    if (desistiu) await this.chamados.auditarEnvio(c.id, { ...enc, tentativas }, { ok: false, erro });
  }
}
