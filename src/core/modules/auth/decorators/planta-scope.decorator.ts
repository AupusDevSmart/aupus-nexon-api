import { SetMetadata } from '@nestjs/common';
import type { ScopedEntityType } from '../permission-scope.service';

export const PLANTA_SCOPE_KEY = 'planta_scope';

export interface PlantaScopeMetadata {
  /** Tipo da entidade a validar contra planta_operadores / proprietario_id */
  entity: ScopedEntityType;
  /** Onde achar o id da entidade no request (default: param) */
  from?: 'param' | 'body' | 'query';
  /** Nome do campo/param onde o id esta (default: 'id') */
  name?: string;
}

/**
 * Marca um handler para validar que a entidade alvo esta no escopo do usuario logado.
 * O `PlantaScopeGuard` (registrado na cadeia depois do JwtAuthGuard) le esse metadado
 * e chama `PermissionScopeService.assertEntityInScope` antes do handler executar.
 *
 * Uso:
 *   @Get(':id')
 *   @UsePlantaScope({ entity: 'equipamento' })            // le params.id
 *   findOne(@Param('id') id: string) { ... }
 *
 *   @Patch(':equipamentoId/comando')
 *   @UsePlantaScope({ entity: 'equipamento', name: 'equipamentoId' })
 *   command(...) { ... }
 *
 *   @Post()
 *   @UsePlantaScope({ entity: 'planta', from: 'body', name: 'planta_id' })
 *   createUnidade(@Body() body: { planta_id: string; ... }) { ... }
 */
export const UsePlantaScope = (meta: PlantaScopeMetadata) =>
  SetMetadata(PLANTA_SCOPE_KEY, meta);
