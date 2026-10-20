import { Module } from '@nestjs/common';
import { CarregadorEletricoModule } from '../carregador-eletrico/carregador-eletrico.module';
import { PrismaModule } from '@/core';
import { EquipamentosDadosModule } from '../equipamentos-dados/equipamentos-dados.module';
import { GeracaoAnaliseModule } from '../geracao-analise/geracao-analise.module';
import { RelatoriosOperacaoController } from './relatorios-operacao.controller';
import { RelatoriosOperacaoService } from './relatorios-operacao.service';
import { RelatorioBaseService } from './relatorio-base.service';
import { IrrigacaoRelatorioService } from './irrigacao.service';
import { GeracaoRelatorioService } from './geracao.service';
import { ConsumoRelatorioService } from './consumo.service';
import { RecargasRelatorioService } from './recargas.service';

/** Relatórios de operação dos equipamentos (NEXON-33): irrigação, geração, consumo, recargas. */
@Module({
  imports: [PrismaModule, EquipamentosDadosModule, GeracaoAnaliseModule, CarregadorEletricoModule],
  controllers: [RelatoriosOperacaoController],
  providers: [
    RelatoriosOperacaoService,
    RelatorioBaseService,
    IrrigacaoRelatorioService,
    GeracaoRelatorioService,
    ConsumoRelatorioService,
    RecargasRelatorioService,
  ],
})
export class RelatoriosOperacaoModule {}
