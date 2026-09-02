import { Body, Controller, Delete, ForbiddenException, Get, Param, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { PlantaOperadoresService } from './planta-operadores.service';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@ApiTags('plantas-operadores')
@Controller()
export class PlantaOperadoresController {
  constructor(private readonly service: PlantaOperadoresService) {}

  /**
   * Mirror: lista plantas onde o usuario figura como operador.
   * Admin-like le qualquer um; outros so leem o proprio.
   */
  @Get('usuarios/:usuarioId/plantas-operadas')
  @ApiOperation({ summary: 'Listar plantas onde o usuario eh operador' })
  @ApiParam({ name: 'usuarioId', description: 'ID do usuario' })
  async listByOperador(@Param('usuarioId') usuarioId: string, @CurrentUser() user?: any) {
    const role = user?.role;
    const isAdminLike = ['analista', 'gerente', 'admin', 'super_admin'].includes(role ?? '');
    const isSelf = user?.id?.trim() === usuarioId.trim();
    if (!isAdminLike && !isSelf) {
      throw new ForbiddenException('Voce so pode consultar suas proprias plantas');
    }
    return this.service.listByOperador(usuarioId);
  }

  @Get('plantas/:plantaId/operadores')
  @Permissions('plantas.manage_operadores')
  @ApiOperation({ summary: 'Listar operadores vinculados a uma planta' })
  @ApiParam({ name: 'plantaId', description: 'ID da planta' })
  async list(@Param('plantaId') plantaId: string, @CurrentUser() user?: any) {
    return this.service.list(plantaId, user);
  }

  @Post('plantas/:plantaId/operadores')
  @Permissions('plantas.manage_operadores')
  @ApiOperation({ summary: 'Vincular um operador a uma planta' })
  @ApiParam({ name: 'plantaId', description: 'ID da planta' })
  async add(
    @Param('plantaId') plantaId: string,
    @Body() body: { usuario_id: string },
    @CurrentUser() user?: any,
  ) {
    return this.service.add(plantaId, body.usuario_id, user);
  }

  @Delete('plantas/:plantaId/operadores/:usuarioId')
  @Permissions('plantas.manage_operadores')
  @ApiOperation({ summary: 'Desvincular um operador de uma planta' })
  @ApiParam({ name: 'plantaId', description: 'ID da planta' })
  @ApiParam({ name: 'usuarioId', description: 'ID do usuario operador' })
  async remove(
    @Param('plantaId') plantaId: string,
    @Param('usuarioId') usuarioId: string,
    @CurrentUser() user?: any,
  ) {
    return this.service.remove(plantaId, usuarioId, user);
  }
}
