import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Recurso } from './recursos';
import { resolverCadeia } from './cadeia-de-dependencias';
import { comDescendentes } from './arvore';

/**
 * As operacoes que a fila leva. VARCHAR(10) na tabela: "desvincular" nao cabe.
 * Operacao nova: o RECEPTOR dos dois lados vai para producao antes do remetente
 * (o receptor antigo recusa o que nao conhece, desde 09/11/2026).
 *
 * - upsert: o registro mudou aqui (o trigger)
 * - delete: foi apagado aqui; la vira aviso (o trigger)
 * - desvinculo: parou de ser compartilhado aqui; la desliga o vinculo
 * - vinculo: foi compartilhado aqui (o botao). Religa o vinculo de la que estava
 *   desligado: sem ele, compartilhar de novo depois de parar nunca atravessava
 *   (la o upsert caia no vinculo desligado e a tela daqui dizia "compartilhado")
 * - restauro: voltou aqui depois de apagado (o trigger); la fecha o aviso
 */
export const OPERACAO_DESVINCULO = 'desvinculo';
export const OPERACAO_VINCULO = 'vinculo';
export const OPERACAO_RESTAURO = 'restauro';
export const OPERACOES = ['upsert', 'delete', OPERACAO_DESVINCULO, OPERACAO_VINCULO, OPERACAO_RESTAURO] as const;
export type Operacao = (typeof OPERACOES)[number];

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
      data: { recurso, registro_id: id, operacao: OPERACAO_VINCULO, versao, payload: {} },
    });
  }

  /**
   * Para de sincronizar, sem apagar nada de nenhum lado.
   *
   * Desvincular nao e excluir. O que ja foi entregue continua la: apagar a
   * partir de um botao que o usuario leu como "parar de compartilhar" seria
   * destrutivo, irreversivel e surpreendente.
   *
   * Vale para os DOIS lados e desce a hierarquia (10/11/2026). Antes so
   * desligava o vinculo daqui: o outro lado seguia mandando edicoes, que o
   * receptor daqui gravava e religava (18 das 40 instalacoes desvinculadas em
   * 26/10 voltaram a ativo assim), e os equipamentos da instalacao seguiam
   * compartilhados. Agora cada vinculo desligado vira um evento `desvinculo`,
   * que o outro lado aplica so no vinculo dele, sem tocar no dado.
   */
  async desvincular(recurso: Recurso, registroId: string): Promise<{ desligados: number }> {
    const id = registroId?.trim();
    if (!id) throw new BadRequestException('id vazio');

    const desligados = await this.prisma.$transaction(
      async (tx) => {
        const elos = await comDescendentes(tx, recurso, id, { soVivos: false });
        // Num comando so (a planta grande tem centenas de equipamentos): desliga o que
        // esta ligado, sobe a versao na mesma escrita (o trigger concorrente nao sai
        // com a mesma) e enfileira um desvinculo por vinculo desligado
        const linhas = await tx.$queryRaw<{ id: bigint }[]>`
          WITH alvo AS (
            SELECT * FROM unnest(${elos.map((e) => e.recurso)}::text[], ${elos.map((e) => e.registro_id)}::text[]) AS c(recurso, registro_id)
          ),
          desligados AS (
            UPDATE sincronizacao_vinculos v
               SET ativo = false, versao = v.versao + 1, atualizado_em = now()
              FROM alvo
             WHERE v.recurso = alvo.recurso AND v.registro_id = alvo.registro_id AND v.ativo
            RETURNING v.recurso, v.registro_id, v.versao
          )
          INSERT INTO sincronizacao_outbox (recurso, registro_id, operacao, versao, payload)
          SELECT recurso, registro_id, ${OPERACAO_DESVINCULO}, versao, '{}'::jsonb FROM desligados
          RETURNING id`;
        return linhas.length;
      },
      { timeout: 30_000 },
    );
    this.logger.log(`desvinculado: ${recurso}/${id} (${desligados} vinculo(s), com o que fica debaixo)`);
    return { desligados };
  }

  private async origem(tx: Tx): Promise<string> {
    const no = await tx.sincronizacao_no.findFirst({ select: { origem: true } });
    if (!no) throw new Error('sincronizacao_no vazia: este servidor nao sabe o proprio nome');
    return no.origem;
  }
}
