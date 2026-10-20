import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/core';
import { podeExportarRecargas } from '../carregador-eletrico/carregador.util';
import { CarregadorEletricoService } from '../carregador-eletrico/carregador-eletrico.service';
import { potenciaTecnicaKw } from '../geracao-analise/geracao-config.service';
import { ContextoRelatorio, RelatorioBaseService } from './relatorio-base.service';
import { arred, disponibilidadePct } from './calc/disponibilidade';
import { periodoDoMes, somarMeses } from './calc/periodo';
import type { CarregadorRelatorio, MoradorRecarga, RelatorioRecargas } from './relatorios-operacao.tipos';

interface Sessao {
  equipamento_id: string;
  apartamento: string | null;
  morador: string | null;
  kwh: number | null;
  minutos: number | null;
}

/**
 * Relatório de recargas (carregador elétrico de condomínio). Mesma regra do export mensal
 * do carregador: recarga entra no mês em que COMEÇOU e só depois de encerrada; quem exporta
 * é proprietário, analistas e Admin (PER-38); R$/kWh do carregador (carregador_config).
 */
@Injectable()
export class RecargasRelatorioService {
  private readonly logger = new Logger(RecargasRelatorioService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly base: RelatorioBaseService,
    private readonly carregador: CarregadorEletricoService,
  ) {}

  async gerar(ctx: ContextoRelatorio): Promise<RelatorioRecargas> {
    const { periodo, user } = ctx;
    // Mesmo papel do módulo do carregador (role objeto/array e morador vinculado contam).
    const { papel } = await this.carregador.papel(user);
    if (!podeExportarRecargas(papel)) {
      throw new ForbiddenException('Relatório de recargas só para o proprietário ou o analista.');
    }
    const cars = ctx.equipamentos;
    const ids = cars.map((c) => c.id);
    const anterior = periodoDoMes(somarMeses(periodo.mes, -1), ctx.agora);

    const [sessoes, kwhAnterior, tarifas, potencias, chamados, semCom] = await Promise.all([
      this.sessoes(ids, periodo.inicio, periodo.fim),
      anterior ? this.kwhTotal(ids, anterior.inicio, anterior.fim) : Promise.resolve(null),
      this.tarifas(ids),
      this.potencias(ids),
      this.base.chamados(ctx),
      this.base.semComunicacao(ctx, cars.map((c) => ({ id: c.id, nome: c.nome }))),
    ]);

    const ini = periodo.inicio.getTime();
    const fim = periodo.fim.getTime();
    const carregadores: CarregadorRelatorio[] = cars.map((c) => {
      const grupos = new Map<string, MoradorRecarga>();
      for (const s of sessoes.filter((x) => x.equipamento_id === c.id)) {
        const k = `${s.apartamento ?? ''}|${s.morador ?? ''}`;
        const g = grupos.get(k) ?? { apartamento: s.apartamento?.trim() || '—', morador: s.morador?.trim() || '—', recargas: 0, kwh: 0, minutos: 0 };
        g.recargas += 1;
        g.kwh += Number(s.kwh ?? 0);
        g.minutos += Number(s.minutos ?? 0);
        grupos.set(k, g);
      }
      const moradores = [...grupos.values()]
        .map((g) => ({ ...g, kwh: arred(g.kwh, 2) }))
        .sort((a, b) => a.apartamento.localeCompare(b.apartamento, 'pt-BR', { numeric: true }) || a.morador.localeCompare(b.morador, 'pt-BR'));
      return {
        equipamentoId: c.id,
        nome: c.nome,
        potenciaKw: potencias.get(c.id) ?? this.potenciaDoNome(c.nome),
        disponibilidadePct: disponibilidadePct(semCom.get(c.id) ?? [], ini, fim),
        chamadosNoMes: chamados.linhas.filter((l) => l.equipamento_id?.trim() === c.id && new Date(l.created_at).getTime() >= ini).length,
        moradores,
      };
    });

    // R$/kWh: só com "Ver valores em R$" (operador) e tarifa cadastrada; carregadores com
    // valores diferentes → o do primeiro que tiver.
    const verRs = await this.base.podeVerValores(ids, user);
    const valor = verRs ? (ids.map((id) => tarifas.get(id)).find((v) => v !== undefined && v !== null) ?? null) : null;

    return {
      cabecalho: this.base.cabecalho(ctx),
      valorKwh: valor,
      energiaMesAnteriorKwh: kwhAnterior,
      carregadores,
      chamados: chamados.bloco,
    };
  }

  /** "Carregador DC 120kW" → 120 (o cadastro técnico tem precedência). */
  private potenciaDoNome(nome: string): number | null {
    const m = /(\d+(?:[.,]\d+)?)\s*kW\b/i.exec(nome);
    return m ? Number(m[1].replace(',', '.')) : null;
  }

  private async sessoes(ids: string[], ini: Date, fim: Date): Promise<Sessao[]> {
    try {
      return await this.prisma.$queryRaw<Sessao[]>`
        SELECT TRIM(s.equipamento_id) AS equipamento_id, m.apartamento, COALESCE(s.morador_nome, m.nome) AS morador,
               COALESCE(s.kwh_total, 0)::float8 AS kwh,
               GREATEST(EXTRACT(EPOCH FROM (s.fim - s.inicio)) / 60, 0)::int AS minutos
        FROM carregador_sessoes s
        LEFT JOIN moradores m ON m.id = s.morador_id
        WHERE s.equipamento_id = ANY(${ids}::bpchar[]) AND s.status = 'encerrada'
          AND s.inicio >= ${ini} AND s.inicio < ${fim}`;
    } catch (e) {
      this.logger.warn(`[recargas] carregador_sessoes: ${(e as Error)?.message}`);
      return [];
    }
  }

  private async kwhTotal(ids: string[], ini: Date, fim: Date): Promise<number | null> {
    try {
      const [r] = await this.prisma.$queryRaw<Array<{ kwh: number | null; n: number }>>`
        SELECT SUM(COALESCE(kwh_total, 0))::float8 AS kwh, COUNT(*)::int AS n FROM carregador_sessoes
        WHERE equipamento_id = ANY(${ids}::bpchar[]) AND status = 'encerrada' AND inicio >= ${ini} AND inicio < ${fim}`;
      return r && Number(r.n) > 0 ? arred(Number(r.kwh ?? 0), 2) : null;
    } catch {
      return null;
    }
  }

  private async tarifas(ids: string[]): Promise<Map<string, number | null>> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ id: string; tarifa: number | null }>>`
        SELECT TRIM(equipamento_id) AS id, tarifa_kwh::float8 AS tarifa FROM carregador_config WHERE TRIM(equipamento_id) = ANY(${ids}::text[])`;
      return new Map(rows.map((r) => [r.id, r.tarifa !== null ? Number(r.tarifa) : null]));
    } catch {
      return new Map();
    }
  }

  private async potencias(ids: string[]): Promise<Map<string, number>> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; valor: string | null; unidade: string | null }>>`
      SELECT DISTINCT ON (equipamento_id) TRIM(equipamento_id) AS id, valor, unidade FROM equipamentos_dados_tecnicos
      WHERE equipamento_id = ANY(${ids}::bpchar[])
        AND lower(campo) IN ('potencia_nominal', 'potencia', 'potencia_maxima', 'potencia_nominal_kw')
      ORDER BY equipamento_id, (lower(campo) = 'potencia_nominal') DESC, updated_at DESC`;
    const out = new Map<string, number>();
    for (const r of rows) {
      const kw = potenciaTecnicaKw(r.valor, r.unidade);
      if (kw !== null) out.set(r.id, kw);
    }
    return out;
  }
}
