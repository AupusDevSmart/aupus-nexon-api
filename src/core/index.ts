// Modulos NestJS compartilhados entre AupusNexOn-API e AupusService-API
// Re-exports adicionados conforme cada modulo for migrado.

// Common (interceptors, guards, decorators, filters)
export * from './common';

// Prisma
export * from './prisma';
// Re-exporta tipos e enums gerados pelo Prisma Client (Prisma, StatusAnomalia, etc.)
// Consumers nao precisam mais de schema.prisma proprio - pegam tudo daqui.
export * from '@prisma/client';

// Mail
export * from './mail';

// Modulos de dominio
export * from './modules/auth';
export * from './modules/roles';
export * from './modules/permissions';
export * from './modules/usuarios';
export * from './modules/plantas';
export * from './modules/planta-operadores';
export * from './modules/unidades';
export * from './modules/equipamentos';
export * from './modules/sincronizacao';
export * from './modules/categorias-equipamentos';
export * from './modules/tipos-equipamentos';
export * from './modules/concessionarias';
