import { Global, Module } from '@nestjs/common';
import { PermissionScopeService } from './permission-scope.service';
import { PlantaScopeGuard } from './guards/planta-scope.guard';

/**
 * Exporta `PermissionScopeService` e `PlantaScopeGuard` globalmente para qualquer
 * modulo injetar sem precisar importar AuthModule (evita dependencia circular).
 *
 * O guard NAO eh registrado como APP_GUARD aqui de proposito: cada consumer decide
 * se aplica globalmente (via `useGlobalGuards` ou APP_GUARD) ou por controller/handler.
 */
@Global()
@Module({
  providers: [PermissionScopeService, PlantaScopeGuard],
  exports: [PermissionScopeService, PlantaScopeGuard],
})
export class PermissionScopeModule {}
