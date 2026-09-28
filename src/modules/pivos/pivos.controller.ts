import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Permissions } from '@/core';
import { PivosService } from './pivos.service';
import { PivoConfigDto, ProgramacaoPivoDto } from './dto/pivos.dto';

/**
 * Pivô (apps NexON v2). Leitura: escopo do equipamento/unidade. Escrita: quem
 * comanda (equipamentos.acionar_ponto) ou gerencia (equipamentos.manage), e o
 * operador com permissão por instalação precisa de "comandar" nela.
 *
 * Programações são SÓ armazenadas — o servidor não executa nada sozinho.
 */
@ApiTags('Pivôs')
@ApiBearerAuth()
@Controller('pivos')
export class PivosController {
  constructor(private readonly service: PivosService) {}

  @Get('unidade/:unidadeId/conjugados')
  @ApiOperation({ summary: 'Sistemas conjugados da instalação (motobomba compartilhada por 2+ pivôs)' })
  conjugados(@Param('unidadeId') unidadeId: string, @CurrentUser() user?: any) {
    return this.service.conjugados(unidadeId, user);
  }

  @Get(':id/config')
  @ApiOperation({ summary: 'Configuração do pivô (bloqueio de ponta, horário reservado, origem da ponta)' })
  getConfig(@Param('id') id: string, @CurrentUser() user?: any) {
    return this.service.getConfig(id, user);
  }

  @Put(':id/config')
  @Permissions('equipamentos.acionar_ponto', 'equipamentos.manage')
  @ApiOperation({ summary: 'Grava a configuração do pivô (parcial)' })
  putConfig(@Param('id') id: string, @Body() dto: PivoConfigDto, @CurrentUser() user?: any) {
    return this.service.putConfig(id, dto, user);
  }

  @Get(':id/programacoes')
  @ApiOperation({ summary: 'Programações salvas do pivô (não são executadas pelo servidor)' })
  listar(@Param('id') id: string, @CurrentUser() user?: any) {
    return this.service.listarProgramacoes(id, user);
  }

  @Post(':id/programacoes')
  @Permissions('equipamentos.acionar_ponto', 'equipamentos.manage')
  @ApiOperation({ summary: 'Cria programação' })
  criar(@Param('id') id: string, @Body() dto: ProgramacaoPivoDto, @CurrentUser() user?: any) {
    return this.service.criarProgramacao(id, dto, user);
  }

  @Put(':id/programacoes/:progId')
  @Permissions('equipamentos.acionar_ponto', 'equipamentos.manage')
  @ApiOperation({ summary: 'Atualiza programação' })
  atualizar(
    @Param('id') id: string,
    @Param('progId') progId: string,
    @Body() dto: ProgramacaoPivoDto,
    @CurrentUser() user?: any,
  ) {
    return this.service.atualizarProgramacao(id, progId, dto, user);
  }

  @Delete(':id/programacoes/:progId')
  @HttpCode(HttpStatus.OK)
  @Permissions('equipamentos.acionar_ponto', 'equipamentos.manage')
  @ApiOperation({ summary: 'Remove programação' })
  remover(@Param('id') id: string, @Param('progId') progId: string, @CurrentUser() user?: any) {
    return this.service.removerProgramacao(id, progId, user);
  }
}
