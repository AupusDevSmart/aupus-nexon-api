import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService, PermissionScopeService, ScopedUser } from '@aupus/api-shared';
import { EquipamentoDadosQueryDto } from './dto/equipamento-dados-query.dto';

@Injectable()
export class EquipamentosDadosService {
  private readonly logger = new Logger(EquipamentosDadosService.name);

  constructor(
    private prisma: PrismaService,
    private scopeService: PermissionScopeService,
  ) {}

  /** Helper interno: garante que o equipamento (single id) esta no escopo do user. */
  private async assertEqInScope(equipamentoId: string, user?: ScopedUser): Promise<void> {
    if (!user) return;
    await this.scopeService.assertEntityInScope('equipamento', equipamentoId.trim(), user);
  }

  /**
   * Helper interno: filtra um array de IDs de equipamento para apenas os que o user pode ver.
   * Para users sem scope (admin/null), retorna o array original.
   */
  private async filterEqIdsByScope(equipamentosIds: string[], user?: ScopedUser): Promise<string[]> {
    if (!user) return equipamentosIds;
    const scope = await this.scopeService.getScope(user);
    if (!this.scopeService.isScoped(scope)) return equipamentosIds;
    if (scope.length === 0 || equipamentosIds.length === 0) return [];
    const ids = equipamentosIds.map((id) => id.trim()).filter(Boolean);
    const inScope = await this.prisma.equipamentos.findMany({
      where: {
        id: { in: ids },
        unidade: { planta_id: { in: scope } },
        deleted_at: null,
      },
      select: { id: true },
    });
    const allowed = new Set(inScope.map((e) => e.id.trim()));
    return ids.filter((id) => allowed.has(id));
  }

  /**
   * Buscar o dado mais recente de um equipamento
   */
  async findLatest(equipamentoId: string, user?: ScopedUser) {
    this.logger.log(`Buscando dado mais recente para equipamento ${equipamentoId}`);
    await this.assertEqInScope(equipamentoId, user);

    // Limpar espaços do ID (problema de CHAR vs VARCHAR)
    const equipamentoIdLimpo = equipamentoId.trim();

    // Verificar se o equipamento existe
    const equipamento = await this.prisma.equipamentos.findUnique({
      where: { id: equipamentoIdLimpo },
      include: {
        tipo_equipamento_rel: true,
      },
    });

    if (!equipamento) {
      throw new NotFoundException(`Equipamento ${equipamentoId} não encontrado`);
    }

    // Buscar o dado mais recente (janela de 15min para evitar full scan)
    // Como equipamento_id no banco pode ter espaços, usar o ID do equipamento encontrado
    const quinzeMinutosAtras = new Date(Date.now() - 15 * 60 * 1000);
    const dado = await this.prisma.equipamentos_dados.findFirst({
      where: {
        equipamento_id: equipamento.id,
        timestamp_dados: { gte: quinzeMinutosAtras }
      },
      orderBy: { timestamp_dados: 'desc' },
    });

    if (!dado) {
      return {
        equipamento: {
          id: equipamento.id,
          nome: equipamento.nome,
          tipo: equipamento.tipo_equipamento_rel?.nome,
        },
        dado: null,
        message: 'Nenhum dado MQTT disponível para este equipamento',
      };
    }

    return {
      equipamento: {
        id: equipamento.id,
        nome: equipamento.nome,
        tipo: equipamento.tipo_equipamento_rel?.nome,
        mqtt_habilitado: equipamento.mqtt_habilitado,
        topico_mqtt: equipamento.topico_mqtt,
      },
      dado: {
        id: dado.id,
        dados: dado.dados,
        fonte: dado.fonte,
        timestamp_dados: dado.timestamp_dados,
        qualidade: dado.qualidade,
        created_at: dado.created_at,
      },
    };
  }

  /**
   * Buscar histórico de dados de um equipamento
   */
  async findHistory(equipamentoId: string, query: EquipamentoDadosQueryDto, user?: ScopedUser) {
    this.logger.log(`Buscando histórico para equipamento ${equipamentoId}`);
    await this.assertEqInScope(equipamentoId, user);

    // Limpar espaços do ID (problema de CHAR vs VARCHAR)
    const equipamentoIdLimpo = equipamentoId.trim();

    // Verificar se o equipamento existe
    const equipamento = await this.prisma.equipamentos.findUnique({
      where: { id: equipamentoIdLimpo },
    });

    if (!equipamento) {
      throw new NotFoundException(`Equipamento ${equipamentoId} não encontrado`);
    }

    const { page = 1, limit = 100, startDate, endDate, fonte, qualidade } = query;
    const skip = (page - 1) * limit;

    // Construir filtros (usar o ID do equipamento encontrado com espaços)
    const where: any = {
      equipamento_id: equipamento.id,
    };

    if (startDate || endDate) {
      where.timestamp_dados = {};
      if (startDate) where.timestamp_dados.gte = new Date(startDate);
      if (endDate) where.timestamp_dados.lte = new Date(endDate);
    }

    if (fonte) where.fonte = fonte;
    if (qualidade) where.qualidade = qualidade;

    // Buscar dados com paginação
    const [dados, total] = await Promise.all([
      this.prisma.equipamentos_dados.findMany({
        where,
        orderBy: { timestamp_dados: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.equipamentos_dados.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit);

    return {
      data: dados.map((d) => ({
        id: d.id,
        dados: d.dados,
        fonte: d.fonte,
        timestamp_dados: d.timestamp_dados,
        qualidade: d.qualidade,
        created_at: d.created_at,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    };
  }

  /**
   * Salvar novo dado MQTT para um equipamento
   */
  async create(equipamentoId: string, dados: any, fonte: string = 'MQTT', qualidade: string = 'GOOD') {
    this.logger.log(`Salvando dados MQTT para equipamento ${equipamentoId}`);

    return this.prisma.equipamentos_dados.create({
      data: {
        equipamento_id: equipamentoId,
        dados,
        fonte,
        qualidade,
        timestamp_dados: new Date(),
      },
    });
  }

  /**
   * Buscar estatísticas de dados de um equipamento
   */
  async getStats(equipamentoId: string, user?: ScopedUser) {
    await this.assertEqInScope(equipamentoId, user);
    this.logger.log(`Buscando estatísticas para equipamento ${equipamentoId}`);

    const stats = await this.prisma.equipamentos_dados.aggregate({
      where: { equipamento_id: equipamentoId },
      _count: true,
    });

    const oldest = await this.prisma.equipamentos_dados.findFirst({
      where: { equipamento_id: equipamentoId },
      orderBy: { timestamp_dados: 'asc' },
      select: { timestamp_dados: true },
    });

    const newest = await this.prisma.equipamentos_dados.findFirst({
      where: { equipamento_id: equipamentoId },
      orderBy: { timestamp_dados: 'desc' },
      select: { timestamp_dados: true },
    });

    return {
      total_records: stats._count,
      oldest_record: oldest?.timestamp_dados,
      newest_record: newest?.timestamp_dados,
    };
  }

  /**
   * Gráfico do Dia - Curva de potência ao longo do dia
   * Retorna dados agregados de 1 minuto para o dia especificado
   */
  async getGraficoDia(equipamentoId: string, data?: string, intervalo?: string, inicio?: string, fim?: string, user?: ScopedUser) {
    await this.assertEqInScope(equipamentoId, user);
    // Se intervalo NÃO foi fornecido explicitamente, retorna dados brutos (comportamento legado)
    // Outros hooks (M160, demanda) dependem dos campos JSON crus da DB
    if (!intervalo) {
      const dataConsulta = data ? new Date(data + 'T00:00:00') : (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })();
      const dataFimRaw = data ? new Date(dataConsulta.getTime() + 86400000) : new Date();

      const dadosBrutos = await this.prisma.equipamentos_dados.findMany({
        where: {
          equipamento_id: equipamentoId,
          timestamp_dados: { gte: dataConsulta, lt: dataFimRaw },
        },
        orderBy: { timestamp_dados: 'asc' },
        take: 2000,
      });

      return {
        data: dataConsulta.toISOString().split('T')[0],
        total_pontos: dadosBrutos.length,
        dados: dadosBrutos.map((d: any) => ({
          ...d,
          timestamp: d.timestamp_dados,
          hora: d.timestamp_dados.toISOString(),
        })),
      };
    }

    // Validar intervalo (minutos): 1, 5, 15, 30. Default: 30
    const INTERVALOS_VALIDOS = [1, 5, 15, 30];
    const intervaloMin = INTERVALOS_VALIDOS.includes(Number(intervalo)) ? Number(intervalo) : 30;

    // Definir o período de busca
    let dataConsulta: Date;
    let dataFim: Date;

    if (inicio && fim) {
      // Janela específica de zoom — usa os timestamps exatos fornecidos
      dataConsulta = new Date(inicio);
      dataFim = new Date(fim);
    } else if (data) {
      dataConsulta = new Date(data);
      dataConsulta.setHours(0, 0, 0, 0);
      dataFim = new Date(dataConsulta);
      dataFim.setDate(dataFim.getDate() + 1);
    } else {
      // Dia corrente: de 00:00 até agora
      dataConsulta = new Date();
      dataConsulta.setHours(0, 0, 0, 0);
      dataFim = new Date();
    }

    // Raw SQL com agregação no banco por intervalo dinâmico
    const dadosAgregados: any[] = await this.prisma.$queryRaw`
      SELECT
        DATE_TRUNC('hour', timestamp_dados)
          + (FLOOR(EXTRACT(minute FROM timestamp_dados) / ${intervaloMin}) * ${intervaloMin}) * INTERVAL '1 minute'
          AS intervalo,
        AVG(
          COALESCE(
            potencia_ativa_kw,
            (dados->'power'->>'active_total')::numeric / 1000.0,
            (dados->'dc'->>'total_power')::numeric / 1000.0,
            (dados->'power'->>'active')::numeric / 1000.0,
            (dados->>'power_avg')::numeric,
            (dados->>'potencia_kw')::numeric,
            (dados->>'active_power')::numeric / 1000.0,
            (dados->>'Pt')::numeric / 1000.0,
            ((COALESCE((dados->'Dados'->>'Pa')::numeric, 0)
              + COALESCE((dados->'Dados'->>'Pb')::numeric, 0)
              + COALESCE((dados->'Dados'->>'Pc')::numeric, 0)) / 1000.0)
          )
        ) AS potencia_media,
        MIN(
          COALESCE(
            potencia_ativa_kw,
            (dados->'power'->>'active_total')::numeric / 1000.0,
            (dados->'dc'->>'total_power')::numeric / 1000.0,
            (dados->'power'->>'active')::numeric / 1000.0,
            (dados->>'power_avg')::numeric,
            (dados->>'potencia_kw')::numeric,
            (dados->>'active_power')::numeric / 1000.0,
            (dados->>'Pt')::numeric / 1000.0
          )
        ) AS potencia_min,
        MAX(
          COALESCE(
            potencia_ativa_kw,
            (dados->'power'->>'active_total')::numeric / 1000.0,
            (dados->'dc'->>'total_power')::numeric / 1000.0,
            (dados->'power'->>'active')::numeric / 1000.0,
            (dados->>'power_avg')::numeric,
            (dados->>'potencia_kw')::numeric,
            (dados->>'active_power')::numeric / 1000.0,
            (dados->>'Pt')::numeric / 1000.0
          )
        ) AS potencia_max,
        COUNT(*)::int AS num_leituras
      FROM equipamentos_dados
      WHERE equipamento_id = ${equipamentoId}
        AND timestamp_dados >= ${dataConsulta}
        AND timestamp_dados < ${dataFim}
      GROUP BY intervalo
      ORDER BY intervalo ASC
    `;

    // Mapear resultado para o formato esperado pelo frontend
    const pontos = dadosAgregados.map((row: any) => ({
      timestamp: row.intervalo,
      hora: new Date(row.intervalo).toISOString(),
      potencia_kw: Number(row.potencia_media) || 0,
      potencia_min: Number(row.potencia_min) || 0,
      potencia_max: Number(row.potencia_max) || 0,
      num_leituras: row.num_leituras,
      qualidade: 'GOOD',
    }));

    return {
      data: dataConsulta.toISOString().split('T')[0],
      total_pontos: pontos.length,
      intervalo_minutos: intervaloMin,
      dados: pontos,
    };
  }

  /**
   * Gráfico do Mês - Energia gerada por dia
   * Soma a energia de todos os minutos de cada dia
   */
  async getGraficoMes(equipamentoId: string, mes?: string, user?: ScopedUser) {
    await this.assertEqInScope(equipamentoId, user);
    console.log(`\n📊 [GRÁFICO MÊS] ========================================`);
    console.log(`📊 [GRÁFICO MÊS] Equipamento: ${equipamentoId}`);
    console.log(`📊 [GRÁFICO MÊS] Mês solicitado: ${mes || 'atual'}`);

    // Verificar o tipo do equipamento
    const equipamento = await this.prisma.equipamentos.findUnique({
      where: { id: equipamentoId },
      include: { tipo_equipamento_rel: true }
    });

    if (!equipamento) {
      throw new NotFoundException(`Equipamento ${equipamentoId} não encontrado`);
    }

    // Definir o mês (atual se não especificado)
    const now = new Date();
    const ano = mes ? parseInt(mes.split('-')[0]) : now.getFullYear();
    const mesNum = mes ? parseInt(mes.split('-')[1]) : now.getMonth() + 1;

    const dataInicio = new Date(ano, mesNum - 1, 1);
    const dataFim = new Date(ano, mesNum, 1);

    console.log(`📊 [GRÁFICO MÊS] Período de busca:`);
    console.log(`📊 [GRÁFICO MÊS]   De: ${dataInicio.toISOString()}`);
    console.log(`📊 [GRÁFICO MÊS]   Até: ${dataFim.toISOString()}`);
    console.log(`📊 [GRÁFICO MÊS] Tipo do equipamento: ${equipamento.tipo_equipamento_rel?.codigo}`);

    // ✅ Energia diaria por device, na fonte mais fiel:
    //   0. Inversor PV: MAX(energy.daily_yield) no dia — contador diario, robusto
    //      a glitch e = "Geração Diária"; evita o /60 do period_energy_kwh.
    //   1. M-160: SUM(delta-phf positivo) — ver docs/tickets/powermeter-delta-phf.md.
    //   2. Fallback inversor sem contador: energy.period_energy_kwh.
    //   3. Fallback generico: coluna energia_kwh.
    const dados = await this.prisma.$queryRaw<Array<any>>`
        WITH leituras AS (
          SELECT
            timestamp_dados,
            dados,
            -- delta-phf vs MAX(phf) das leituras anteriores. Glitch isolado
            -- (10557 → 175 → 10557) eh descartado: quando phf volta, MAX
            -- ja contém 10557 e o delta dá 0. LAG() puro contaria +10382 falsos.
            -- Ver docs/tickets/powermeter-delta-phf.md.
            GREATEST(
              COALESCE(
                CAST(dados->>'phf' AS NUMERIC) - MAX(CAST(dados->>'phf' AS NUMERIC))
                  OVER (
                    ORDER BY timestamp_dados ASC
                    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                  ),
                0
              ),
              0
            ) AS delta_phf
          FROM equipamentos_dados
          WHERE equipamento_id = ${equipamentoId}
            AND timestamp_dados >= ${dataInicio}
            AND timestamp_dados < ${dataFim}
        )
        SELECT
          DATE(timestamp_dados) as data,
          CASE
            WHEN COUNT(dados->'energy'->>'daily_yield') >= 1
            THEN MAX((dados->'energy'->>'daily_yield')::numeric)
            ELSE SUM(
              COALESCE(
                CASE WHEN delta_phf IS NOT NULL AND delta_phf > 0 THEN delta_phf END,
                (dados->'energy'->>'period_energy_kwh')::numeric,
                (dados->>'energia_kwh')::numeric
              )
            )
          END as energia_kwh,
          COUNT(*) as num_registros,
          AVG(
            COALESCE(
              (dados->'power'->>'active_total')::numeric / 1000.0,
              (dados->>'power_avg')::numeric
            )
          ) as potencia_media_kw
        FROM leituras
        WHERE
          dados->>'phf' IS NOT NULL
          OR dados->'energy'->>'total_yield' IS NOT NULL
          OR dados->'energy'->>'period_energy_kwh' IS NOT NULL
          OR dados->>'energia_kwh' IS NOT NULL
        GROUP BY DATE(timestamp_dados)
        ORDER BY data ASC
      `;

    console.log(`📊 [GRÁFICO MÊS] Dias com dados: ${dados.length}`);
    if (dados.length > 0) {
      console.log(`📊 [GRÁFICO MÊS] Primeiro dia:`, {
        data: dados[0].data,
        energia_kwh: dados[0].energia_kwh,
        num_registros: dados[0].num_registros,
        potencia_media_kw: dados[0].potencia_media_kw,
      });
    }

    // Transformar para formato do gráfico
    const pontos = dados.map((d: any) => ({
      data: d.data.toISOString().split('T')[0],
      dia: d.data.getDate(),
      energia_kwh: parseFloat(d.energia_kwh) || 0,
      potencia_media_kw: parseFloat(d.potencia_media_kw) || 0,
      num_registros: parseInt(d.num_registros),
    }));

    const energiaTotal = pontos.reduce((sum, p) => sum + p.energia_kwh, 0);

    console.log(`📊 [GRÁFICO MÊS] Total de pontos: ${pontos.length}`);
    console.log(`📊 [GRÁFICO MÊS] Energia total: ${energiaTotal} kWh`);
    console.log(`📊 [GRÁFICO MÊS] ========================================\n`);

    return {
      mes: `${ano}-${String(mesNum).padStart(2, '0')}`,
      total_dias: pontos.length,
      energia_total_kwh: energiaTotal,
      dados: pontos,
    };
  }

  /**
   * Gráfico do Dia para Múltiplos Equipamentos - Soma das potências
   * Agrega dados de múltiplos equipamentos selecionados (usando equipamentos_dados)
   */
  async getGraficoDiaMultiplosInversores(equipamentosIds: string[], data?: string, user?: ScopedUser) {
    equipamentosIds = await this.filterEqIdsByScope(equipamentosIds, user);
    // ✅ VALIDAÇÃO: Limitar número de equipamentos para evitar sobrecarga
    if (equipamentosIds.length > 5) {
      throw new NotFoundException(
        `Máximo de 5 equipamentos permitidos por vez. Você selecionou ${equipamentosIds.length} equipamentos.`
      );
    }

    console.log(`\n📊 [GRÁFICO DIA MÚLTIPLO] ========================================`);
    console.log(`📊 [GRÁFICO DIA MÚLTIPLO] Equipamentos: ${equipamentosIds.join(', ')}`);
    console.log(`📊 [GRÁFICO DIA MÚLTIPLO] Data solicitada: ${data || 'hoje'}`);

    // Buscar informações dos equipamentos
    const equipamentos = await this.prisma.equipamentos.findMany({
      where: {
        id: { in: equipamentosIds },
      },
      include: { tipo_equipamento_rel: true }
    });

    if (equipamentos.length === 0) {
      throw new NotFoundException('Nenhum equipamento válido encontrado');
    }

    // Definir o período de busca
    let dataConsulta: Date;
    let dataFim: Date;

    if (data) {
      // Se data específica foi fornecida, buscar o dia completo
      dataConsulta = new Date(data);
      dataConsulta.setHours(0, 0, 0, 0);
      dataFim = new Date(dataConsulta);
      dataFim.setDate(dataFim.getDate() + 1);
    } else {
      // Se não foi fornecida data, buscar ÚLTIMAS 24 HORAS (não o dia atual)
      dataFim = new Date(); // Agora
      dataConsulta = new Date(dataFim);
      dataConsulta.setHours(dataConsulta.getHours() - 24); // 24 horas atrás
    }

    console.log(`📊 [GRÁFICO DIA MÚLTIPLO] Período de busca:`);
    console.log(`📊 [GRÁFICO DIA MÚLTIPLO]   De: ${dataConsulta.toISOString()}`);
    console.log(`📊 [GRÁFICO DIA MÚLTIPLO]   Até: ${dataFim.toISOString()}`);
    console.log(`📊 [GRÁFICO DIA MÚLTIPLO] Equipamentos encontrados: ${equipamentos.length}`);

    // Buscar dados de todos os equipamentos da tabela equipamentos_dados
    const dados = await this.prisma.equipamentos_dados.findMany({
      where: {
        equipamento_id: { in: equipamentosIds },
        timestamp_dados: {
          gte: dataConsulta,
          lt: dataFim,
        },
      },
      orderBy: { timestamp_dados: 'asc' },
      take: 10000, // ✅ LIMITE DE SEGURANÇA: máximo 10000 registros (múltiplos equipamentos)
      select: {
        equipamento_id: true,
        timestamp_dados: true,
        dados: true,
        qualidade: true,
      },
    });

    console.log(`📊 [GRÁFICO DIA MÚLTIPLO] Total de registros encontrados: ${dados.length}`);

    if (dados.length > 0) {
      console.log(`📊 [GRÁFICO DIA MÚLTIPLO] Amostra do primeiro registro:`, {
        equipamento_id: dados[0].equipamento_id,
        timestamp: dados[0].timestamp_dados,
        estrutura_dados: Object.keys(dados[0].dados as any),
      });
    }

    // Agrupar dados em intervalos de 5 minutos para reduzir variação
    const INTERVALO_MINUTOS = 5;
    const dadosAgrupados = new Map<string, {
      timestamp: Date;
      potenciasPorEquipamento: Map<string, number[]>; // Potências separadas por equipamento
    }>();

    dados.forEach((d: any) => {
      // Arredondar para o intervalo de 5 minutos
      const minuto = new Date(d.timestamp_dados);
      const minutosArredondados = Math.floor(minuto.getMinutes() / INTERVALO_MINUTOS) * INTERVALO_MINUTOS;
      minuto.setMinutes(minutosArredondados, 0, 0);
      const minutoKey = minuto.toISOString();

      if (!dadosAgrupados.has(minutoKey)) {
        dadosAgrupados.set(minutoKey, {
          timestamp: minuto,
          potenciasPorEquipamento: new Map(),
        });
      }

      const grupo = dadosAgrupados.get(minutoKey)!;

      // Extrair potência (suportar múltiplas estruturas)
      let potenciaKw = 0;
      // ✅ NOVO: Priorizar campo potencia_kw (M160 formato Resumo)
      if (d.dados.potencia_kw !== undefined) {
        potenciaKw = d.dados.potencia_kw;
      } else if (d.dados.power?.active_total !== undefined) {
        potenciaKw = d.dados.power.active_total / 1000;
      } else if (d.dados.dc?.total_power !== undefined) {
        potenciaKw = d.dados.dc.total_power / 1000;
      } else if (d.dados.power?.active !== undefined) {
        potenciaKw = d.dados.power.active / 1000;
      } else if (d.dados.power_avg !== undefined) {
        potenciaKw = d.dados.power_avg;
      } else if (d.dados.potencia_ativa_kw !== undefined) {
        potenciaKw = d.dados.potencia_ativa_kw;
      } else if (d.dados.Pt !== undefined) {
        // ✅ NOVO FORMATO: Power Meter (M-160) com Pt na raiz
        potenciaKw = d.dados.Pt / 1000;
      } else if (d.dados.Dados) {
        // ✅ FORMATO LEGADO: Power Meter com Dados.Pt
        const Pa = d.dados.Dados.Pa || 0;
        const Pb = d.dados.Dados.Pb || 0;
        const Pc = d.dados.Dados.Pc || 0;
        potenciaKw = (Pa + Pb + Pc) / 1000;
      }

      if (potenciaKw > 0) {
        // Agrupar leituras por equipamento para depois fazer média
        if (!grupo.potenciasPorEquipamento.has(d.equipamento_id)) {
          grupo.potenciasPorEquipamento.set(d.equipamento_id, []);
        }
        grupo.potenciasPorEquipamento.get(d.equipamento_id)!.push(potenciaKw);
      }
    });

    // Passo 1: Converter para array ordenado
    const pontosOrdenados = Array.from(dadosAgrupados.entries())
      .sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime());

    // Passo 2: Aplicar forward-fill para garantir que todos equipamentos contribuam sempre
    const ultimasPotencias = new Map<string, number>(); // Última potência conhecida de cada equipamento
    let pontosDebug = 0;

    const pontos = pontosOrdenados.map(([_, grupo], indice) => {
      // Atualizar últimas potências com os dados atuais
      grupo.potenciasPorEquipamento.forEach((potencias, equipamentoId) => {
        const mediaPorEquipamento = potencias.reduce((sum, p) => sum + p, 0) / potencias.length;
        ultimasPotencias.set(equipamentoId, mediaPorEquipamento);
      });

      // Calcular potência total usando TODAS as últimas potências conhecidas (forward-fill)
      let potenciaTotal = 0;
      const potenciasAtivas: number[] = [];
      let totalLeituras = 0;

      // Somar as últimas potências conhecidas de TODOS os equipamentos
      ultimasPotencias.forEach((potencia, equipamentoId) => {
        potenciaTotal += potencia;
        potenciasAtivas.push(potencia);
      });

      // Contar leituras do intervalo atual
      grupo.potenciasPorEquipamento.forEach((potencias) => {
        totalLeituras += potencias.length;
      });

      const potenciaMin = potenciasAtivas.length > 0 ? Math.min(...potenciasAtivas) : 0;
      const potenciaMax = potenciasAtivas.length > 0 ? Math.max(...potenciasAtivas) : 0;

      // Debug: Log primeiros 10 pontos e últimos 5
      if (pontosDebug < 10 || indice >= pontosOrdenados.length - 5) {
        pontosDebug++;
        console.log(`📊 [DEBUG PONTO ${indice}] ${grupo.timestamp.toLocaleTimeString('pt-BR')}:`);
        console.log(`  - Equipamentos ativos neste intervalo: ${grupo.potenciasPorEquipamento.size}`);
        console.log(`  - Total equipamentos rastreados: ${ultimasPotencias.size}`);
        const detalhes: string[] = [];
        ultimasPotencias.forEach((pot, id) => {
          const ativoAgora = grupo.potenciasPorEquipamento.has(id);
          detalhes.push(`${id.substring(0, 8)}: ${pot.toFixed(1)}kW ${ativoAgora ? '✓' : '(fill)'}`);
        });
        console.log(`  - Potências: [${detalhes.join(', ')}]`);
        console.log(`  - Total: ${potenciaTotal.toFixed(1)} kW`);
      }

      return {
        timestamp: grupo.timestamp,
        hora: grupo.timestamp.toISOString(),
        potencia_kw: potenciaTotal, // Soma de TODOS os equipamentos (usando forward-fill)
        potencia_min: potenciaMin,
        potencia_max: potenciaMax,
        potencia_media: ultimasPotencias.size > 0 ? potenciaTotal / ultimasPotencias.size : 0,
        num_inversores: ultimasPotencias.size, // Total de equipamentos rastreados
        num_inversores_ativos: grupo.potenciasPorEquipamento.size, // Equipamentos com dados neste intervalo
        num_leituras: totalLeituras,
        qualidade: 'GOOD',
      };
    });

    console.log(`📊 [GRÁFICO DIA MÚLTIPLO] Total de pontos processados: ${pontos.length}`);
    if (pontos.length > 0) {
      console.log(`📊 [GRÁFICO DIA MÚLTIPLO] Primeiro ponto:`, pontos[0]);
      console.log(`📊 [GRÁFICO DIA MÚLTIPLO] Último ponto:`, pontos[pontos.length - 1]);
    }

    // Passo 3: Aplicar suavização com média móvel para reduzir ruído
    // Usar janela de 3 pontos (15 minutos) para suavizar sem perder detalhes
    const JANELA_SUAVIZACAO = 3;
    const pontosSuavizados = pontos.map((ponto, indice) => {
      // Pegar pontos na janela (antes, atual, depois)
      const inicio = Math.max(0, indice - Math.floor(JANELA_SUAVIZACAO / 2));
      const fim = Math.min(pontos.length, indice + Math.floor(JANELA_SUAVIZACAO / 2) + 1);
      const pontosNaJanela = pontos.slice(inicio, fim);

      // Calcular média das potências na janela
      const potenciaMedia = pontosNaJanela.reduce((sum, p) => sum + p.potencia_kw, 0) / pontosNaJanela.length;

      // Log apenas para primeiros e últimos pontos
      if (pontosDebug < 10 || indice >= pontos.length - 5) {
        console.log(`📊 [SUAVIZAÇÃO PONTO ${indice}] Original: ${ponto.potencia_kw.toFixed(1)} kW → Suavizado: ${potenciaMedia.toFixed(1)} kW (janela de ${pontosNaJanela.length} pontos)`);
      }

      return {
        ...ponto,
        potencia_kw: potenciaMedia, // Substituir pela média suavizada
      };
    });

    console.log(`📊 [GRÁFICO DIA MÚLTIPLO] Aplicada suavização com janela de ${JANELA_SUAVIZACAO} pontos (${JANELA_SUAVIZACAO * INTERVALO_MINUTOS} minutos)`);

    return {
      data: dataConsulta.toISOString().split('T')[0],
      total_pontos: pontosSuavizados.length,
      total_inversores: equipamentos.length,
      inversores: equipamentos.map(eq => ({
        id: eq.id,
        nome: eq.nome,
      })),
      dados: pontosSuavizados,
    };
  }

  /**
   * Gráfico do Mês para Múltiplos Equipamentos - Soma das energias
   * Agrega dados de múltiplos equipamentos selecionados (usando equipamentos_dados)
   */
  async getGraficoMesMultiplosInversores(equipamentosIds: string[], mes?: string, user?: ScopedUser) {
    equipamentosIds = await this.filterEqIdsByScope(equipamentosIds, user);
    // ✅ VALIDAÇÃO: Limitar número de equipamentos para evitar sobrecarga
    if (equipamentosIds.length > 5) {
      throw new NotFoundException(
        `Máximo de 5 equipamentos permitidos por vez. Você selecionou ${equipamentosIds.length} equipamentos.`
      );
    }

    console.log(`\n📊 [GRÁFICO MÊS MÚLTIPLO] ========================================`);
    console.log(`📊 [GRÁFICO MÊS MÚLTIPLO] Equipamentos: ${equipamentosIds.join(', ')}`);
    console.log(`📊 [GRÁFICO MÊS MÚLTIPLO] Mês solicitado: ${mes || 'atual'}`);

    // Buscar informações dos equipamentos
    const equipamentos = await this.prisma.equipamentos.findMany({
      where: {
        id: { in: equipamentosIds },
      },
      include: { tipo_equipamento_rel: true }
    });

    if (equipamentos.length === 0) {
      throw new NotFoundException('Nenhum equipamento válido encontrado');
    }

    // Definir o mês
    const now = new Date();
    const ano = mes ? parseInt(mes.split('-')[0]) : now.getFullYear();
    const mesNum = mes ? parseInt(mes.split('-')[1]) : now.getMonth() + 1;

    const dataInicio = new Date(ano, mesNum - 1, 1);
    const dataFim = new Date(ano, mesNum, 1);

    console.log(`📊 [GRÁFICO MÊS MÚLTIPLO] Período de busca:`);
    console.log(`📊 [GRÁFICO MÊS MÚLTIPLO]   De: ${dataInicio.toISOString()}`);
    console.log(`📊 [GRÁFICO MÊS MÚLTIPLO]   Até: ${dataFim.toISOString()}`);
    console.log(`📊 [GRÁFICO MÊS MÚLTIPLO] Equipamentos encontrados: ${equipamentos.length}`);

    // Buscar dados de todos os equipamentos da tabela equipamentos_dados
    const dados = await this.prisma.equipamentos_dados.findMany({
      where: {
        equipamento_id: { in: equipamentosIds },
        timestamp_dados: {
          gte: dataInicio,
          lt: dataFim,
        },
      },
      orderBy: { timestamp_dados: 'asc' },
      take: 50000, // ✅ LIMITE DE SEGURANÇA: máximo 50000 registros (múltiplos equipamentos × 30 dias)
      select: {
        equipamento_id: true,
        timestamp_dados: true,
        dados: true,
      },
    });

    console.log(`📊 [GRÁFICO MÊS MÚLTIPLO] Total de registros encontrados: ${dados.length}`);

    // Agrupar dados por dia
    const dadosAgrupados = new Map<string, {
      data: Date;
      potencias: number[];
      energias: number[];
      equipamentos: Set<string>;
    }>();

    dados.forEach((d: any) => {
      // Obter apenas a data (sem hora)
      const data = new Date(d.timestamp_dados);
      data.setHours(0, 0, 0, 0);
      const dataKey = data.toISOString().split('T')[0];

      if (!dadosAgrupados.has(dataKey)) {
        dadosAgrupados.set(dataKey, {
          data: data,
          potencias: [],
          energias: [],
          equipamentos: new Set(),
        });
      }

      const grupo = dadosAgrupados.get(dataKey)!;

      // Extrair potência (suportar múltiplas estruturas)
      let potenciaKw = 0;
      // ✅ NOVO: Priorizar campo potencia_kw (M160 formato Resumo)
      if (d.dados.potencia_kw !== undefined) {
        potenciaKw = d.dados.potencia_kw;
      } else if (d.dados.power?.active_total !== undefined) {
        potenciaKw = d.dados.power.active_total / 1000;
      } else if (d.dados.dc?.total_power !== undefined) {
        potenciaKw = d.dados.dc.total_power / 1000;
      } else if (d.dados.power?.active !== undefined) {
        potenciaKw = d.dados.power.active / 1000;
      } else if (d.dados.power_avg !== undefined) {
        potenciaKw = d.dados.power_avg;
      } else if (d.dados.potencia_ativa_kw !== undefined) {
        potenciaKw = d.dados.potencia_ativa_kw;
      } else if (d.dados.Pt !== undefined) {
        // ✅ NOVO FORMATO: Power Meter (M-160) com Pt na raiz
        potenciaKw = d.dados.Pt / 1000;
      } else if (d.dados.Dados) {
        // ✅ FORMATO LEGADO: Power Meter com Dados.Pt
        const Pa = d.dados.Dados.Pa || 0;
        const Pb = d.dados.Dados.Pb || 0;
        const Pc = d.dados.Dados.Pc || 0;
        potenciaKw = (Pa + Pb + Pc) / 1000;
      }

      // Extrair energia se disponível
      // ✅ NOVO: Priorizar campo energia_kwh (M160 formato Resumo)
      let energiaKwh = 0;
      if (d.dados.energia_kwh !== undefined) {
        energiaKwh = d.dados.energia_kwh;
      } else if (d.dados.energy?.daily_yield !== undefined) {
        energiaKwh = d.dados.energy.daily_yield / 1000;
      } else if (d.dados.energy?.period_energy_kwh !== undefined) {
        energiaKwh = d.dados.energy.period_energy_kwh;
      } else if (d.dados.Dados?.period_energy_kwh !== undefined) {
        energiaKwh = d.dados.Dados.period_energy_kwh;
      }

      if (potenciaKw > 0) {
        grupo.potencias.push(potenciaKw);
        // Estimativa de energia: potência * tempo (1 minuto = 1/60 hora)
        grupo.energias.push(potenciaKw / 60);
        grupo.equipamentos.add(d.equipamento_id);
      }

      if (energiaKwh > 0) {
        grupo.energias.push(energiaKwh);
      }
    });

    // Converter para array e calcular agregações
    const pontos = Array.from(dadosAgrupados.entries())
      .map(([dataKey, grupo]) => {
        const energiaTotal = grupo.energias.reduce((sum, e) => sum + e, 0);
        const potenciaMedia = grupo.potencias.length > 0 ?
          grupo.potencias.reduce((sum, p) => sum + p, 0) / grupo.potencias.length : 0;
        const potenciaMax = grupo.potencias.length > 0 ? Math.max(...grupo.potencias) : 0;

        return {
          data: dataKey,
          dia: grupo.data.getDate(),
          energia_kwh: energiaTotal,
          potencia_media_kw: potenciaMedia,
          potencia_max_kw: potenciaMax,
          num_inversores: grupo.equipamentos.size,
          num_registros: grupo.potencias.length,
        };
      })
      .sort((a, b) => new Date(a.data).getTime() - new Date(b.data).getTime());

    const energiaTotal = pontos.reduce((sum, p) => sum + p.energia_kwh, 0);

    console.log(`📊 [GRÁFICO MÊS MÚLTIPLO] Dias com dados: ${pontos.length}`);
    console.log(`📊 [GRÁFICO MÊS MÚLTIPLO] Energia total: ${energiaTotal} kWh`);

    return {
      mes: `${ano}-${String(mesNum).padStart(2, '0')}`,
      total_dias: pontos.length,
      total_inversores: equipamentos.length,
      energia_total_kwh: energiaTotal,
      inversores: equipamentos.map(eq => ({
        id: eq.id,
        nome: eq.nome,
      })),
      dados: pontos,
    };
  }

  /**
   * Gráfico do Ano para Múltiplos Equipamentos - Soma das energias
   * Agrega dados de múltiplos equipamentos selecionados (usando equipamentos_dados)
   */
  async getGraficoAnoMultiplosInversores(equipamentosIds: string[], ano?: string, user?: ScopedUser) {
    equipamentosIds = await this.filterEqIdsByScope(equipamentosIds, user);
    // ✅ VALIDAÇÃO: Limitar número de equipamentos para evitar sobrecarga
    if (equipamentosIds.length > 5) {
      throw new NotFoundException(
        `Máximo de 5 equipamentos permitidos por vez. Você selecionou ${equipamentosIds.length} equipamentos.`
      );
    }

    console.log(`\n📊 [GRÁFICO ANO MÚLTIPLO] ========================================`);
    console.log(`📊 [GRÁFICO ANO MÚLTIPLO] Equipamentos: ${equipamentosIds.join(', ')}`);
    console.log(`📊 [GRÁFICO ANO MÚLTIPLO] Ano solicitado: ${ano || 'atual'}`);

    // Buscar informações dos equipamentos
    const equipamentos = await this.prisma.equipamentos.findMany({
      where: {
        id: { in: equipamentosIds },
      },
      include: { tipo_equipamento_rel: true }
    });

    if (equipamentos.length === 0) {
      throw new NotFoundException('Nenhum equipamento válido encontrado');
    }

    // Definir o ano
    const anoConsulta = ano ? parseInt(ano) : new Date().getFullYear();
    const dataInicio = new Date(anoConsulta, 0, 1);
    const dataFim = new Date(anoConsulta + 1, 0, 1);

    console.log(`📊 [GRÁFICO ANO MÚLTIPLO] Período de busca:`);
    console.log(`📊 [GRÁFICO ANO MÚLTIPLO]   De: ${dataInicio.toISOString()}`);
    console.log(`📊 [GRÁFICO ANO MÚLTIPLO]   Até: ${dataFim.toISOString()}`);
    console.log(`📊 [GRÁFICO ANO MÚLTIPLO] Equipamentos encontrados: ${equipamentos.length}`);

    // Buscar dados de todos os equipamentos da tabela equipamentos_dados
    const dados = await this.prisma.equipamentos_dados.findMany({
      where: {
        equipamento_id: { in: equipamentosIds },
        timestamp_dados: {
          gte: dataInicio,
          lt: dataFim,
        },
      },
      orderBy: { timestamp_dados: 'asc' },
      take: 100000, // ✅ LIMITE DE SEGURANÇA: máximo 100000 registros (múltiplos equipamentos × 365 dias)
      select: {
        equipamento_id: true,
        timestamp_dados: true,
        dados: true,
      },
    });

    console.log(`📊 [GRÁFICO ANO MÚLTIPLO] Total de registros encontrados: ${dados.length}`);

    // Agrupar dados por mês
    const dadosAgrupados = new Map<string, {
      mes: number;
      ano: number;
      potencias: number[];
      energias: number[];
      equipamentos: Set<string>;
    }>();

    dados.forEach((d: any) => {
      const data = new Date(d.timestamp_dados);
      const mesKey = `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, '0')}`;

      if (!dadosAgrupados.has(mesKey)) {
        dadosAgrupados.set(mesKey, {
          mes: data.getMonth() + 1,
          ano: data.getFullYear(),
          potencias: [],
          energias: [],
          equipamentos: new Set(),
        });
      }

      const grupo = dadosAgrupados.get(mesKey)!;

      // Extrair potência (suportar múltiplas estruturas)
      let potenciaKw = 0;
      // ✅ NOVO: Priorizar campo potencia_kw (M160 formato Resumo)
      if (d.dados.potencia_kw !== undefined) {
        potenciaKw = d.dados.potencia_kw;
      } else if (d.dados.power?.active_total !== undefined) {
        potenciaKw = d.dados.power.active_total / 1000;
      } else if (d.dados.dc?.total_power !== undefined) {
        potenciaKw = d.dados.dc.total_power / 1000;
      } else if (d.dados.power?.active !== undefined) {
        potenciaKw = d.dados.power.active / 1000;
      } else if (d.dados.power_avg !== undefined) {
        potenciaKw = d.dados.power_avg;
      } else if (d.dados.potencia_ativa_kw !== undefined) {
        potenciaKw = d.dados.potencia_ativa_kw;
      } else if (d.dados.Pt !== undefined) {
        // ✅ NOVO FORMATO: Power Meter (M-160) com Pt na raiz
        potenciaKw = d.dados.Pt / 1000;
      } else if (d.dados.Dados) {
        // ✅ FORMATO LEGADO: Power Meter com Dados.Pt
        const Pa = d.dados.Dados.Pa || 0;
        const Pb = d.dados.Dados.Pb || 0;
        const Pc = d.dados.Dados.Pc || 0;
        potenciaKw = (Pa + Pb + Pc) / 1000;
      }

      // Extrair energia se disponível
      // ✅ NOVO: Priorizar campo energia_kwh (M160 formato Resumo)
      let energiaKwh = 0;
      if (d.dados.energia_kwh !== undefined) {
        energiaKwh = d.dados.energia_kwh;
      } else if (d.dados.energy?.daily_yield !== undefined) {
        energiaKwh = d.dados.energy.daily_yield / 1000;
      } else if (d.dados.energy?.period_energy_kwh !== undefined) {
        energiaKwh = d.dados.energy.period_energy_kwh;
      } else if (d.dados.Dados?.period_energy_kwh !== undefined) {
        energiaKwh = d.dados.Dados.period_energy_kwh;
      }

      if (potenciaKw > 0) {
        grupo.potencias.push(potenciaKw);
        // Estimativa de energia: potência * tempo (1 minuto = 1/60 hora)
        grupo.energias.push(potenciaKw / 60);
        grupo.equipamentos.add(d.equipamento_id);
      }

      if (energiaKwh > 0) {
        grupo.energias.push(energiaKwh);
      }
    });

    // Nomes dos meses em português
    const mesesPt = [
      'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
      'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
    ];

    // Converter para array e calcular agregações
    const pontos = Array.from(dadosAgrupados.entries())
      .map(([mesKey, grupo]) => {
        const energiaTotal = grupo.energias.reduce((sum, e) => sum + e, 0);
        const potenciaMedia = grupo.potencias.length > 0 ?
          grupo.potencias.reduce((sum, p) => sum + p, 0) / grupo.potencias.length : 0;
        const potenciaMax = grupo.potencias.length > 0 ? Math.max(...grupo.potencias) : 0;

        return {
          mes: mesKey,
          mes_numero: grupo.mes,
          mes_nome: mesesPt[grupo.mes - 1],
          energia_kwh: energiaTotal,
          potencia_media_kw: potenciaMedia,
          potencia_max_kw: potenciaMax,
          num_inversores: grupo.equipamentos.size,
          num_registros: grupo.potencias.length,
        };
      })
      .sort((a, b) => a.mes_numero - b.mes_numero);

    const energiaTotal = pontos.reduce((sum, p) => sum + p.energia_kwh, 0);

    console.log(`📊 [GRÁFICO ANO MÚLTIPLO] Meses com dados: ${pontos.length}`);
    console.log(`📊 [GRÁFICO ANO MÚLTIPLO] Energia total: ${energiaTotal} kWh`);

    return {
      ano: anoConsulta,
      total_meses: pontos.length,
      total_inversores: equipamentos.length,
      energia_total_kwh: energiaTotal,
      inversores: equipamentos.map(eq => ({
        id: eq.id,
        nome: eq.nome,
      })),
      dados: pontos,
    };
  }

  /**
   * Gráfico do Ano - Energia gerada por mês
   * Soma a energia de todos os minutos de cada mês
   */
  async getGraficoAno(equipamentoId: string, ano?: string, user?: ScopedUser) {
    await this.assertEqInScope(equipamentoId, user);
    console.log(`\n📊 [GRÁFICO ANO] ========================================`);
    console.log(`📊 [GRÁFICO ANO] Equipamento: ${equipamentoId}`);
    console.log(`📊 [GRÁFICO ANO] Ano solicitado: ${ano || 'atual'}`);

    // Verificar o tipo do equipamento
    const equipamento = await this.prisma.equipamentos.findUnique({
      where: { id: equipamentoId },
      include: { tipo_equipamento_rel: true }
    });

    if (!equipamento) {
      throw new NotFoundException(`Equipamento ${equipamentoId} não encontrado`);
    }

    // Definir o ano (atual se não especificado)
    const anoConsulta = ano ? parseInt(ano) : new Date().getFullYear();

    const dataInicio = new Date(anoConsulta, 0, 1);
    const dataFim = new Date(anoConsulta + 1, 0, 1);

    console.log(`📊 [GRÁFICO ANO] Período de busca:`);
    console.log(`📊 [GRÁFICO ANO]   De: ${dataInicio.toISOString()}`);
    console.log(`📊 [GRÁFICO ANO]   Até: ${dataFim.toISOString()}`);
    console.log(`📊 [GRÁFICO ANO] Tipo do equipamento: ${equipamento.tipo_equipamento_rel?.codigo}`);

    // ✅ Energia mensal por device = soma dos dias (mesma logica do mes):
    //   0. Inversor PV: por dia, MAX(energy.daily_yield) — contador diario robusto
    //      a glitch; somado no mes. (total_yield delta explodia com leitura zerada.)
    //   1. M-160: SUM(delta-phf positivo) — ver docs/tickets/powermeter-delta-phf.md
    //   2. Fallback inversor sem contador: energy.period_energy_kwh
    //   3. Fallback generico: coluna energia_kwh
    const dados = await this.prisma.$queryRaw<Array<any>>`
      WITH leituras AS (
        SELECT
          timestamp_dados,
          dados,
          CAST(dados->>'phf' AS NUMERIC) - LAG(CAST(dados->>'phf' AS NUMERIC))
            OVER (ORDER BY timestamp_dados ASC) AS delta_phf
        FROM equipamentos_dados
        WHERE equipamento_id = ${equipamentoId}
          AND timestamp_dados >= ${dataInicio}
          AND timestamp_dados < ${dataFim}
      )
      SELECT mes, mes_formatado, mes_nome,
             SUM(dia_kwh) as energia_kwh,
             SUM(n) as num_registros,
             AVG(dia_pot) as potencia_media_kw
      FROM (
        SELECT
          DATE_TRUNC('month', timestamp_dados) as mes,
          TO_CHAR(timestamp_dados, 'YYYY-MM') as mes_formatado,
          TO_CHAR(timestamp_dados, 'TMMonth') as mes_nome,
          DATE_TRUNC('day', timestamp_dados) as dia,
          CASE
            -- Inversor PV: contador diario daily_yield, robusto a glitch (o delta
            -- de total_yield explodia quando uma leitura vinha zerada). MAX por
            -- dia = total do dia.
            WHEN COUNT(dados->'energy'->>'daily_yield') >= 1
            THEN MAX((dados->'energy'->>'daily_yield')::numeric)
            ELSE SUM(
              COALESCE(
                -- M-160: delta-phf (>= 0 graças ao GREATEST). Inclui zero.
                CASE WHEN dados->>'phf' IS NOT NULL THEN delta_phf END,
                -- Senao: inversor sem contador (period_energy_kwh) ou generico.
                (dados->'energy'->>'period_energy_kwh')::numeric,
                (dados->>'energia_kwh')::numeric
              )
            )
          END as dia_kwh,
          COUNT(*) as n,
          AVG(
            COALESCE(
              (dados->'power'->>'active_total')::numeric / 1000.0,
              (dados->>'power_avg')::numeric
            )
          ) as dia_pot
        FROM leituras
        WHERE
          dados->>'phf' IS NOT NULL
          OR dados->'energy'->>'daily_yield' IS NOT NULL
          OR dados->'energy'->>'period_energy_kwh' IS NOT NULL
          OR dados->>'energia_kwh' IS NOT NULL
        GROUP BY mes, mes_formatado, mes_nome, dia
      ) t
      GROUP BY mes, mes_formatado, mes_nome
      ORDER BY mes ASC
    `;

    console.log(`📊 [GRÁFICO ANO] Meses com dados: ${dados.length}`);
    if (dados.length > 0) {
      console.log(`📊 [GRÁFICO ANO] Primeiro mês:`, {
        mes: dados[0].mes_formatado,
        energia_kwh: dados[0].energia_kwh,
        num_registros: dados[0].num_registros,
        potencia_media_kw: dados[0].potencia_media_kw,
      });
    }

    // Nomes dos meses em português
    const mesesPt = [
      'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
      'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
    ];

    // Transformar para formato do gráfico
    const pontos = dados.map((d: any) => {
      const mesNum = parseInt(d.mes_formatado.split('-')[1]);
      return {
        mes: d.mes_formatado,
        mes_numero: mesNum,
        mes_nome: mesesPt[mesNum - 1],
        energia_kwh: parseFloat(d.energia_kwh) || 0,
        potencia_media_kw: parseFloat(d.potencia_media_kw) || 0,
        num_registros: parseInt(d.num_registros),
      };
    });

    const energiaTotal = pontos.reduce((sum, p) => sum + p.energia_kwh, 0);

    console.log(`📊 [GRÁFICO ANO] Total de pontos: ${pontos.length}`);
    console.log(`📊 [GRÁFICO ANO] Energia total: ${energiaTotal} kWh`);
    console.log(`📊 [GRÁFICO ANO] ========================================\n`);

    return {
      ano: anoConsulta,
      total_meses: pontos.length,
      energia_total_kwh: energiaTotal,
      dados: pontos,
    };
  }

  // ============================================================================
  // ✅ VERSÕES OTIMIZADAS (V2) - Agregação no Banco de Dados
  // ============================================================================
  // Performance: 100x mais rápido (30s → 300ms)
  // Transferência: 13.500x menor (108 MB → 8 KB)
  // ============================================================================

  /**
   * 🚀 OTIMIZADO - Gráfico do Dia (Múltiplos Equipamentos)
   * Agregação no PostgreSQL com bucket dinâmico (5/30 min) baseado no range.
   *
   * Aceita configuração por equipamento (sinal +/- para geração/consumo e multiplicador),
   * permitindo cálculo de demanda líquida e agrupamentos heterogêneos.
   */
  async getGraficoDiaAgregado(
    equipamentos: EquipamentoAgregacaoConfig[],
    opts: OpcoesGraficoDia = {},
    user?: ScopedUser,
  ) {
    const equipsFiltrados = await this.filtrarEquipamentosPorScope(equipamentos, user);
    if (equipsFiltrados.length === 0) {
      return {
        data: opts.data ?? new Date().toISOString().split('T')[0],
        total_pontos: 0,
        total_inversores: 0,
        inversores: [],
        dados: [],
        agregacao: '5_minutos',
        energia_kwh: 0,
        registros_processados: 0,
      };
    }
    if (equipsFiltrados.length > LIMITE_EQUIPAMENTOS) {
      throw new NotFoundException(`Máximo de ${LIMITE_EQUIPAMENTOS} equipamentos permitidos por vez`);
    }

    const ids = equipsFiltrados.map(e => e.id);
    const configMap = new Map(equipsFiltrados.map(e => [e.id, e]));

    // Janela de tempo: inicio/fim > data > últimas 24h
    let dataInicio: Date;
    let dataFim: Date;

    if (opts.inicio && opts.fim) {
      dataInicio = new Date(opts.inicio);
      dataFim = new Date(opts.fim);
      const rangeDias = (dataFim.getTime() - dataInicio.getTime()) / 86400000;
      if (rangeDias > MAX_DIAS_CUSTOM) {
        throw new NotFoundException(`Range máximo do filtro personalizado é ${MAX_DIAS_CUSTOM} dias`);
      }
    } else if (opts.data) {
      dataInicio = new Date(opts.data);
      dataInicio.setHours(0, 0, 0, 0);
      dataFim = new Date(dataInicio);
      dataFim.setDate(dataFim.getDate() + 1);
    } else {
      // 'dia' sem parametro = HOJE em BRT (meia-noite local SP -> agora). Alinha a
      // energia com o que o grafico mostra e com o reset diario do daily_yield;
      // antes era ultimas 24h, que misturava parte de ontem e dobrava a energia.
      dataFim = new Date();
      const hojeSP = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(dataFim);
      dataInicio = new Date(`${hojeSP}T00:00:00-03:00`);
    }

    // Bucket: 5min para janelas até 24h, 30min para janelas maiores
    const rangeHoras = (dataFim.getTime() - dataInicio.getTime()) / 3600000;
    const bucketMin = rangeHoras > 24 ? 30 : 5;
    const fatorPerdas = opts.fatorPerdas ?? 0;

    this.logger.log(`⚡ [V2 DIA] ${equipsFiltrados.length} equipamentos, ${bucketMin}min, ${rangeHoras.toFixed(1)}h`);

    // CTE: calcula o intervalo (bucket) UMA vez por linha, depois agrupa.
    // Sem CTE, repetir a expressao no SELECT e no GROUP BY com ${bucketMin}
    // parametrizado faz Postgres tratar como duas expressoes distintas e
    // reclama: "column timestamp_dados must appear in GROUP BY".
    const dadosAgregados = await this.prisma.$queryRaw<Array<{
      intervalo: Date;
      equipamento_id: string;
      potencia_media: number;
      num_leituras: number;
    }>>`
      WITH base AS (
        SELECT
          DATE_TRUNC('minute', timestamp_dados) -
            (EXTRACT(minute FROM timestamp_dados)::int % ${bucketMin}) * INTERVAL '1 minute' AS intervalo,
          equipamento_id,
          potencia_ativa_kw
        FROM equipamentos_dados
        WHERE equipamento_id = ANY(${ids}::text[])
          AND timestamp_dados >= ${dataInicio}
          AND timestamp_dados < ${dataFim}
      )
      SELECT
        intervalo,
        equipamento_id,
        AVG(potencia_ativa_kw) AS potencia_media,
        COUNT(*) AS num_leituras
      FROM base
      GROUP BY intervalo, equipamento_id
      ORDER BY intervalo ASC
    `;

    const equipamentosDb = await this.prisma.equipamentos.findMany({
      where: { id: { in: ids } },
      select: { id: true, nome: true },
    });
    const equipamentosMap = new Map(equipamentosDb.map(e => [e.id.trim(), e.nome]));

    // CURVA (potência): forward-fill por device dentro de um cap de validade antes
    // de somar, pra eliminar o serrilhado (que nascia de buckets onde um device não
    // reportou e a soma despencava). Bridge de gaps curtos sem fabricar geração num
    // outage longo — aí a série do device simplesmente termina.
    // A ENERGIA total NÃO sai daqui: vem do contador acumulado de cada device
    // (ver totaisDevice abaixo), fonte mais fiel.
    const bucketMs = bucketMin * 60_000;
    const bucketHoras = bucketMin / 60; // só pra energia por-ponto (tooltip)
    const FILL_CAP_MS = 30 * 60_000; // bridge de até 30 min de gap

    // Trim do equipamento_id porque vem do Postgres como char(26) padded com
    // espacos (CLAUDE.md "Armadilhas Conhecidas"). configMap eh indexado por ID
    // trimmed que veio do request; sem trim, lookup falha e os agregados zeram.
    const porDevice = new Map<string, Map<number, { pot: number; num: number }>>();
    for (const row of dadosAgregados) {
      const id = row.equipamento_id.trim();
      if (!configMap.has(id)) continue;
      let serie = porDevice.get(id);
      if (!serie) { serie = new Map(); porDevice.set(id, serie); }
      serie.set(row.intervalo.getTime(), {
        pot: Number(row.potencia_media),
        num: Number(row.num_leituras),
      });
    }

    // Guarda contra glitch de potencia: descarta buckets absurdamente acima do
    // normal do proprio device (ex: frame ruim reportando MW num inversor de
    // ~100 kW). Teto auto-calibrado = max(piso, FATOR x mediana das leituras
    // positivas do device) — nao precisa de threshold fixo. Sem isso o
    // forward-fill espalhava o spike por ate 30 min = "demanda bizarramente alta".
    // A energia (daily_yield) ja e limitada e nao depende disto.
    const FATOR_GLITCH = 12;
    const PISO_TETO_KW = 50;
    for (const serie of porDevice.values()) {
      const positivos = Array.from(serie.values())
        .map(v => v.pot)
        .filter(p => p > 0)
        .sort((a, b) => a - b);
      if (positivos.length === 0) continue;
      const mediana = positivos[Math.floor(positivos.length / 2)];
      const teto = Math.max(PISO_TETO_KW, FATOR_GLITCH * mediana);
      const aRemover: number[] = [];
      for (const [t, v] of serie) if (v.pot > teto) aRemover.push(t);
      for (const t of aRemover) serie.delete(t);
    }

    const pontosMap = new Map<number, any>();

    for (const [id, serie] of porDevice) {
      const cfg = configMap.get(id)!;
      const nome = equipamentosMap.get(id) ?? id;
      // Perdas só em geração (sinal = 1).
      const reducao = cfg.sinal === 1 && fatorPerdas > 0 ? 1 - fatorPerdas / 100 : 1;
      const fator = cfg.multiplicador * reducao * cfg.sinal;

      // Span ativo do device: do primeiro ao último bucket com leitura.
      const tempos = Array.from(serie.keys()).sort((a, b) => a - b);
      const primeiro = tempos[0];
      const ultimo = tempos[tempos.length - 1];

      let ultimaPot: number | null = null;
      let ultimaT = -Infinity;
      for (let t = primeiro; t <= ultimo; t += bucketMs) {
        const atual = serie.get(t);
        let potBruta: number | null;
        let num = 0;
        if (atual) {
          potBruta = atual.pot;
          num = atual.num;
          ultimaPot = atual.pot;
          ultimaT = t;
        } else if (ultimaPot !== null && t - ultimaT <= FILL_CAP_MS) {
          potBruta = ultimaPot; // forward-fill dentro do cap
        } else {
          potBruta = null; // gap longo: sem dado, não fabrica geração
        }
        if (potBruta === null) continue;

        const potAjustada = potBruta * fator;
        const enAjustada = potAjustada * bucketHoras;

        let ponto = pontosMap.get(t);
        if (!ponto) {
          ponto = {
            timestamp: new Date(t),
            hora: new Date(t).toISOString(),
            potencia_kw: 0,
            energia_kwh: 0,
            num_leituras: 0,
            equipamentos: {},
          };
          pontosMap.set(t, ponto);
        }
        ponto.potencia_kw += potAjustada;
        ponto.energia_kwh += enAjustada;
        ponto.num_leituras += num;
        ponto.equipamentos[nome] = { potencia: potAjustada, energia: enAjustada };
      }
    }

    const pontos = Array.from(pontosMap.values()).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    // ENERGIA total por device, robusta a glitch: por DIA-BRT usa MAX(daily_yield)
    // — o contador diario do inversor (= "Geração Diária"), limitado e imune a
    // leitura espuria pra baixo. (Um total_yield zerado de reboot fazia o delta
    // MAX-MIN explodir pra energia de vida toda -> demanda bizarra.) Devices sem
    // daily_yield (gateway por pulsos, M160 por phf) caem em SUM(energia_kwh), ja
    // correto. Soma os dias do periodo (1 dia no 'dia'; varios no custom).
    const totaisDevice = await this.prisma.$queryRaw<Array<{
      equipamento_id: string;
      energia_total: number | null;
    }>>`
      SELECT equipamento_id, SUM(dia_kwh) AS energia_total
      FROM (
        SELECT
          equipamento_id,
          DATE_TRUNC('day', timestamp_dados AT TIME ZONE 'America/Sao_Paulo') AS dia,
          CASE
            WHEN COUNT(dados->'energy'->>'daily_yield') >= 1
            THEN MAX((dados->'energy'->>'daily_yield')::numeric)
            ELSE SUM(energia_kwh)
          END AS dia_kwh
        FROM equipamentos_dados
        WHERE equipamento_id = ANY(${ids}::text[])
          AND timestamp_dados >= ${dataInicio}
          AND timestamp_dados < ${dataFim}
        GROUP BY equipamento_id, dia
      ) t
      GROUP BY equipamento_id
    `;

    let energiaTotal = 0;
    for (const row of totaisDevice) {
      const cfg = configMap.get(row.equipamento_id.trim());
      if (!cfg) continue;
      const reducao = cfg.sinal === 1 && fatorPerdas > 0 ? 1 - fatorPerdas / 100 : 1;
      energiaTotal += (Number(row.energia_total) || 0) * cfg.multiplicador * reducao * cfg.sinal;
    }

    return {
      data: dataInicio.toISOString().split('T')[0],
      inicio: dataInicio.toISOString(),
      fim: dataFim.toISOString(),
      total_pontos: pontos.length,
      total_inversores: equipamentosDb.length,
      inversores: equipamentosDb.map(e => ({ id: e.id.trim(), nome: e.nome })),
      dados: pontos,
      agregacao: `${bucketMin}_minutos`,
      energia_kwh: energiaTotal,
      registros_processados: dadosAgregados.length,
    };
  }

  /**
   * 🚀 OTIMIZADO - Gráfico do Mês (Múltiplos Equipamentos)
   * Agregação no PostgreSQL (diária).
   *
   * Aceita configuração por equipamento (sinal +/- e multiplicador) para suportar
   * cálculo de demanda líquida em agrupamentos heterogêneos.
   */
  async getGraficoMesAgregado(
    equipamentos: EquipamentoAgregacaoConfig[],
    opts: OpcoesGraficoPeriodo = {},
    user?: ScopedUser,
  ) {
    const equipsFiltrados = await this.filtrarEquipamentosPorScope(equipamentos, user);
    if (equipsFiltrados.length === 0) {
      const agora = new Date();
      return {
        mes: opts.mes ?? `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}`,
        total_dias: 0,
        total_inversores: 0,
        energia_total_kwh: 0,
        inversores: [],
        dados: [],
        agregacao: 'dia',
        registros_processados: 0,
      };
    }
    if (equipsFiltrados.length > LIMITE_EQUIPAMENTOS) {
      throw new NotFoundException(`Máximo de ${LIMITE_EQUIPAMENTOS} equipamentos permitidos por vez`);
    }

    const ids = equipsFiltrados.map(e => e.id);
    const configMap = new Map(equipsFiltrados.map(e => [e.id, e]));
    const fatorPerdas = opts.fatorPerdas ?? 0;

    const now = new Date();
    const ano = opts.mes ? parseInt(opts.mes.split('-')[0]) : now.getFullYear();
    const mesNum = opts.mes ? parseInt(opts.mes.split('-')[1]) : now.getMonth() + 1;
    // Range em BRT (UTC-3) — sem isso o servidor (Node TZ variavel) interpreta
    // new Date(ano, mes-1, 1) como local do host e desloca o intervalo, o que
    // empurra leituras de antes da meia-noite BRT pro mes anterior.
    const dataInicio = new Date(`${ano}-${String(mesNum).padStart(2, '0')}-01T00:00:00-03:00`);
    const proxMes = mesNum === 12 ? { ano: ano + 1, mes: 1 } : { ano, mes: mesNum + 1 };
    const dataFim = new Date(`${proxMes.ano}-${String(proxMes.mes).padStart(2, '0')}-01T00:00:00-03:00`);

    this.logger.log(`⚡ [V2 MÊS] ${equipsFiltrados.length} equipamentos, ${ano}-${mesNum}`);

    const dadosAgregados = await this.prisma.$queryRaw<Array<{
      dia: Date;
      equipamento_id: string;
      energia_total: number;
      potencia_media: number;
      num_leituras: number;
    }>>`
      SELECT
        DATE_TRUNC('day', timestamp_dados AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
        equipamento_id,
        CASE
          WHEN COUNT(dados->'energy'->>'daily_yield') >= 1
          THEN MAX((dados->'energy'->>'daily_yield')::numeric)
          ELSE SUM(energia_kwh)
        END AS energia_total,
        AVG(potencia_ativa_kw) AS potencia_media,
        COUNT(*) AS num_leituras
      FROM equipamentos_dados
      WHERE equipamento_id = ANY(${ids}::text[])
        AND timestamp_dados >= ${dataInicio}
        AND timestamp_dados < ${dataFim}
      GROUP BY DATE_TRUNC('day', timestamp_dados AT TIME ZONE 'America/Sao_Paulo'), equipamento_id
      ORDER BY dia ASC
    `;

    const equipamentosDb = await this.prisma.equipamentos.findMany({
      where: { id: { in: ids } },
      select: { id: true, nome: true },
    });
    const equipamentosMap = new Map(equipamentosDb.map(e => [e.id.trim(), e.nome]));
    const pontosMap = new Map<string, any>();

    dadosAgregados.forEach(row => {
      // row.dia vem como Date(yyyy-mm-dd UTC midnight) do pg driver. getDate()
      // converte pro TZ local do Node — se Node=BRT, 2026-06-01Z vira 31/05
      // local e quebra o numero do dia. Extraindo do diaKey (UTC, ja casa com
      // o AT TIME ZONE 'America/Sao_Paulo' do SQL acima).
      const diaKey = row.dia.toISOString().split('T')[0];
      const diaDoMes = parseInt(diaKey.split('-')[2], 10);
      if (!pontosMap.has(diaKey)) {
        pontosMap.set(diaKey, {
          data: diaKey,
          dia: diaDoMes,
          energia_kwh: 0,
          potencia_media_kw: 0,
          num_leituras: 0,
          equipamentos: {},
        });
      }

      // Trim do equipamento_id porque vem do Postgres como char(26) padded com
      // espacos (CLAUDE.md "Armadilhas Conhecidas"). configMap eh indexado por
      // ID trimmed que veio do request; sem trim, lookup falha silenciosamente
      // e os agregados zeram.
      const cfg = configMap.get(row.equipamento_id.trim());
      if (!cfg) return;

      const reducao = cfg.sinal === 1 && fatorPerdas > 0 ? 1 - fatorPerdas / 100 : 1;
      const enAjustada = Number(row.energia_total) * cfg.multiplicador * reducao * cfg.sinal;
      const potAjustada = Number(row.potencia_media) * cfg.multiplicador * reducao * cfg.sinal;

      const ponto = pontosMap.get(diaKey);
      ponto.energia_kwh += enAjustada;
      ponto.potencia_media_kw += potAjustada;
      ponto.num_leituras += Number(row.num_leituras);
      ponto.equipamentos[equipamentosMap.get(row.equipamento_id.trim()) ?? row.equipamento_id.trim()] = {
        energia: enAjustada,
        potencia: potAjustada,
      };
    });

    const pontos = Array.from(pontosMap.values()).sort((a, b) => a.data.localeCompare(b.data));
    const energiaTotal = pontos.reduce((sum, p) => sum + p.energia_kwh, 0);

    return {
      mes: `${ano}-${String(mesNum).padStart(2, '0')}`,
      total_dias: pontos.length,
      total_inversores: equipamentosDb.length,
      energia_total_kwh: energiaTotal,
      inversores: equipamentosDb.map(e => ({ id: e.id.trim(), nome: e.nome })),
      dados: pontos,
      agregacao: 'dia',
      registros_processados: dadosAgregados.length,
    };
  }

  /**
   * 🚀 OTIMIZADO - Gráfico do Ano (Múltiplos Equipamentos)
   * Agregação no PostgreSQL (mensal).
   *
   * Aceita configuração por equipamento (sinal +/- e multiplicador).
   */
  async getGraficoAnoAgregado(
    equipamentos: EquipamentoAgregacaoConfig[],
    opts: OpcoesGraficoAno = {},
    user?: ScopedUser,
  ) {
    const equipsFiltrados = await this.filtrarEquipamentosPorScope(equipamentos, user);
    const anoNum = opts.ano ? parseInt(opts.ano) : new Date().getFullYear();
    if (equipsFiltrados.length === 0) {
      return {
        ano: anoNum,
        total_meses: 0,
        total_inversores: 0,
        energia_total_kwh: 0,
        inversores: [],
        dados: [],
        agregacao: 'mes',
        registros_processados: 0,
      };
    }
    if (equipsFiltrados.length > LIMITE_EQUIPAMENTOS) {
      throw new NotFoundException(`Máximo de ${LIMITE_EQUIPAMENTOS} equipamentos permitidos por vez`);
    }

    const ids = equipsFiltrados.map(e => e.id);
    const configMap = new Map(equipsFiltrados.map(e => [e.id, e]));
    const fatorPerdas = opts.fatorPerdas ?? 0;

    // Range em BRT — mesmo motivo do V2 MÊS (evita deslocamento do mes
    // por interpretacao de TZ local do host).
    const dataInicio = new Date(`${anoNum}-01-01T00:00:00-03:00`);
    const dataFim = new Date(`${anoNum + 1}-01-01T00:00:00-03:00`);

    this.logger.log(`⚡ [V2 ANO] ${equipsFiltrados.length} equipamentos, ${anoNum}`);

    const dadosAgregados = await this.prisma.$queryRaw<Array<{
      mes: Date;
      equipamento_id: string;
      energia_total: number;
      potencia_media: number;
      num_leituras: number;
    }>>`
      SELECT mes, equipamento_id,
             SUM(dia_kwh) AS energia_total,
             AVG(dia_pot) AS potencia_media,
             SUM(n) AS num_leituras
      FROM (
        SELECT
          DATE_TRUNC('month', timestamp_dados AT TIME ZONE 'America/Sao_Paulo')::date AS mes,
          DATE_TRUNC('day', timestamp_dados AT TIME ZONE 'America/Sao_Paulo') AS dia,
          equipamento_id,
          CASE
            WHEN COUNT(dados->'energy'->>'daily_yield') >= 1
            THEN MAX((dados->'energy'->>'daily_yield')::numeric)
            ELSE SUM(energia_kwh)
          END AS dia_kwh,
          AVG(potencia_ativa_kw) AS dia_pot,
          COUNT(*) AS n
        FROM equipamentos_dados
        WHERE equipamento_id = ANY(${ids}::text[])
          AND timestamp_dados >= ${dataInicio}
          AND timestamp_dados < ${dataFim}
        GROUP BY mes, dia, equipamento_id
      ) t
      GROUP BY mes, equipamento_id
      ORDER BY mes ASC
    `;

    const equipamentosDb = await this.prisma.equipamentos.findMany({
      where: { id: { in: ids } },
      select: { id: true, nome: true },
    });
    const equipamentosMap = new Map(equipamentosDb.map(e => [e.id.trim(), e.nome]));
    const mesesPt = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const pontosMap = new Map<string, any>();

    dadosAgregados.forEach(row => {
      // Extrair ano/mes do toISOString() em UTC (bate com AT TIME ZONE
      // 'America/Sao_Paulo' do SQL). NUNCA usar getMonth/getFullYear do Date
      // raw — eles convertem pra TZ local do Node e desalinham vs. o SQL.
      const isoDay = row.mes.toISOString().split('T')[0]; // YYYY-MM-DD
      const [, mesStr] = isoDay.split('-');
      const mesKey = isoDay.slice(0, 7); // YYYY-MM
      const mesNumero = parseInt(mesStr, 10);

      if (!pontosMap.has(mesKey)) {
        pontosMap.set(mesKey, {
          mes: mesKey,
          mes_numero: mesNumero,
          mes_nome: mesesPt[mesNumero - 1],
          energia_kwh: 0,
          potencia_media_kw: 0,
          num_leituras: 0,
          equipamentos: {},
        });
      }

      // Trim do equipamento_id porque vem do Postgres como char(26) padded com
      // espacos (CLAUDE.md "Armadilhas Conhecidas"). configMap eh indexado por
      // ID trimmed que veio do request; sem trim, lookup falha silenciosamente
      // e os agregados zeram.
      const cfg = configMap.get(row.equipamento_id.trim());
      if (!cfg) return;

      const reducao = cfg.sinal === 1 && fatorPerdas > 0 ? 1 - fatorPerdas / 100 : 1;
      const enAjustada = Number(row.energia_total) * cfg.multiplicador * reducao * cfg.sinal;
      const potAjustada = Number(row.potencia_media) * cfg.multiplicador * reducao * cfg.sinal;

      const ponto = pontosMap.get(mesKey);
      ponto.energia_kwh += enAjustada;
      ponto.potencia_media_kw += potAjustada;
      ponto.num_leituras += Number(row.num_leituras);
      ponto.equipamentos[equipamentosMap.get(row.equipamento_id.trim()) ?? row.equipamento_id.trim()] = {
        energia: enAjustada,
        potencia: potAjustada,
      };
    });

    const pontos = Array.from(pontosMap.values()).sort((a, b) => a.mes_numero - b.mes_numero);
    const energiaTotal = pontos.reduce((sum, p) => sum + p.energia_kwh, 0);

    return {
      ano: anoNum,
      total_meses: pontos.length,
      total_inversores: equipamentosDb.length,
      energia_total_kwh: energiaTotal,
      inversores: equipamentosDb.map(e => ({ id: e.id.trim(), nome: e.nome })),
      dados: pontos,
      agregacao: 'mes',
      registros_processados: dadosAgregados.length,
    };
  }

  /**
   * Filtra equipamentos pelo scope do usuário, preservando sinal/multiplicador.
   */
  private async filtrarEquipamentosPorScope(
    equipamentos: EquipamentoAgregacaoConfig[],
    user?: ScopedUser,
  ): Promise<EquipamentoAgregacaoConfig[]> {
    if (!equipamentos || equipamentos.length === 0) return [];
    const idsTrimmed = equipamentos.map(e => ({ ...e, id: e.id.trim() })).filter(e => e.id);
    const ids = idsTrimmed.map(e => e.id);
    const permitidos = await this.filterEqIdsByScope(ids, user);
    const permitidosSet = new Set(permitidos);
    return idsTrimmed.filter(e => permitidosSet.has(e.id));
  }
}

const LIMITE_EQUIPAMENTOS = 50;
const MAX_DIAS_CUSTOM = 31;

export interface EquipamentoAgregacaoConfig {
  id: string;
  sinal: 1 | -1;
  multiplicador: number;
}

export interface OpcoesGraficoDia {
  data?: string;
  inicio?: string;
  fim?: string;
  fatorPerdas?: number;
}

export interface OpcoesGraficoPeriodo {
  mes?: string;
  fatorPerdas?: number;
}

export interface OpcoesGraficoAno {
  ano?: string;
  fatorPerdas?: number;
}
