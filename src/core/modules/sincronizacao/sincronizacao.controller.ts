import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Permissions, Public } from '@/core';
import { PrismaService } from '../../prisma/prisma.service';
import { OutboxService } from './outbox.service';
import { EventoRecebido, SincronizacaoService } from './sincronizacao.service';
import { TokenServicoGuard } from './token-servico.guard';
import { Recurso, ehRecurso } from './recursos';
import { BadRequestException } from '@nestjs/common';

/**
 * Recepcao: SO o outro backend fala aqui.
 *
 * Controller separado do de vinculos porque a autenticacao e outra. Guard de
 * maquina e guard de usuario no mesmo controller e como se cria rota
 * desprotegida sem querer — basta alguem mexer nos decorators.
 *
 * Fica fora do Swagger publico: e contrato interno entre os dois servidores, e
 * nao deve ser exposto pelo nginx.
 *
 * `@Public()` tira o JwtAuthGuard global do caminho — nao para abrir a rota, mas
 * porque quem bate aqui e o outro SERVIDOR e nao tem JWT de usuario nenhum. Quem
 * autentica e o `TokenServicoGuard` logo abaixo, que roda depois dos guards
 * globais e recusa sem o segredo. Sem o `@Public()` a rota devolveria 401 do
 * JWT antes de chegar nele, e o canal nunca funcionaria.
 */
@ApiExcludeController()
@Public()
@Controller('sincronizacao')
@UseGuards(TokenServicoGuard)
export class RecepcaoController {
  constructor(
    private readonly service: SincronizacaoService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('eventos')
  @HttpCode(HttpStatus.OK)
  async receber(@Body() evento: EventoRecebido) {
    if (!ehRecurso(evento?.recurso)) {
      throw new BadRequestException(`Recurso não sincronizável: ${evento?.recurso}`);
    }
    return this.service.aplicar(evento);
  }

  /**
   * Prova de vida do canal, para o deploy conferir sem escrever nada.
   *
   * A origem vem da TABELA, nao de variavel de ambiente. E a mesma fonte que o
   * trigger usa para carimbar o evento: se as duas discordassem, o ping diria
   * que esta tudo certo enquanto os eventos sairiam com o nome errado — e nome
   * errado e o que desempata conflito. Um ping que mente sobre com quem se esta
   * falando e pior do que nao ter ping.
   */
  @Get('ping')
  async ping() {
    const no = await this.prisma.sincronizacao_no.findFirst({ select: { origem: true } });
    return { ok: !!no, origem: no?.origem ?? null };
  }
}

/**
 * Vinculos: o que o usuario opera na tela.
 *
 * Compartilhar e uma decisao humana e pontual; depois dela a sincronizacao
 * segue sozinha. Por isso a permissao e propria (`sincronizacao.gerenciar`) e
 * nao herdada de "editar planta": quem pode corrigir o nome de uma planta nao
 * necessariamente pode publica-la no outro produto.
 */
@ApiTags('Sincronização')
@Controller('sincronizacao/vinculos')
export class VinculosController {
  constructor(
    private readonly outbox: OutboxService,
    private readonly service: SincronizacaoService,
  ) {}

  @Post(':recurso/:id')
  @Permissions('sincronizacao.gerenciar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Passa a compartilhar este registro com o outro produto',
    description:
      'A partir daqui as edições dos dois lados se propagam sozinhas. O primeiro ' +
      'evento leva o registro inteiro, porque o outro lado pode nunca tê-lo visto.',
  })
  @ApiResponse({ status: 200, description: 'Vinculado; a primeira entrega vai na próxima rodada do worker' })
  async vincular(
    @Param('recurso') recurso: string,
    @Param('id') id: string,
    @CurrentUser() user?: any,
  ) {
    return { ok: await this.comRecurso(recurso, r => this.outbox.vincular(r, id, user?.id)) };
  }

  @Delete(':recurso/:id')
  @Permissions('sincronizacao.gerenciar')
  @ApiOperation({
    summary: 'Para de compartilhar',
    description:
      'Corta o fluxo sem apagar nada do outro lado. O que já foi entregue continua ' +
      'lá: apagar a partir de um botão lido como "parar de compartilhar" seria ' +
      'destrutivo e irreversível.',
  })
  async desvincular(@Param('recurso') recurso: string, @Param('id') id: string) {
    return { ok: await this.comRecurso(recurso, r => this.outbox.desvincular(r, id)) };
  }

  @Get(':recurso')
  @ApiOperation({
    summary: 'Estado de sincronização de vários registros',
    description:
      'Em lote porque a tabela pergunta por página inteira. Sem isto o botão de ' +
      'compartilhar pode ser um no-op sem avisar, e botão que não diz o que fez ' +
      'vira desconfiança.',
  })
  async estado(@Param('recurso') recurso: string, @Query('ids') ids?: string) {
    const lista = (ids ?? '').split(',').map(s => s.trim()).filter(Boolean);
    return this.comRecurso(recurso, r => this.service.estado(r, lista));
  }

  private async comRecurso<T>(recurso: string, fn: (r: Recurso) => Promise<T>): Promise<T> {
    if (!ehRecurso(recurso)) {
      throw new BadRequestException(`Recurso não sincronizável: ${recurso}`);
    }
    return fn(recurso);
  }
}
