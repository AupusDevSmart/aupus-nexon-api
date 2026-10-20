import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '@/core';
import { GeracaoAnaliseService } from './geracao-analise.service';
import { GeracaoConfigService } from './geracao-config.service';
import { IrradianciaService } from './irradiancia/irradiancia.service';
import { diaLocal, somarDias } from './geracao-datas';

/**
 * Jobs da análise de geração (GER-10), coleta pelo backend:
 * - a cada hora: irradiância de satélite de ontem e hoje (o satélite chega com ~2 h de atraso);
 * - 06:00: refaz o dia anterior com dado consolidado e registra "Limitação externa" (GER-18);
 * - 18:00: previsão de amanhã (satélite e solarímetro, GER-31/33).
 * Claim em `geracao_jobs_execucao` (job + hora): só uma instância da API roda cada execução.
 */

@Injectable()
export class GeracaoAnaliseJobs {
  private readonly logger = new Logger(GeracaoAnaliseJobs.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configs: GeracaoConfigService,
    private readonly analise: GeracaoAnaliseService,
    private readonly irradiancia: IrradianciaService,
  ) {}

  private async comLock(job: string, nome: string, fn: () => Promise<void>): Promise<void> {
    if (process.env.GERACAO_ANALISE_JOBS === 'off') return;
    const slot = new Date().toISOString().slice(0, 13);
    try {
      const n = await this.prisma.$executeRaw`
        INSERT INTO geracao_jobs_execucao (job, slot) VALUES (${job}, ${slot}) ON CONFLICT DO NOTHING`;
      if (!n) return; // outra instância já pegou esta execução
    } catch (e: any) {
      this.logger.warn(`${nome}: sem tabela de execução (${e?.message ?? e})`);
      return;
    }
    const t0 = Date.now();
    try {
      await fn();
    } catch (e: any) {
      this.logger.error(`${nome} falhou: ${e?.message ?? e}`);
    } finally {
      this.logger.log(`${nome} em ${Date.now() - t0} ms`);
    }
  }

  /** Executa `fn` por unidade configurada, sem deixar uma falha parar as outras. */
  private async porUnidade(filtro: (fonte: string) => boolean, fn: (unidadeId: string) => Promise<void>): Promise<void> {
    const unidades = (await this.configs.unidadesConfiguradas()).filter((u) => filtro(u.fonte));
    for (const u of unidades) {
      await fn(u.unidade_id).catch((e) => this.logger.warn(`Unidade ${u.unidade_id}: ${e?.message ?? e}`));
    }
  }

  @Cron('0 7 * * * *', { timeZone: 'America/Sao_Paulo' })
  async horario(): Promise<void> {
    await this.comLock('irradiancia_horaria', 'Irradiância horária', async () => {
      const hoje = diaLocal(new Date());
      await this.porUnidade((f) => f === 'satelite', async (id) => {
        const ctx = await this.configs.contexto(id);
        await this.irradiancia.atualizarSatelite(ctx, somarDias(hoje, -1), hoje);
      });
    });
  }

  @Cron('0 0 6 * * *', { timeZone: 'America/Sao_Paulo' })
  async consolidarOntem(): Promise<void> {
    await this.comLock('consolidar_ontem', 'Consolidação de ontem', async () => {
      const agora = new Date();
      const ontem = somarDias(diaLocal(agora), -1);
      for (const id of await this.configs.unidadesComInversor()) {
        try {
          const ctx = await this.configs.contexto(id);
          if (!ctx.inversores.length) continue;
          if (ctx.config.fonte === 'satelite') await this.irradiancia.atualizarSatelite(ctx, ontem, ontem);
          const ints = await this.analise.recalcularDia(ctx, ontem, agora);
          if (ctx.config.fonte !== 'nenhuma') await this.analise.registrarLimitacoesExternas(ctx, ints);
          // Ano aberto pela 1ª vez não pode calcular 365 dias na hora: deixa o cache pronto.
          await this.analise.aquecer(ctx, 400, agora);
        } catch (e: any) {
          this.logger.warn(`Unidade ${id}: ${e?.message ?? e}`);
        }
      }
    });
  }

  @Cron('0 0 18 * * *', { timeZone: 'America/Sao_Paulo' })
  async previsao(): Promise<void> {
    await this.comLock('previsao_amanha', 'Previsão de amanhã', async () => {
      await this.porUnidade((f) => f !== 'nenhuma', async (id) => {
        const ctx = await this.configs.contexto(id);
        await this.irradiancia.atualizarPrevisao(ctx);
      });
    });
  }
}
