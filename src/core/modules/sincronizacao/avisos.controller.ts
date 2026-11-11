import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { CurrentUser, Permissions } from '@/core';
import { SincronizacaoService } from './sincronizacao.service';
import type { Decisao } from './avisos-de-exclusao';

export class DecisaoDoAvisoDto {
  @IsIn(['apagar', 'manter'], { message: 'A decisão é "apagar" ou "manter".' })
  decisao!: Decisao;
}

/**
 * A exclusão feita no outro produto, que aqui chega como aviso (10/11/2026).
 * A permissão é a de gerenciar o compartilhamento: decidir apagar aqui o que
 * foi apagado lá é decisão sobre o que os dois produtos dividem.
 */
@ApiTags('Sincronização')
@Controller('sincronizacao/exclusoes')
export class AvisosDeExclusaoController {
  constructor(private readonly service: SincronizacaoService) {}

  @Get()
  @Permissions('sincronizacao.gerenciar')
  @ApiOperation({
    summary: 'Exclusões feitas no outro produto, esperando decisão',
    description:
      'O registro continua aqui e deixou de ser compartilhado. Cada aviso pede "apagar aqui também" ou "manter só aqui". ' +
      'Só os de cima: o aviso da instalação de uma planta que também tem aviso vai junto com ela (`abaixo`).',
  })
  listar() {
    return this.service.listarAvisosDeExclusao();
  }

  @Get(':id/alcance')
  @Permissions('sincronizacao.gerenciar')
  @ApiOperation({
    summary: 'O que "apagar aqui também" leva junto',
    description: 'As instalações e os equipamentos vivos debaixo do registro, e quantos deles não foram apagados no outro produto.',
  })
  alcance(@Param('id') id: string) {
    return this.service.alcanceDoAvisoDeExclusao(id.trim());
  }

  @Post(':id/decisao')
  @Permissions('sincronizacao.gerenciar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Decide um aviso de exclusão',
    description:
      '"apagar" apaga aqui também, com o que fica debaixo (a planta leva as instalações e os equipamentos). ' +
      '"manter" deixa só aqui, também o que fica debaixo. Os avisos do que fica debaixo se fecham com a mesma decisão.',
  })
  decidir(@Param('id') id: string, @Body() dto: DecisaoDoAvisoDto, @CurrentUser() user?: { id?: string }) {
    return this.service.decidirAvisoDeExclusao(id.trim(), dto.decisao, user?.id ?? null);
  }
}

/** A saúde da fila, para a tela de admin e o smoke do deploy (10/11/2026) */
@ApiTags('Sincronização')
@Controller('sincronizacao/saude')
export class SaudeDaSincronizacaoController {
  constructor(private readonly service: SincronizacaoService) {}

  @Get()
  @Permissions('sincronizacao.gerenciar')
  @ApiOperation({
    summary: 'Saúde da sincronização',
    description: 'Pendentes, o mais antigo, o que já falhou 3 vezes ou mais, a última entrega, os avisos de exclusão e o ping do outro lado.',
  })
  saude() {
    return this.service.saude();
  }
}
