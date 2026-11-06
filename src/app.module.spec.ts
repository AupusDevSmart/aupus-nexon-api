import { MODULE_METADATA } from '@nestjs/common/constants';
import { AppModule } from './app.module';
import { SincronizacaoModule } from '@/core';

/**
 * O SincronizacaoModule saiu do AppModule por engano num commit de IoT
 * (b42774d, 16/09/2026): a rota /sincronizacao deixou de existir, o Service
 * recebeu 404 em toda entrega e ninguem viu ate 06/11. Nada quebra no build
 * nem na tela quando o modulo some, entao a guarda e este teste.
 */
describe('AppModule', () => {
  it('carrega a sincronizacao de cadastro com o AupusService', () => {
    const imports: unknown[] = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) ?? [];
    expect(imports).toContain(SincronizacaoModule);
  });
});
