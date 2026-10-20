import { Injectable } from '@nestjs/common';
import { ScopedUser } from '@/core';
import { RelatorioBaseService } from './relatorio-base.service';
import { IrrigacaoRelatorioService } from './irrigacao.service';
import { GeracaoRelatorioService } from './geracao.service';
import { ConsumoRelatorioService } from './consumo.service';
import { RecargasRelatorioService } from './recargas.service';
import type { EscopoRelatorio, RelatorioOperacao, TipoRelatorioOperacao } from './relatorios-operacao.tipos';

/**
 * Relatórios de operação dos equipamentos (NEXON-33): irrigação, geração, consumo e
 * recargas, um mês por instalação. Contrato em relatorios-operacao.tipos.ts.
 */
@Injectable()
export class RelatoriosOperacaoService {
  constructor(
    private readonly base: RelatorioBaseService,
    private readonly irrigacao: IrrigacaoRelatorioService,
    private readonly geracao: GeracaoRelatorioService,
    private readonly consumo: ConsumoRelatorioService,
    private readonly recargas: RecargasRelatorioService,
  ) {}

  tipoValido(tipo: string | null | undefined): TipoRelatorioOperacao {
    return this.base.tipoValido(tipo);
  }

  escopos(tipo: TipoRelatorioOperacao, user?: ScopedUser): Promise<EscopoRelatorio[]> {
    return this.base.escopos(tipo, user);
  }

  async gerar(tipo: TipoRelatorioOperacao, unidadeId: string, mes: string, user?: ScopedUser, agora = new Date()): Promise<RelatorioOperacao> {
    const ctx = await this.base.contexto(tipo, unidadeId, mes, user, agora);
    switch (tipo) {
      case 'irrigacao':
        return this.irrigacao.gerar(ctx);
      case 'geracao': {
        const lib = ctx.eqScope ? new Set(ctx.eqScope) : null;
        const medidores = (await this.base.listar(ctx.unidade.id, 'consumo')).filter((m) => !lib || lib.has(m.id));
        const medidor = medidores.length ? await this.base.medidorDaInstalacao(ctx, medidores) : null;
        return this.geracao.gerar(ctx, medidor?.id ?? null);
      }
      case 'consumo':
        return this.consumo.gerar(ctx);
      case 'recargas':
        return this.recargas.gerar(ctx);
    }
  }
}

/** Quantas linhas de equipamento o relatório tem (vai para a trilha de exportação). */
export function linhasDoRelatorio(r: RelatorioOperacao): number {
  if ('linhas' in r) return r.linhas.length;
  if ('inversores' in r) return r.inversores.length;
  if ('carregadores' in r) return r.carregadores.length;
  return r.maioresConsumidores.length; // consumo: a tabela de equipamentos é a dos maiores consumidores
}
