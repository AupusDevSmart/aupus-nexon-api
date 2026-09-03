import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { comoReplicacao } from './outbox.service';
import { DEPENDENCIAS, Recurso, filtrarParaEsteBanco } from './recursos';
import { aoReceber } from './transformacoes';

export interface EventoRecebido {
  recurso: Recurso;
  registro_id: string;
  operacao: 'upsert' | 'delete';
  versao: string;
  origem: string;
  payload: Record<string, any>;
  ator?: string;
}

export type Resultado =
  | 'aplicado'
  | 'ignorado_versao'
  | 'ignorado_duplicado'
  | 'dependencia_ausente';

@Injectable()
export class SincronizacaoService {
  private readonly logger = new Logger(SincronizacaoService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Aplica um evento vindo do outro produto.
   *
   * Idempotente de proposito: o worker do outro lado reenvia quando nao tem
   * certeza de que a entrega chegou, e reentregar tem de ser inofensivo. Um
   * evento que ja foi aplicado volta como `ignorado_duplicado`, nao como erro —
   * senao a fila do remetente travaria numa entrega que na verdade deu certo.
   */
  async aplicar(evento: EventoRecebido): Promise<{ resultado: Resultado; detalhe?: string }> {
    const { recurso, operacao } = evento;
    const id = evento.registro_id?.trim();
    const versaoRecebida = BigInt(evento.versao);

    if (!id) throw new BadRequestException('registro_id vazio');

    return this.prisma.$transaction(async tx => {
      // Antes de qualquer escrita: o que este metodo grava NAO pode virar evento
      // de volta, senao os dois lados ficam se empurrando o mesmo registro para
      // sempre. Vale ate o fim desta transacao e some sozinho.
      await comoReplicacao(tx);

      const vinculo = await tx.sincronizacao_vinculos.findUnique({
        where: { recurso_registro_id: { recurso, registro_id: id } },
      });

      if (vinculo) {
        const decisao = this.quemVence(
          { versao: vinculo.versao, origem: vinculo.origem },
          { versao: versaoRecebida, origem: evento.origem },
        );

        if (decisao === 'duplicado') {
          await this.auditar(tx, evento, 'ignorado_duplicado');
          return { resultado: 'ignorado_duplicado' as const };
        }
        if (decisao === 'local') {
          // A unica marca que sobra de uma edicao descartada. Sem ela ninguem
          // responde "por que minha alteracao sumiu" — e com sincronizacao
          // bidirecional essa pergunta vai aparecer.
          await this.auditar(tx, evento, 'ignorado_versao',
            `versao local ${vinculo.versao} (${vinculo.origem}) venceu a recebida ${versaoRecebida} (${evento.origem})`);
          return { resultado: 'ignorado_versao' as const };
        }
      }

      if (operacao === 'delete') {
        await (tx as any)[recurso].updateMany({ where: { id }, data: { deleted_at: new Date() } });
      } else {
        const faltando = await this.dependenciaAusente(tx, recurso, evento.payload);
        if (faltando) {
          await this.auditar(tx, evento, 'dependencia_ausente', faltando);
          return { resultado: 'dependencia_ausente' as const, detalhe: faltando };
        }

        const { dados, ignorados } = filtrarParaEsteBanco(recurso, evento.payload);
        delete dados.id;

        await (tx as any)[recurso].upsert({
          where: { id },
          create: { ...dados, id },
          update: dados,
        });
        await aoReceber(tx, recurso, id, evento.payload);

        if (ignorados.length) {
          this.logger.debug(`${recurso}/${id}: campos ignorados — ${ignorados.join(', ')}`);
        }
      }

      const hash = createHash('sha256').update(JSON.stringify(evento.payload)).digest('hex');
      await tx.sincronizacao_vinculos.upsert({
        where: { recurso_registro_id: { recurso, registro_id: id } },
        create: {
          recurso, registro_id: id, versao: versaoRecebida,
          origem: evento.origem, hash_conteudo: hash, ativo: true,
        },
        update: {
          versao: versaoRecebida, origem: evento.origem,
          hash_conteudo: hash, ativo: true, atualizado_em: new Date(),
        },
      });

      await this.auditar(tx, evento, 'aplicado');
      return { resultado: 'aplicado' as const };
    });
  }

  /**
   * Quem fica com o registro quando os dois lados o editaram.
   *
   * Versao maior vence. O empate desempata pelo NOME DA ORIGEM, e isso e o que
   * faz a coisa toda convergir: a regra e a mesma nos dois lados e nao depende
   * de relogio nem de quem falou primeiro, entao os dois nos chegam sozinhos ao
   * mesmo vencedor sem precisar combinar nada.
   *
   * Relogio nao serve aqui, e nao e teoria: as 9 plantas de dev estao com
   * `updated_at` NULL, porque `plantas` e `usuarios` nao tem `@updatedAt`. E as
   * 4 tabelas sao `Timestamp(0)`, precisao de segundo.
   *
   * O preco e honesto: uma das duas edicoes se perde. Por isso a perdedora vai
   * para a auditoria e a tela mostra o conflito.
   */
  private quemVence(
    local: { versao: bigint; origem: string },
    recebido: { versao: bigint; origem: string },
  ): 'local' | 'recebido' | 'duplicado' {
    if (recebido.versao > local.versao) return 'recebido';
    if (recebido.versao < local.versao) return 'local';
    if (recebido.origem === local.origem) return 'duplicado';
    return recebido.origem > local.origem ? 'recebido' : 'local';
  }

  /**
   * Confere se o registro tem onde se apoiar deste lado.
   *
   * Recusa em vez de arrastar junto o que falta: um evento de equipamento que
   * silenciosamente criasse a instalacao, a planta e o usuario dono seria uma
   * copia de cadastro inteiro disparada por uma edicao de nome.
   */
  private async dependenciaAusente(
    tx: any,
    recurso: Recurso,
    payload: Record<string, any>,
  ): Promise<string | null> {
    for (const dep of DEPENDENCIAS[recurso]) {
      const alvo = payload[dep.campo]?.trim?.();
      if (!alvo) continue;

      const existe = await tx[dep.tabela].findFirst({ where: { id: alvo }, select: { id: true } });
      if (!existe) return `${dep.comoChamar} (${dep.campo}=${alvo}) não existe neste sistema`;
    }
    return null;
  }

  private async auditar(tx: any, e: EventoRecebido, resultado: Resultado, detalhe?: string) {
    await tx.sincronizacao_auditoria.create({
      data: {
        direcao: 'recebido',
        recurso: e.recurso,
        registro_id: e.registro_id.trim(),
        versao: BigInt(e.versao),
        origem: e.origem,
        resultado,
        detalhe,
        ator: e.ator,
      },
    });
  }

  /** Estado de sincronizacao de varios registros, para a tela mostrar em lote. */
  async estado(recurso: Recurso, ids: string[]) {
    const limpos = [...new Set(ids.map(i => i?.trim()).filter(Boolean))];
    if (!limpos.length) return [];

    const vinculos = await this.prisma.sincronizacao_vinculos.findMany({
      where: { recurso, registro_id: { in: limpos } },
      select: { registro_id: true, ativo: true, versao: true, origem: true, atualizado_em: true },
    });

    const pendentes = await this.prisma.sincronizacao_outbox.groupBy({
      by: ['registro_id'],
      where: { recurso, registro_id: { in: limpos }, entregue_em: null },
      _count: { _all: true },
      _max: { tentativas: true },
    });
    const porId = new Map(pendentes.map(p => [p.registro_id, p]));

    return limpos.map(id => {
      const v = vinculos.find(x => x.registro_id === id);
      const p = porId.get(id);
      return {
        registro_id: id,
        compartilhado: !!v?.ativo,
        versao: v ? Number(v.versao) : 0,
        origem: v?.origem ?? null,
        atualizado_em: v?.atualizado_em ?? null,
        pendentes: p?._count._all ?? 0,
        // Uma entrega que ja falhou varias vezes nao e "esperando", e um
        // problema — e a tela precisa poder dizer isso.
        com_erro: (p?._max.tentativas ?? 0) >= 3,
      };
    });
  }
}
