import { Body, Controller, Delete, Get, Param, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { Cliente, ClienteInfo } from '../../common/cliente-info';
import { SalvarVinculoDto, VinculosOperadorService } from './vinculos-operador.service';

/**
 * Tela "Acesso do operador" (spec NEXON-20, 4.4): web `Usuários → [operador] →
 * aba Acesso`. O `/usuarios/:id/acesso` antigo (por instalação) é do app e fica.
 */
@ApiTags('Usuários')
@ApiBearerAuth()
@Controller('usuarios')
export class VinculosOperadorController {
  constructor(private readonly vinculos: VinculosOperadorService) {}

  @Get(':id/vinculos')
  @Permissions('usuarios.create_operador', 'usuarios.manage')
  @ApiOperation({ summary: 'Vínculos do operador (um por proprietário)' })
  listar(@Param('id') id: string, @CurrentUser() user: any) {
    return this.vinculos.listar(id, user);
  }

  @Get(':id/vinculos/arvore')
  @Permissions('usuarios.create_operador', 'usuarios.manage')
  @ApiOperation({ summary: 'Planta → instalação → equipamentos do proprietário, com o que o operador já tem' })
  arvore(@Param('id') id: string, @Query('proprietarioId') proprietarioId: string | undefined, @CurrentUser() user: any) {
    return this.vinculos.arvore(id, proprietarioId, user);
  }

  @Put(':id/vinculos')
  @Permissions('usuarios.create_operador', 'usuarios.manage')
  @ApiOperation({ summary: 'Grava o vínculo com um proprietário (lista vazia remove)' })
  salvar(@Param('id') id: string, @Body() dto: SalvarVinculoDto, @CurrentUser() user: any, @Cliente() cliente: ClienteInfo) {
    return this.vinculos.salvar(id, dto ?? {}, user, cliente?.dispositivo);
  }

  @Delete(':id/vinculos/:proprietarioId')
  @Permissions('usuarios.create_operador', 'usuarios.manage')
  @ApiOperation({ summary: 'Remove o vínculo com este proprietário; os outros continuam' })
  remover(
    @Param('id') id: string,
    @Param('proprietarioId') proprietarioId: string,
    @CurrentUser() user: any,
    @Cliente() cliente: ClienteInfo,
  ) {
    return this.vinculos.remover(id, proprietarioId, user, cliente?.dispositivo);
  }
}
