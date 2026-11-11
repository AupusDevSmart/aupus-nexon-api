import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Recurso } from './recursos';
import { resolverCadeia } from './cadeia-de-dependencias';

type Tx = any;

/**
 * Marca a transacao como replicacao, para o trigger nao gerar evento de volta.
 *
 * `SET LOCAL` vale ate o fim da transacao e some sozinho — nao ha estado para
 * limpar, nem risco de vazar para a proxima requisicao que pegar a mesma
 * conexao do pool. Por isso a marca vive no Postgres e nao no processo Node: e
 * exatamente o escopo da transacao que interessa.
 *
 * Precisa de transacao interativa: `SET LOCAL` fora de transacao nao faz nada, e
 * silenciosamente — o trigger dispararia e o laco voltaria.
 */
export async function comoReplicacao(tx: Tx): Promise<void> {
  await tx.$executeRawUnsafe(`SET LOCAL sincronizacao.replicando = 'on'`);
}

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Coloca um registro sob sincronizacao.
   *
   * O evento inicial e inserido AQUI, na mao, e nao pelo trigger: vincular nao
   * altera o registro, entao nenhum trigger dispara. Sem este empurrao o
   * registro so chegaria ao outro lado na proxima vez que alguem o editasse — e
   * ate la o botao teria dito "compartilhado" sem nada ter atravessado.
   */
  async vincular(recurso: Recurso, registroId: string, porQuem?: string): Promise<void> {
    const id = registroId?.trim();
    if (!id) throw new BadRequestException('id vazio');

    await this.prisma.$transaction(async tx => {
      // A cadeia inteira numa transacao so: se vincular a planta e falhar no
      // equipamento, metade compartilhada seria pior do que nada — o outro lado
      // ficaria com um cadastro que ninguem pediu e sem o que motivou o pedido.
      const cadeia = await resolverCadeia(tx, recurso, id);

      // Do mais basico ao mais especifico. Ordem trocada faz o receptor recusar
      // por dependencia ausente e reprocessar por backoff — funciona, mas gasta
      // um ciclo a toa e suja a auditoria com uma recusa evitavel.
      for (const elo of cadeia.faltando) {
        await this.vincularUm(tx, elo.recurso, elo.registro_id, porQuem);
      }
      await this.vincularUm(tx, recurso, id, porQuem);

      if (cadeia.faltando.length) {
        this.logger.log(
          `vinculado: ${recurso}/${id} + ${cadeia.faltando.length} dependencia(s) — ` +
          cadeia.faltando.map(e => `${e.recurso}/${e.registro_id}`).join(', '),
        );
      } else {
        this.logger.log(`vinculado: ${recurso}/${id}`);
      }
    });
  }

  /** Um elo da cadeia. Sempre dentro da transacao de `vincular`. */
  private async vincularUm(
    tx: Tx,
    recurso: Recurso,
    id: string,
    porQuem?: string,
  ): Promise<void> {
    const existe = await (tx as any)[recurso].findUnique({ where: { id }, select: { id: true } });
    if (!existe) throw new BadRequestException(`${recurso} ${id} não existe`);

    const vinculo = await tx.sincronizacao_vinculos.upsert({
      where: { recurso_registro_id: { recurso, registro_id: id } },
      create: { recurso, registro_id: id, origem: await this.origem(tx), vinculado_por: porQuem?.trim(), ativo: true },
      // Revincular NAO zera a versao. Se o outro lado ainda tem memoria deste
      // registro, uma versao menor que a de la seria descartada por versao e o
      // vinculo pareceria quebrado sem motivo visivel.
      update: { ativo: true, vinculado_por: porQuem?.trim() },
    });

    const versao = vinculo.versao + 1n;
    await tx.sincronizacao_vinculos.update({ where: { id: vinculo.id }, data: { versao } });

    await tx.sincronizacao_outbox.create({
      // Payload vazio de proposito: quem monta e o worker, na hora de enviar,
      // lendo a linha atual. Assim a lista do que nunca viaja fica num lugar
      // so e o envio leva o estado de agora, nao uma foto do clique.
      data: { recurso, registro_id: id, operacao: 'upsert', versao, payload: {} },
    });
  }

  /**
   * Para de sincronizar, sem apagar nada do outro lado.
   *
   * Desvincular nao e excluir. O que ja foi entregue continua la: apagar a
   * partir de um botao que o usuario leu como "parar de compartilhar" seria
   * destrutivo, irreversivel e surpreendente.
   */
  async desvincular(recurso: Recurso, registroId: string): Promise<void> {
    const id = registroId?.trim();
    await this.prisma.sincronizacao_vinculos.updateMany({
      where: { recurso, registro_id: id },
      data: { ativo: false },
    });
    this.logger.log(`desvinculado: ${recurso}/${id}`);
  }

  private async origem(tx: Tx): Promise<string> {
    const no = await tx.sincronizacao_no.findFirst({ select: { origem: true } });
    if (!no) throw new Error('sincronizacao_no vazia: este servidor nao sabe o proprio nome');
    return no.origem;
  }
}
