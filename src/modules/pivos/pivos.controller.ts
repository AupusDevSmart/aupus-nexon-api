import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Permissions, Cliente, ClienteInfo } from '@/core';
import { PivosService } from './pivos.service';
import { AcaoPivo, PivoSequenciaService } from './pivo-sequencia.service';
import { PivoConfigDto, ProgramacaoPivoDto } from './dto/pivos.dto';

/**
 * Pivô (apps NexON v2). Leitura: escopo do equipamento/unidade (operador: só o
 * equipamento liberado). Escrita: quem comanda (equipamentos.acionar_ponto) ou
 * gerencia (equipamentos.manage). Config técnica × operacional (NEXON-20, PER-33a):
 * lâmina, ponta, reservado e programações são de todos com acesso; pressão, tempo
 * de volta, ângulo zero, válvula, motobomba e bombeamento só Admin/analistas.
 *
 * Programações, início agendado, paradas e bloqueio de ponta são executados pelo
 * servidor (PivoAutomacaoService).
 */
@ApiTags('Pivôs')
@ApiBearerAuth()
@Controller('pivos')
export class PivosController {
  constructor(
    private readonly service: PivosService,
    private readonly sequencia: PivoSequenciaService,
  ) {}

  // ---------------------------------------------------- bombeamento + sequência
  @Get(':id/estado')
  @ApiOperation({ summary: 'Estado do pivô: status (BIs), bombeamento (BI da bomba, compartilhamento) e última sequência' })
  estado(@Param('id') id: string, @CurrentUser() user?: any) {
    return this.sequencia.estado(id, user);
  }

  @Post(':id/acionar')
  @HttpCode(HttpStatus.OK)
  @Permissions('equipamentos.acionar_ponto')
  @ApiOperation({ summary: 'Executa a sequência: girar_direita | girar_esquerda (liga bomba → pressão → gira) | desligar. `irrigacao` opcional: direção, %, sem água, canhão, parada e início (futuro = agenda).' })
  acionar(
    @Param('id') id: string,
    @Body() body: { acao: AcaoPivo; irrigacao?: unknown },
    @CurrentUser() user?: any,
    @Cliente() cliente?: ClienteInfo,
  ) {
    return this.sequencia.acionar(id, body?.acao, user, cliente, { irrigacao: body?.irrigacao });
  }

  @Get(':id/bombeamento/opcoes')
  @ApiOperation({ summary: 'TONs da planta e bombeamentos de outros pivôs (para configurar o bombeamento)' })
  opcoesBombeamento(@Param('id') id: string, @CurrentUser() user?: any) {
    return this.sequencia.opcoes(id, user);
  }

  @Put(':id/bombeamento')
  // equipamentos.comandar deixa entrar o analista de operação; o service exige
  // configuração técnica (proprietário/operador → 403 "Somente leitura").
  @Permissions('equipamentos.manage', 'equipamentos.comandar')
  @ApiOperation({ summary: 'Grava o bombeamento do pivô (TON, modo, BOs, BI) e os tempos da sequência' })
  salvarBombeamento(@Param('id') id: string, @Body() body: any, @CurrentUser() user?: any) {
    return this.sequencia.salvarConfig(id, body ?? {}, user);
  }

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
  @ApiOperation({ summary: 'Programações do pivô (o servidor liga no dia/hora e para pelo tempo ou percurso)' })
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
