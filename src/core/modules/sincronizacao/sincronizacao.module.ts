import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { EntregaWorker } from './entrega.worker';
import { OutboxService } from './outbox.service';
import { RecepcaoController, VinculosController } from './sincronizacao.controller';
import { SincronizacaoService } from './sincronizacao.service';

/**
 * Sincronizacao de cadastro entre AupusService e AupusNexOn.
 *
 * Os dois produtos tem bancos separados mas falam dos mesmos usuarios, plantas,
 * instalacoes e equipamentos. Este modulo e a unica porta entre eles.
 *
 * Modulo proprio, e nao rotas dentro de `plantas`/`usuarios`, por tres motivos
 * concretos: a recepcao grava preservando id e versao, sem passar pelas regras
 * de formulario; a autenticacao e de MAQUINA, nao de usuario; e concentrar tudo
 * aqui faz "quem pode escrever atravessando a fronteira" ser respondivel
 * olhando uma pasta so.
 *
 * A captura das mudancas NAO esta aqui — esta em trigger no banco
 * (`prisma/sql/2026-09-03-sincronizacao.sql`), para pegar tambem `$executeRaw`,
 * script de migracao e psql na mao. Quem for procurar "onde o evento nasce" nao
 * vai achar em TypeScript.
 */
@Module({
  imports: [PrismaModule],
  controllers: [RecepcaoController, VinculosController],
  providers: [SincronizacaoService, OutboxService, EntregaWorker],
  exports: [SincronizacaoService, OutboxService],
})
export class SincronizacaoModule {}
