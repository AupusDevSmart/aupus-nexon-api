import { Injectable } from '@nestjs/common';
import { PrismaService, PermissionScopeService, ScopedUser } from '@/core';

export interface SinopticoStatusResult {
  /** ISO UTC do dado mais recente da unidade. Frontend formata em horario local. */
  ultimaAtualizacao: string | null;
  /** Quantidade de logs (alarmes) na janela configurada. */
  alarmesAtivos: number;
  alarmeRecente: {
    equipamentoNome: string;
    mensagem: string;
    severidade: string;
    createdAt: string;
  } | null;
  /** Equipamentos MQTT cujo ultimo dado passou do limite de staleness (ou nunca enviaram). */
  equipamentosSemDados: Array<{
    id: string;
    nome: string;
    minutosSemDados: number | null;
  }>;
}

interface GetStatusOptions {
  janelaAlarmesMinutos?: number;
  limiteStalenessMinutos?: number;
}

@Injectable()
export class SinopticoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopeService: PermissionScopeService,
  ) {}

  /**
   * Status operacional da unidade para o cabecalho do sinoptico (R1):
   * ultima atualizacao, alarmes ativos (janela) e equipamentos sem dados (staleness).
   *
   * O tempo decorrido e calculado por epoch (Date.now() - getTime()), que e
   * fuso-safe; a exibicao da ultima atualizacao em horario local fica no frontend.
   */
  async getStatus(
    unidadeId: string,
    opts: GetStatusOptions = {},
    user?: ScopedUser,
  ): Promise<SinopticoStatusResult> {
    const uid = unidadeId.trim();
    const janelaAlarmes = opts.janelaAlarmesMinutos ?? 60;
    const limiteStaleness = opts.limiteStalenessMinutos ?? 30;

    // Scope RBAC por planta (espelha logs-mqtt.service): se o usuario for
    // escopado e a unidade nao estiver no escopo, os filtros retornam vazio.
    const scope = await this.scopeService.getScope(user);
    const unidadeScopeWhere = this.scopeService.isScoped(scope)
      ? scope.length === 0
        ? { id: '__NEVER__' }
        : { planta_id: { in: scope } }
      : undefined;

    // 1. Equipamentos MQTT da unidade
    const equipamentos = await this.prisma.equipamentos.findMany({
      where: {
        unidade_id: uid,
        mqtt_habilitado: true,
        deleted_at: null,
        ...(unidadeScopeWhere ? { unidade: unidadeScopeWhere } : {}),
      },
      select: { id: true, nome: true },
    });
    const ids = equipamentos.map((e) => e.id.trim());

    // 2. Ultima leitura por equipamento (max timestamp_dados em uma unica query)
    const grupos = ids.length
      ? await this.prisma.equipamentos_dados.groupBy({
          by: ['equipamento_id'],
          where: { equipamento_id: { in: ids } },
          _max: { timestamp_dados: true },
        })
      : [];

    const ultimoPorEquip = new Map<string, Date | null>();
    for (const g of grupos) {
      ultimoPorEquip.set(g.equipamento_id.trim(), g._max.timestamp_dados ?? null);
    }

    const agora = Date.now();
    let ultima: Date | null = null;
    const equipamentosSemDados: SinopticoStatusResult['equipamentosSemDados'] = [];

    for (const eq of equipamentos) {
      const ts = ultimoPorEquip.get(eq.id.trim()) ?? null;
      if (ts && (!ultima || ts.getTime() > ultima.getTime())) ultima = ts;

      const minutos = ts ? Math.floor((agora - ts.getTime()) / 60000) : null;
      if (minutos === null || minutos >= limiteStaleness) {
        equipamentosSemDados.push({ id: eq.id.trim(), nome: eq.nome, minutosSemDados: minutos });
      }
    }

    // 3. Alarmes ativos na janela
    const alarmWhere: any = {
      created_at: { gte: new Date(agora - janelaAlarmes * 60000) },
      equipamento: {
        unidade_id: uid,
        ...(unidadeScopeWhere ? { unidade: unidadeScopeWhere } : {}),
      },
    };

    const [total, recente] = await Promise.all([
      this.prisma.logs_mqtt.count({ where: alarmWhere }),
      this.prisma.logs_mqtt.findFirst({
        where: alarmWhere,
        orderBy: { created_at: 'desc' },
        include: { equipamento: { select: { nome: true } } },
      }),
    ]);

    return {
      ultimaAtualizacao: ultima ? ultima.toISOString() : null,
      alarmesAtivos: total,
      alarmeRecente: recente
        ? {
            equipamentoNome: recente.equipamento?.nome ?? '',
            mensagem: recente.mensagem,
            severidade: recente.severidade,
            createdAt: recente.created_at.toISOString(),
          }
        : null,
      equipamentosSemDados,
    };
  }
}
