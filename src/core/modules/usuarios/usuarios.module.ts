import { Module } from '@nestjs/common';
import { UsuariosController } from './usuarios.controller';
import { UsuariosAppController } from './conta-app.controller';
import { UsuariosService } from './usuarios.service';
import { ContaService } from './conta.service';
import { OperadoresService } from './operadores.service';
import { AuditoriaAcessosService } from './auditoria-acessos.service';
import { NotificacoesPushService } from './notificacoes-push.service';
import { VinculosOperadorController } from './vinculos-operador.controller';
import { AuditoriaAcessosController } from './auditoria-acessos.controller';
import { VinculosOperadorService } from './vinculos-operador.service';
import { RolesService } from '../roles/roles.service';
import { PermissionsService } from '../permissions/permissions.service';
import { PrismaService } from '../../prisma/prisma.service';

@Module({
  // UsuariosAppController PRIMEIRO: suas rotas estáticas (me, operadores,
  // convites) têm de ser registradas antes de /usuarios/:id.
  controllers: [UsuariosAppController, VinculosOperadorController, AuditoriaAcessosController, UsuariosController],
  providers: [
    UsuariosService, 
    RolesService, 
    PermissionsService, 
    PrismaService,
    ContaService,
    OperadoresService,
    AuditoriaAcessosService,
    NotificacoesPushService,
    VinculosOperadorService,
  ],
  exports: [UsuariosService, AuditoriaAcessosService, NotificacoesPushService, VinculosOperadorService]
})
export class UsuariosModule {}
