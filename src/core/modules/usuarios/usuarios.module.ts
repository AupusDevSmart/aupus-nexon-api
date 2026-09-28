import { Module } from '@nestjs/common';
import { UsuariosController } from './usuarios.controller';
import { UsuariosAppController } from './conta-app.controller';
import { UsuariosService } from './usuarios.service';
import { ContaService } from './conta.service';
import { OperadoresService } from './operadores.service';
import { AuditoriaAcessosService } from './auditoria-acessos.service';
import { NotificacoesPushService } from './notificacoes-push.service';
import { RolesService } from '../roles/roles.service';
import { PermissionsService } from '../permissions/permissions.service';
import { PrismaService } from '../../prisma/prisma.service';

@Module({
  // UsuariosAppController PRIMEIRO: suas rotas estáticas (me, operadores,
  // convites) têm de ser registradas antes de /usuarios/:id.
  controllers: [UsuariosAppController, UsuariosController],
  providers: [
    UsuariosService, 
    RolesService, 
    PermissionsService, 
    PrismaService,
    ContaService,
    OperadoresService,
    AuditoriaAcessosService,
    NotificacoesPushService,
  ],
  exports: [UsuariosService, AuditoriaAcessosService, NotificacoesPushService]
})
export class UsuariosModule {}
