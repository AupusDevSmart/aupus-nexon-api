import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EQUIPAMENTO_MQTT_CHANGED, type EquipamentoMqttChangedPayload } from '../equipamentos/events/equipamento-mqtt.events';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { comoReplicacao, OPERACAO_DESVINCULO, OPERACAO_RESTAURO, OPERACAO_VINCULO, OPERACOES, type Operacao } from './outbox.service';
import {
  alcanceDoAviso, decidirAviso, estadoLocal, fecharAvisoRestaurado, listarAvisos, receberDesvinculo, receberExclusao, receberRestauro,
  type AlcanceDoAviso, type Decisao, type ListaDeAvisos,
} from './avisos-de-exclusao';
import { compartilhadosNaCascata, type CompartilhadosNaCascata } from './arvore';
import { saudeDaSincronizacao, type SaudeDaSincronizacao } from './saude';
import { DEPENDENCIAS, Recurso, filtrarParaEsteBanco } from './recursos';
import { aoReceber } from './transformacoes';
import { resolverCadeia } from './cadeia-de-dependencias';

export interface EventoRecebido {
  recurso: Recurso;
  registro_id: string;
  operacao: Operacao;
  versao: string;
  origem: string;
  payload: Record<string, any>;
  ator?: string;
  /** Quando o evento nasceu do outro lado (a hora da exclusão, no aviso); o remetente antigo não manda */
  criado_em?: string;
}

export type Resultado =
  | 'aplicado'
  | 'ignorado_versao'
  | 'ignorado_duplicado'
  | 'dependencia_ausente'
  // O vínculo está desligado aqui: o evento não grava nem religa (09/11/2026)
  | 'ignorado_desvinculado'
  // Exclusão recebida: o registro fica e o vínculo se desliga (09/11/2026)
  | 'exclusao_nao_aplicada'
  // O outro lado parou de compartilhar: o vínculo daqui se desligou, o dado fica (10/11/2026)
  | 'desvinculado'
  // Compartilhado de novo lá, e aqui o registro está apagado: não religa (10/11/2026)
  | 'recusado_apagado'
  // Restaurado lá: o aviso de exclusão daqui se fecha (10/11/2026)
  | 'restauro_recebido';

/**
 * O que o outro produto respondeu e quer dizer "não chegou", para o selo da tela
 * de quem mandou (10/11/2026). O remetente marca esses eventos como entregues (não
 * adianta repetir), e antes nada mostrava: o selo dizia "compartilhado".
 */
const RECUSAS: Partial<Record<Resultado, string>> = {
  ignorado_desvinculado: 'lá este registro deixou de ser compartilhado',
  recusado_apagado: 'lá este registro está apagado',
};

/** O `ator` vai para colunas de 255 */
const ator = (e: { ator?: string }) => e.ator?.trim().slice(0, 255) || null;

/** O instante que veio no evento, ou nulo se não veio ou não se lê */
function dataOuNulo(iso?: string): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

@Injectable()
export class SincronizacaoService {
  private readonly logger = new Logger(SincronizacaoService.name);

  constructor(
    private readonly prisma: PrismaService,
    // O mesmo aviso da tela ao apagar equipamento: o MQTT deixa de ouvir o tópico dele
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

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
    // Operação desconhecida é recusada (o remetente tenta de novo). Antes, tudo o que
    // não era 'delete' caía no upsert: uma operação nova mandada a um receptor antigo
    // regravaria o dado em vez de fazer o que ela diz
    if (!(OPERACOES as readonly string[]).includes(operacao)) {
      throw new BadRequestException(`operação desconhecida: ${String(operacao)}`);
    }

    return this.prisma.$transaction(async tx => {
      // Antes de qualquer escrita: o que este metodo grava NAO pode virar evento
      // de volta, senao os dois lados ficam se empurrando o mesmo registro para
      // sempre. Vale ate o fim desta transacao e some sozinho.
      await comoReplicacao(tx);

      const vinculo = await tx.sincronizacao_vinculos.findUnique({
        where: { recurso_registro_id: { recurso, registro_id: id } },
      });

      // Restaurado lá: só fecha o aviso daqui, que dizia "apagado lá" (o vínculo
      // continua como está). Antes do portão: o vínculo daqui se desligou com a exclusão
      if (operacao === OPERACAO_RESTAURO) {
        const { detalhe } = await receberRestauro(tx, { recurso, id });
        await this.auditar(tx, evento, 'restauro_recebido', detalhe);
        return { resultado: 'restauro_recebido' as const, detalhe };
      }

      // Compartilhado lá (o botão) com o vínculo daqui desligado, ou sem vínculo: religa
      // e grava o que veio, sem o desempate por versão (a versão daqui é de antes de
      // parar de compartilhar). Antes de 10/11 o compartilhar ia como upsert, e
      // compartilhar de novo depois de parar não atravessava nunca mais.
      const religar = operacao === OPERACAO_VINCULO && !vinculo?.ativo;

      // Vínculo desligado aqui é decisão (09/11/2026): o evento do outro lado não o
      // religa nem grava o dado. Antes, a próxima edição de lá desfazia o desvínculo
      // calada (18 unidades desvinculadas no Service voltaram a ativo em 07/11).
      // O remetente marca como entregue e não repete, e o selo de lá mostra a recusa.
      if (vinculo && !vinculo.ativo && !religar) {
        const detalhe = 'o vínculo está desligado neste produto';
        await this.auditar(tx, evento, 'ignorado_desvinculado', detalhe);
        return { resultado: 'ignorado_desvinculado' as const, detalhe };
      }

      // Exclusão e desvínculo vêm antes do desempate por versão: são decisões do
      // outro lado sobre o compartilhamento, e uma edição concorrente daqui não as
      // anula (a exclusão contra a edição virava "versão maior vence" e o registro
      // apagado ressuscitava, como a San German 01).
      if (operacao === 'delete') {
        // Exclusão não atravessa sozinha (09 e 10/11/2026): aqui o registro fica, o
        // vínculo se desliga e um aviso espera alguém decidir (avisos-de-exclusao.ts)
        const { detalhe } = await receberExclusao(tx, {
          recurso, id, origem: evento.origem,
          apagadoEm: dataOuNulo(evento.criado_em), apagadoPor: ator(evento),
          vinculoAtivo: !!vinculo,
        });
        await this.auditar(tx, evento, 'exclusao_nao_aplicada', detalhe);
        return { resultado: 'exclusao_nao_aplicada' as const, detalhe };
      }
      if (operacao === OPERACAO_DESVINCULO) {
        const { detalhe } = await receberDesvinculo(tx, { recurso, id, vinculoAtivo: !!vinculo });
        await this.auditar(tx, evento, 'desvinculado', detalhe);
        return { resultado: 'desvinculado' as const, detalhe };
      }

      // Apagado aqui, o upsert e o compartilhar não gravam: gravariam num registro escondido
      // e responderiam "aplicado" (o legado de antes de 10/11, apagado dos dois lados com o
      // vínculo ligado, restaurado de um lado só). Fica recusado, e o selo de lá diz por quê
      const local = await estadoLocal(tx, recurso, id);
      if (local.apagado) {
        const detalhe = 'este registro está apagado neste produto: compartilhar de novo pede restaurá-lo aqui';
        await this.auditar(tx, evento, 'recusado_apagado', detalhe);
        return { resultado: 'recusado_apagado' as const, detalhe };
      }

      if (vinculo && !religar) {
        const decisao = this.quemVence(
          { versao: vinculo.versao, origem: vinculo.origem },
          { versao: versaoRecebida, origem: evento.origem },
        );

        if (decisao === 'duplicado') {
          await this.auditar(tx, evento, 'ignorado_duplicado');
          return { resultado: 'ignorado_duplicado' as const };
        }
        if (decisao === 'local') {
          // O compartilhar de lá que perde para a versão daqui (o vínculo de lá ficou desligado
          // enquanto este editava) devolve a versão daqui: lá o compartilhar já valeu o conteúdo
          // de lá, e sem a volta os dois ficariam ligados com dados diferentes. À mão, porque a
          // replicação cala o trigger (10/11/2026)
          const devolve = operacao === OPERACAO_VINCULO;
          if (devolve) {
            await tx.sincronizacao_outbox.create({
              data: { recurso, registro_id: id, operacao: 'upsert', versao: vinculo.versao, payload: {} },
            });
          }
          // A unica marca que sobra de uma edicao descartada. Sem ela ninguem
          // responde "por que minha alteracao sumiu" — e com sincronizacao
          // bidirecional essa pergunta vai aparecer.
          await this.auditar(tx, evento, 'ignorado_versao',
            `versao local ${vinculo.versao} (${vinculo.origem}) venceu a recebida ${versaoRecebida} (${evento.origem})` +
              (devolve ? ': a versão daqui volta para lá' : ''));
          return { resultado: 'ignorado_versao' as const };
        }
      }

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

      const hash = createHash('sha256').update(JSON.stringify(evento.payload)).digest('hex');
      await tx.sincronizacao_vinculos.upsert({
        where: { recurso_registro_id: { recurso, registro_id: id } },
        create: {
          recurso, registro_id: id, versao: versaoRecebida,
          origem: evento.origem, hash_conteudo: hash, ativo: true,
        },
        // Só o compartilhar religa: fora dele, chegar aqui já exige o vínculo ligado (ou nenhum)
        update: {
          versao: versaoRecebida, origem: evento.origem,
          hash_conteudo: hash, atualizado_em: new Date(),
          ...(religar && { ativo: true }),
        },
      });
      // Compartilhado de novo lá: vivo lá, e o aviso de exclusão daqui (se houver) perdeu o sentido
      if (religar) await fecharAvisoRestaurado(tx, recurso, id);

      // O religar troca o conteúdo daqui pelo de lá: o que foi editado aqui com o vínculo
      // desligado se perde, e a auditoria diz de que versão veio o que foi trocado
      await this.auditar(tx, evento, 'aplicado',
        religar && vinculo
          ? `religado pelo compartilhar de lá: o conteúdo daqui (versão ${vinculo.versao}, ${vinculo.origem}) foi substituído`
          : undefined);
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
        ator: ator(e),
      },
    });
  }

  /**
   * O que atravessa junto com este registro, para a tela confirmar antes.
   *
   * So LE — nao vincula nada. Quem vincula e o `OutboxService`, depois do
   * usuario confirmar, e ele resolve a cadeia de novo por conta propria: entre
   * a previa e o clique alguem pode ter compartilhado a planta por outro
   * caminho, e a lista mostrada ficaria maior do que a realidade.
   */
  async previaDaCadeia(recurso: Recurso, registroId: string) {
    return resolverCadeia(this.prisma, recurso, registroId);
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

    // A última resposta do outro lado a um envio daqui: recusa vira aviso no selo
    const ultimas = await this.prisma.$queryRaw<{ registro_id: string; resultado: Resultado }[]>`
      SELECT u.id AS registro_id, a.resultado
        FROM unnest(${limpos}::text[]) AS u(id)
        CROSS JOIN LATERAL (
          SELECT resultado FROM sincronizacao_auditoria
           WHERE recurso = ${recurso} AND registro_id = u.id AND direcao = 'enviado'
           ORDER BY criado_em DESC, id DESC
           LIMIT 1
        ) a`;
    const recusaDe = new Map(ultimas.map((u) => [u.registro_id, RECUSAS[u.resultado] ?? null]));

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
        // O outro lado respondeu e não gravou (o porquê); some quando a próxima resposta for de aceite
        recusado: v?.ativo ? (recusaDe.get(id) ?? null) : null,
      };
    });
  }

  /** Os avisos de exclusão feita no outro produto, esperando decisão aqui (10/11/2026) */
  listarAvisosDeExclusao(): Promise<ListaDeAvisos> {
    return listarAvisos(this.prisma);
  }

  /** O que "apagar aqui também" leva junto, para a tela mostrar antes */
  alcanceDoAvisoDeExclusao(avisoId: string): Promise<AlcanceDoAviso> {
    return alcanceDoAviso(this.prisma, avisoId);
  }

  /**
   * Apagar aqui também, ou manter só aqui; fica na auditoria com quem decidiu. O
   * equipamento apagado sai do MQTT depois do commit, como na tela de equipamentos
   * (sem isto, o supervisório seguia inscrito no tópico dele até reiniciar)
   */
  async decidirAvisoDeExclusao(avisoId: string, decisao: Decisao, porQuem?: string | null): Promise<{ apagados: number; avisosFechados: number }> {
    const { apagados, equipamentosApagados, avisosFechados } = await this.prisma.$transaction(
      (tx) => decidirAviso(tx, avisoId, decisao, porQuem),
      { timeout: 30_000 },
    );
    await this.pararDeOuvir(equipamentosApagados);
    return { apagados, avisosFechados };
  }

  /**
   * O MQTT deixa de ouvir o equipamento apagado pelo aviso, como na tela. Depois
   * do commit e sem derrubar a resposta: a decisão já está gravada, e um 500 aqui
   * faria a tela dizer "não foi possível" de uma decisão feita (a nova tentativa
   * daria 409). O reconcile de 5 minutos do MQTT cobre o que falhar.
   */
  private async pararDeOuvir(equipamentos: string[]): Promise<void> {
    if (equipamentos.length === 0 || !this.eventEmitter) return;
    try {
      const comTopico = await this.prisma.$queryRaw<{ id: string; topico_mqtt: string | null }[]>`
        SELECT btrim(id) AS id, topico_mqtt FROM equipamentos WHERE btrim(id) = ANY(${equipamentos}::text[])`;
      for (const e of comTopico) {
        if (!e.topico_mqtt?.trim()) continue;
        const aviso: EquipamentoMqttChangedPayload = { equipamentoId: e.id, topicoAntigo: e.topico_mqtt.trim(), topicoNovo: null, habilitado: false };
        this.eventEmitter.emit(EQUIPAMENTO_MQTT_CHANGED, aviso);
      }
    } catch (e) {
      this.logger.error(`aviso de exclusão: MQTT não avisado de ${equipamentos.length} equipamento(s) apagado(s); o reconcile cobre`, e instanceof Error ? e.stack : String(e));
    }
  }

  /** A fila, o que travou e se o outro lado responde (a tela de admin e o smoke do deploy) */
  saude(): Promise<SaudeDaSincronizacao> {
    return saudeDaSincronizacao(this.prisma);
  }

  /** O que a exclusão deste registro alcançaria de compartilhado (o aviso da tela antes de excluir) */
  compartilhadosNaCascata(recurso: Recurso, id: string): Promise<CompartilhadosNaCascata> {
    return compartilhadosNaCascata(this.prisma, recurso, id);
  }
}
