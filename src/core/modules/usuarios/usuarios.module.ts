import { Module } from '@nestjs/common';
import { UsuariosController } from './usuarios.controller';
import { UsuariosService } from './usuarios.service';
import { RolesService } from '../roles/roles.service';
import { PermissionsService } from '../permissions/permissions.service';
import { PrismaService } from '../../prisma/prisma.service';

@Module({
  controllers: [UsuariosController],
  providers: [
    UsuariosService, 
    RolesService, 
    PermissionsService, 
    PrismaService
  ],
  exports: [UsuariosService]
})
export class UsuariosModule {}
