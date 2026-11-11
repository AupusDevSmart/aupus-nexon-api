import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import axios from 'axios';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TABELA } from './arvore';
import { Recurso, montarPayload } from './recursos';


/**
 * A mensagem que o outro lado devolveu, ou a do proprio erro (timeout, rede, banco).
 * O filtro de excecao dos dois backends responde `{ error: { message } }`, com a
 * mensagem em texto ou em lista (a validacao): ler so `message` na raiz dava sempre
 * "Request failed with status code 400", e o "operacao desconhecida" do receptor
 * antigo nao aparecia na fila nem na saude.
 */
export function motivoDaFalha(e: unknown): string {
  type Corpo = { message?: unknown; error?: { message?: unknown } };
  const corpo = axios.isAxiosError<Corpo>(e) ? e.response?.data : undefined;
  const mensagem = corpo?.error?.message ?? corpo?.message;
  const texto = Array.isArray(mensagem) ? mensagem.map(String).join('; ') : typeof mensagem === 'string' ? mensagem : undefined;
  const status = axios.isAxiosError(e) && e.response ? `${e.response.status}: ` : '';
  return texto ? `${status}${texto}` : ((e instanceof Error ? e.message : undefined) ?? 'falha desconhecida');
}

/** O `detalhe` da resposta, que pode vir embrulhada pelo interceptor (`data.data`) */
function detalheDa(data: { detalhe?: unknown; data?: { detalhe?: unknown } } | undefined): string | null {
  const d = data?.detalhe ?? data?.data?.detalhe;
  return typeof d === 'string' ? d : null;
}

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
          const envio = await this.montarEnvio(ev, origem);

          // A linha sumiu de vez entre o evento e o envio (ou o restaurado foi apagado
          // de novo). Nao ha o que mandar, e insistir so encheria a fila de erro.
          if (!envio) {
            await this.prisma.sincronizacao_outbox.update({
              where: { id: ev.id },
              data: { entregue_em: new Date(), erro: 'nada a enviar: o registro não existe mais na origem, ou foi apagado de novo antes do restauro sair' },
            });
            continue;
          }

          const { data } = await axios.post(`${destino.replace(/\/$/, '')}/sincronizacao/eventos`, envio, {
            headers: { 'x-sincronizacao-token': token },
            timeout: 15_000,
          });

          const resultado = data?.resultado ?? data?.data?.resultado;

          // Dependencia ausente NAO e entrega concluida: a planta pode chegar
          // daqui a pouco e ai este evento passa a fazer sentido. Marcar como
          // entregue perderia o registro para sempre.
          if (resultado === 'dependencia_ausente') {
            await this.adiar(ev.id, ev.tentativas, detalheDa(data) ?? 'dependência ausente no destino');
            continue;
          }

          await this.prisma.sincronizacao_outbox.update({
            where: { id: ev.id },
            data: { entregue_em: new Date(), erro: null },
          });

          // Com o detalhe de la: a recusa (vinculo desligado, apagado, e-mail de outra
          // conta) e entregue e nao se repete, e o selo da tela le daqui o porque
          await this.prisma.sincronizacao_auditoria.create({
            data: {
              direcao: 'enviado', recurso: ev.recurso, registro_id: ev.registro_id,
              versao: ev.versao, origem, resultado: resultado ?? 'aplicado', detalhe: detalheDa(data),
            },
          });
        } catch (e) {
          const motivo = motivoDaFalha(e);
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
    // Remocao, desvinculo e restauro nao precisam do conteudo: o outro lado so precisa saber de quem.
    // O vinculo leva o conteudo, como o upsert (o outro lado grava ao religar).
    if (operacao === 'delete' || operacao === 'desvinculo' || operacao === 'restauro') return { id };

    const linha = await (this.prisma as any)[recurso].findUnique({ where: { id } });
    return linha ? montarPayload(recurso, linha) : null;
  }

  /**
   * O que vai pela rede para um evento da fila; null quando o registro sumiu de
   * vez. Separado da rodada para o teste chamar com o evento dele: a fila do
   * banco de teste é de todos os specs, e a rodada inteira entregaria (e
   * marcaria) os eventos dos outros.
   */
  async montarEnvio(
    ev: { recurso: string; registro_id: string; operacao: string; versao: bigint; criado_em: Date },
    origem: string,
  ): Promise<Record<string, unknown> | null> {
    // A exclusão cujo registro voltou (restaurado) antes da entrega não é mais
    // exclusão: vai como desvínculo, que só desliga o compartilhamento lá (o
    // vínculo daqui já se desligou ao apagar). Mandar o aviso diria "apagado" de
    // um registro vivo (10/11/2026)
    const operacao = ev.operacao === 'delete' && (await this.foiRestaurado(ev.recurso as Recurso, ev.registro_id)) ? 'desvinculo' : ev.operacao;
    // O restauro de um registro apagado de novo antes de sair não vai: lá ele fecharia, como
    // "restaurado", o aviso da exclusão que continua valendo
    if (operacao === 'restauro' && !(await this.foiRestaurado(ev.recurso as Recurso, ev.registro_id))) return null;
    const payload = await this.payloadAtual(ev.recurso as Recurso, ev.registro_id, operacao);
    if (!payload) return null;
    return {
      recurso: ev.recurso,
      registro_id: ev.registro_id,
      operacao,
      versao: ev.versao.toString(),
      origem,
      payload,
      // Quando aconteceu aqui: o aviso de exclusão do outro lado diz a data da exclusão,
      // não a da entrega (a fila de 26/10 só chegou em 07/11)
      criado_em: ev.criado_em.toISOString(),
    };
  }

  /** A linha existe e não está apagada: o registro foi restaurado depois da exclusão enfileirada */
  private async foiRestaurado(recurso: Recurso, registroId: string): Promise<boolean> {
    const linhas = await this.prisma.$queryRaw<{ deleted_at: Date | null }[]>`
      SELECT deleted_at FROM ${Prisma.raw(TABELA[recurso])} WHERE id = ${registroId.trim()}::bpchar LIMIT 1`;
    return linhas.length > 0 && linhas[0].deleted_at === null;
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
