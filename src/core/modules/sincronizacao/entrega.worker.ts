import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import axios from 'axios';
import { PrismaService } from '../../prisma/prisma.service';
import { Recurso, montarPayload } from './recursos';

/** Quantos eventos por rodada. Volume real e baixo; lotes grandes so atrasariam o primeiro. */
const LOTE = 20;

/** Espera antes de tentar de novo, por numero de tentativas. A ultima e ~8 min. */
const BACKOFF_SEGUNDOS = [5, 15, 60, 300, 500];

@Injectable()
export class EntregaWorker {
  private readonly logger = new Logger(EntregaWorker.name);
  private rodando = false;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Empurra o que esta no outbox para o outro produto.
   *
   * Intervalo curto e lote pequeno em vez de fila dedicada: o projeto tem Redis
   * mas nao tem BullMQ, e com este volume (9 plantas, 23 instalacoes, 254
   * equipamentos) introduzir uma fila seria mais peca movel para manter do que
   * beneficio. Uma consulta a cada 10s numa tabela vazia nao custa nada.
   */
  @Interval(10_000)
  async entregar(): Promise<void> {
    // Duas rodadas ao mesmo tempo entregariam o mesmo evento duas vezes. O
    // receptor e idempotente, mas gastar a chamada a toa e sujar a auditoria com
    // duplicados nao ajuda ninguem.
    if (this.rodando) return;
    this.rodando = true;

    try {
      const destino = process.env.SINCRONIZACAO_DESTINO_URL;
      const token = process.env.SINCRONIZACAO_TOKEN;
      if (!destino || !token) return;

      const pendentes = await this.prisma.sincronizacao_outbox.findMany({
        where: { entregue_em: null, proxima_em: { lte: new Date() } },
        // Ordem de criacao, sempre. Um evento de instalacao nao pode chegar
        // antes da planta dela; a ordem causal ja e a ordem em que foram
        // gravados, e sair dela criaria dependencia ausente sem necessidade.
        orderBy: { id: 'asc' },
        take: LOTE,
      });
      if (!pendentes.length) return;

      const origem = await this.origem();

      for (const ev of pendentes) {
        try {
          // O payload e montado AGORA, lendo a linha atual — o trigger so anotou
          // que mudou. Cinco edicoes seguidas viram cinco eventos que convergem
          // para o mesmo conteudo, em vez de cinco fotos velhas em fila. E a
          // lista do que nunca viaja (senha, remember_token, role) fica num
          // lugar so, em TypeScript.
          const payload = await this.payloadAtual(ev.recurso as Recurso, ev.registro_id, ev.operacao);

          // A linha sumiu de vez entre o evento e o envio. Nao ha o que mandar,
          // e insistir so encheria a fila de erro.
          if (!payload) {
            await this.prisma.sincronizacao_outbox.update({
              where: { id: ev.id },
              data: { entregue_em: new Date(), erro: 'registro não existe mais na origem' },
            });
            continue;
          }

          const { data } = await axios.post(
            `${destino.replace(/\/$/, '')}/sincronizacao/eventos`,
            {
              recurso: ev.recurso,
              registro_id: ev.registro_id,
              operacao: ev.operacao,
              versao: ev.versao.toString(),
              origem,
              payload,
            },
            { headers: { 'x-sincronizacao-token': token }, timeout: 15_000 },
          );

          const resultado = data?.resultado ?? data?.data?.resultado;

          // Dependencia ausente NAO e entrega concluida: a planta pode chegar
          // daqui a pouco e ai este evento passa a fazer sentido. Marcar como
          // entregue perderia o registro para sempre.
          if (resultado === 'dependencia_ausente') {
            await this.adiar(ev.id, ev.tentativas, data?.detalhe ?? 'dependência ausente no destino');
            continue;
          }

          await this.prisma.sincronizacao_outbox.update({
            where: { id: ev.id },
            data: { entregue_em: new Date(), erro: null },
          });

          await this.prisma.sincronizacao_auditoria.create({
            data: {
              direcao: 'enviado', recurso: ev.recurso, registro_id: ev.registro_id,
              versao: ev.versao, origem, resultado: resultado ?? 'aplicado',
            },
          });
        } catch (e: any) {
          const motivo = e?.response?.data?.message ?? e?.message ?? 'falha desconhecida';
          await this.adiar(ev.id, ev.tentativas, motivo);
          // Uma falha costuma valer para todas: o outro lado caiu, ou o token
          // esta errado. Insistir no lote inteiro so multiplicaria o timeout.
          break;
        }
      }
    } finally {
      this.rodando = false;
    }
  }

  /** Le a linha atual e monta o que vai pela rede. */
  private async payloadAtual(
    recurso: Recurso,
    registroId: string,
    operacao: string,
  ): Promise<Record<string, any> | null> {
    const id = registroId.trim();
    // Remocao nao precisa do conteudo: o outro lado so precisa saber quem sair.
    if (operacao === 'delete') return { id };

    const linha = await (this.prisma as any)[recurso].findUnique({ where: { id } });
    return linha ? montarPayload(recurso, linha) : null;
  }

  private async origem(): Promise<string> {
    const no = await this.prisma.sincronizacao_no.findFirst({ select: { origem: true } });
    if (!no) throw new Error('sincronizacao_no vazia: este servidor nao sabe o proprio nome');
    return no.origem;
  }

  /**
   * Adia com espera crescente.
   *
   * Nao desiste nunca. Um evento descartado apos N tentativas seria uma
   * divergencia permanente entre os dois bancos sem nada apontando para ela; o
   * evento parado com o erro visivel e pior de ver e melhor de consertar. A
   * tela mostra como "erro de sincronizacao" a partir da terceira tentativa.
   */
  private async adiar(id: bigint, tentativas: number, erro: string): Promise<void> {
    const espera = BACKOFF_SEGUNDOS[Math.min(tentativas, BACKOFF_SEGUNDOS.length - 1)];
    await this.prisma.sincronizacao_outbox.update({
      where: { id },
      data: {
        tentativas: tentativas + 1,
        proxima_em: new Date(Date.now() + espera * 1000),
        erro: erro.slice(0, 2000),
      },
    });
    if (tentativas + 1 === 3) this.logger.warn(`evento ${id} falhou 3 vezes: ${erro}`);
  }
}
