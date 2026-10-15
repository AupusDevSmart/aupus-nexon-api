import { Global, Module } from '@nestjs/common';
import { PermissionScopeService } from './permission-scope.service';
import { PlantaScopeGuard } from './guards/planta-scope.guard';
import { AuditoriaAcessosService } from '../usuarios/auditoria-acessos.service';
import { ExportacaoAuditoriaService } from '../usuarios/exportacao-auditoria.service';

/**
 * Exporta `PermissionScopeService` e `PlantaScopeGuard` globalmente para qualquer
 * modulo injetar sem precisar importar AuthModule (evita dependencia circular).
 * Tambem exporta `ExportacaoAuditoriaService` (trilha de exports), que anda junto
 * com o escopo em todo endpoint que entrega dados para fora.
 *
 * O guard NAO eh registrado como APP_GUARD aqui de proposito: cada consumer decide
 * se aplica globalmente (via `useGlobalGuards` ou APP_GUARD) ou por controller/handler.
 */
@Global()
@Module({
  providers: [PermissionScopeService, PlantaScopeGuard, AuditoriaAcessosService, ExportacaoAuditoriaService],
  exports: [PermissionScopeService, PlantaScopeGuard, AuditoriaAcessosService, ExportacaoAuditoriaService],
})
export class PermissionScopeModule {}
