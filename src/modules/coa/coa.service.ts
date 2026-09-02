import { Injectable, Logger } from '@nestjs/common';
import { PrismaService, PermissionScopeService, ScopedUser } from '@/core';
import { Prisma } from '@/core';
import { CalculoCustosService } from '../equipamentos-dados/services/calculo-custos.service';
import { detectarOverflowUint, ehPotenciaGlitch, CAP_POTENCIA_GLITCH_KW } from '../../shared/util/inverter-overflow';
import { CATEGORIA_SINAL_PAIRS } from '../../shared/util/categoria-fluxo.backend';

export interface DashboardData {
  timestamp: Date;
  resumoGeral: {
    totalGeracao: number;
    totalConsumo: number;
    balancoRede: number;
    totalUnidades: number;
    unidadesOnline: number;
    alertasAtivos: number;
    totalGeradores: number;
    totalCargas: number;
    custoTotalHoje?: number; // ✅ NOVO: Custo total agregado do dia
  };
  plantas: PlantaResumo[];
  alertas: Alerta[];
}

export interface PlantaResumo {
  id: string;
  nome: string;
  cliente: string;
  unidades: UnidadeResumo[];
  totais: {
    geracao: number;
    consumo: number;
    unidadesAtivas: number;
  };
}

export interface UnidadeResumo {
  id: string;
  nome: string;
  tipo: string;
  status: 'ONLINE' | 'OFFLINE' | 'ALERTA';
  trip?: boolean; // TRIP real (SOE não reconhecido) — vermelho no COA, distinto de OFFLINE (sem info)
  nuvem?: boolean; // sem TON ao vivo, mas com geração de NUVEM recente (cor própria, não é offline)
  equipamentosOffline?: string[]; // nomes de equipamentos sem comunicação (pior-caso do status)
  ultimaLeitura: Date | null;
  coordenadas?: {
    latitude: number;
    longitude: number;
  };
  cidade?: string;
  estado?: string;
  potenciaInstalada: number; // ✅ NOVO: Potência instalada/cadastrada da unidade (kW)
  metricas: {
    potenciaAtual: number;
    energiaHoje: number;
    fatorPotencia: number;
    custoEnergiaHoje?: number; // ✅ NOVO: Custo de energia do dia desta unidade
  };
}

export interface Alerta {
  id: string;
  tipo: string;
  severidade: 'info' | 'warning' | 'critical';
  mensagem: string;
  unidadeId: string;
  unidadeNome: string;
  timestamp: Date;
}

@Injectable()
export class CoaService {
  private readonly logger = new Logger(CoaService.name);
  private cache = new Map<string, { data: any; timestamp: number }>();
  private readonly CACHE_TTL = 30000; // 30 segundos
  private readonly TEMPO_OFFLINE = 10 * 60 * 1000; // 10 minutos

  constructor(
    private readonly prisma: PrismaService,
    private readonly calculoCustosService: CalculoCustosService,
    private readonly scopeService: PermissionScopeService,
  ) {}

  /**
   * Retorna dados agregados para o dashboard COA
   * Com cache de 30 segundos para otimização. Cache key inclui o user para
   * nao compartilhar dados entre usuarios com scopes diferentes.
   */
  async getDashboardData(clienteId?: string, user?: ScopedUser): Promise<DashboardData> {
    this.logger.log(`[COA] getDashboardData chamado - clienteId: ${clienteId || 'none'} user=${user?.id || 'none'} role=${user?.role || 'none'}`);
    const cacheKey = `dashboard-${user?.id?.trim() || 'anon'}-${clienteId || 'all'}`;
    const cached = this.cache.get(cacheKey);

    // Retorna cache se ainda válido
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      this.logger.log(`[COA] Retornando dados do cache para ${cacheKey}`);
      return cached.data;
    }

    this.logger.log(`[COA] Buscando dados frescos para ${cacheKey}`);

    try {
      // Buscar dados agregados
      const data = await this.fetchDashboardData(clienteId, user);

      // Atualizar cache
      this.cache.set(cacheKey, {
        data,
        timestamp: Date.now()
      });

      // Limpar cache antigo periodicamente
      this.cleanupCache();

      return data;
    } catch (error) {
      this.logger.error('Erro ao buscar dados do dashboard:', error);

      // Se houver erro, retorna cache mesmo vencido
      if (cached) {
        this.logger.warn('Retornando cache vencido devido a erro');
        return cached.data;
      }

      throw error;
    }
  }

  /**
   * Calcula custos de energia agregados para unidades com M160 ativo
   * ✅ PRÉ-FILTRO: Só calcula para unidades com equipamento M160 e tópico MQTT ativo
   */
  private async calcularCustosAgregados(unidades: any[]): Promise<Map<string, number>> {
    const custosPorUnidade = new Map<string, number>();
    const hoje = new Date();
    const inicioDia = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate(), 0, 0, 0);

    this.logger.log(`[CUSTOS] Calculando custos para ${unidades.length} unidades`);

    // Processar unidades em paralelo (mas com limite para não sobrecarregar)
    const BATCH_SIZE = 5;
    for (let i = 0; i < unidades.length; i += BATCH_SIZE) {
      const batch = unidades.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map(async (unidade) => {
          try {
            // 1. Buscar equipamentos M160 da unidade com tópico MQTT ativo
            const equipamentosM160 = await this.prisma.equipamentos.findMany({
              where: {
                unidade_id: unidade.id,
                deleted_at: null,
                tipo_equipamento: {
                  contains: 'M-160', // Filtrar M160
                },
                topico_mqtt: {
                  not: null, // Deve ter tópico MQTT configurado
                },
              },
              select: {
                id: true,
                nome: true,
                topico_mqtt: true,
              },
            });

            // 2. Pré-filtrar: se não tiver M160 com MQTT, pular
            if (equipamentosM160.length === 0) {
              this.logger.debug(`[CUSTOS] Unidade ${unidade.nome} sem M160 ativo - pulando`);
              return;
            }

            // 3. Pegar o primeiro M160 (geralmente há apenas 1 por unidade)
            const medidor = equipamentosM160[0];
            this.logger.debug(`[CUSTOS] Calculando custo para unidade ${unidade.nome} usando ${medidor.nome}`);

            // 4. Calcular custos do dia usando o serviço existente
            const resultado = await this.calculoCustosService.calcularCustos(
              medidor.id,
              inicioDia,
              hoje,
              'dia',
            );

            // 5. Armazenar custo total
            custosPorUnidade.set(unidade.id, resultado.custos.custo_total);
            this.logger.debug(`[CUSTOS] Unidade ${unidade.nome}: R$ ${resultado.custos.custo_total.toFixed(2)}`);

          } catch (error) {
            // Ignorar erros individuais (ex: unidade sem concessionária)
            this.logger.warn(`[CUSTOS] Erro ao calcular custo da unidade ${unidade.nome}: ${error.message}`);
          }
        })
      );
    }

    const totalCalculado = Array.from(custosPorUnidade.values()).reduce((sum, v) => sum + v, 0);
    this.logger.log(`[CUSTOS] Total calculado: R$ ${totalCalculado.toFixed(2)} para ${custosPorUnidade.size} unidades`);

    return custosPorUnidade;
  }

  /**
   * Busca dados do banco de forma otimizada
   */
  private async fetchDashboardData(clienteId?: string, user?: ScopedUser): Promise<DashboardData> {
    // 1. Buscar estrutura de plantas e unidades
    // Nota: plantas não têm cliente_id direto, têm proprietario_id (usuário)
    // Scope RBAC: operador/proprietario ve apenas as plantas vinculadas via planta_operadores / proprietario_id.
    const scope = await this.scopeService.getScope(user);
    const scopeFilter = this.scopeService.isScoped(scope)
      ? (scope.length === 0 ? { id: '__NEVER__' } : { id: { in: scope } })
      : {};

    const plantas = await this.prisma.plantas.findMany({
      where: {
        deleted_at: null,
        ...(clienteId && { proprietario_id: clienteId }),
        ...scopeFilter,
      },
      select: {
        id: true,
        nome: true,
        proprietario: {
          select: {
            nome: true,
          },
        },
      },
    });

    // 2. Buscar unidades com suas plantas
    const unidades = await this.prisma.unidades.findMany({
      where: {
        deleted_at: null,
        planta_id: {
          in: plantas.map(p => p.id),
        },
      },
      select: {
        id: true,
        nome: true,
        tipo: true,
        potencia: true, // ✅ NOVO: Potência instalada/cadastrada
        latitude: true,
        longitude: true,
        cidade: true,
        estado: true,
        planta_id: true,
        equipamentos: {
          where: { deleted_at: null },
          select: {
            id: true,
            nome: true,
          },
        },
      },
    });

    // 2.5. Calcular custos de energia para unidades do tipo "Carga" com M160 ativo
    this.logger.log('[COA] Calculando custos de energia...');
    const unidadesCargas = unidades.filter(u => u.tipo === 'Carga');
    const custosPorUnidade = await this.calcularCustosAgregados(unidadesCargas);

    // 3. Buscar últimas leituras de todos os equipamentos (query otimizada)
    const horaAtras = new Date(Date.now() - 60 * 60 * 1000); // 1 hora atrás

    const ultimasLeituras = await this.prisma.$queryRaw<any[]>`
      WITH UltimasLeituras AS (
        SELECT DISTINCT ON (ed.equipamento_id)
          ed.equipamento_id,
          ed.dados,
          ed.potencia_ativa_kw,
          ed.energia_kwh,
          ed.timestamp_dados,
          ed.qualidade,
          e.unidade_id,
          e.nome AS equipamento_nome,
          e.tipo_equipamento
        FROM equipamentos_dados ed
        INNER JOIN equipamentos e ON e.id = ed.equipamento_id
        WHERE ed.timestamp_dados >= ${horaAtras}
          AND e.deleted_at IS NULL
        ORDER BY ed.equipamento_id, ed.timestamp_dados DESC
      )
      SELECT * FROM UltimasLeituras
    `;

    // 3.5. Energia do dia por unidade — SEGUE a configuracao do grafico de demanda.
    // Em vez de agregar TODOS os equipamentos, soma apenas os equipamentos
    // selecionados na configuracao_demanda da unidade, com o sinal por categoria
    // (geracao +1, consumo -1) e o fator de perdas — batendo com a energia "no
    // periodo (dia)" do grafico. Usa o MESMO metodo do grafico (totaisDevice em
    // equipamentos-dados.service.ts): por device, por dia-BRT, MAX(daily_yield) ou
    // SUM(energia_kwh). Boundary em BRT (America/Sao_Paulo), igual ao grafico.
    // Unidades SEM configuracao caem no fallback legado (somar tudo) mais abaixo.
    // .trim() obrigatorio: unidades.id e char(26) padded com espaco no fim. No
    // ANY(${unidadeIds}::text[]) o Postgres trima a coluna bpchar ao castar p/ text,
    // entao um array padded NAO casa (query voltava []). Mantemos o map canonico
    // TRIMADO ponta a ponta (set/has/get) pra o faltantes e o consumo baterem.
    const unidadeIds = unidades.map(u => u.id.trim());

    // Janela "hoje" em BRT (mesmo padrao do grafico de demanda): meia-noite SP -> agora.
    const agora = new Date();
    const hojeSP = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(agora);
    const dataInicioBRT = new Date(`${hojeSP}T00:00:00-03:00`);
    const dataFimBRT = agora;

    // Tabela VALUES (categoria -> sinal) a partir do mirror do CATEGORIA_FLUXO do
    // front (categoria-fluxo.backend.ts). AMBIGUO/NEUTRO/categoria desconhecida ficam
    // de fora (o INNER JOIN cat_sinal nao casa) — paridade com o grafico de demanda.
    const catSinalValues = Prisma.join(
      CATEGORIA_SINAL_PAIRS.map(([nome, sinal]) => Prisma.sql`(${nome}::text, ${sinal}::int)`),
      ', ',
    );

    const energiaConfigDia = unidadeIds.length === 0 ? [] : await this.prisma.$queryRaw<any[]>(Prisma.sql`
      WITH cat_sinal(categoria_nome, sinal) AS (
        VALUES ${catSinalValues}
      ),
      sel AS (
        -- expande equipamentos_ids (Json: array de IDs ja trimados) por unidade
        SELECT cd.unidade_id,
               trim(elem.value) AS equipamento_id,
               cd.aplicar_perdas,
               cd.fator_perdas
        FROM configuracao_demanda cd
        CROSS JOIN LATERAL json_array_elements_text(cd.equipamentos_ids::json) AS elem(value)
        WHERE cd.unidade_id = ANY(${unidadeIds}::text[])
          AND json_typeof(cd.equipamentos_ids::json) = 'array'
      ),
      dev AS (
        -- categoria + sinal; INNER JOIN cat_sinal exclui NEUTRO/AMBIGUO/categoria nula.
        -- equipamentos.id e char(26) padded; sel.equipamento_id veio trimado do JSON.
        SELECT s.unidade_id, e.id AS equipamento_id, cs.sinal, s.aplicar_perdas, s.fator_perdas
        FROM sel s
        JOIN equipamentos e ON trim(e.id) = s.equipamento_id AND e.deleted_at IS NULL
        JOIN tipos_equipamentos te ON te.id = e.tipo_equipamento_id
        JOIN categorias_equipamentos ce ON ce.id = te.categoria_id
        JOIN cat_sinal cs ON cs.categoria_nome = ce.nome
      ),
      energia_dia AS (
        -- MESMO metodo do totaisDevice: por device, por dia-BRT
        SELECT equipamento_id,
               DATE_TRUNC('day', timestamp_dados AT TIME ZONE 'America/Sao_Paulo') AS dia,
               CASE WHEN COUNT(dados->'energy'->>'daily_yield') >= 1
                    THEN MAX((dados->'energy'->>'daily_yield')::numeric)
                    ELSE SUM(energia_kwh) END AS dia_kwh
        FROM equipamentos_dados
        WHERE equipamento_id IN (SELECT equipamento_id FROM dev)
          AND timestamp_dados >= ${dataInicioBRT}
          AND timestamp_dados <  ${dataFimBRT}
          AND (potencia_ativa_kw IS NULL OR potencia_ativa_kw < ${CAP_POTENCIA_GLITCH_KW})
        GROUP BY equipamento_id, dia
      ),
      energia_device AS (
        SELECT equipamento_id, SUM(dia_kwh) AS energia_total
        FROM energia_dia GROUP BY equipamento_id
      )
      SELECT d.unidade_id,
             SUM(
               COALESCE(ed.energia_total, 0) * d.sinal
               * CASE WHEN d.sinal = 1 AND d.aplicar_perdas AND d.fator_perdas > 0
                      THEN 1 - d.fator_perdas / 100.0 ELSE 1 END
             ) AS energia_dia_kwh
      FROM dev d
      LEFT JOIN energia_device ed ON ed.equipamento_id = d.equipamento_id
      GROUP BY d.unidade_id
    `);

    // Mapa de energia diaria por unidade (config-driven)
    const energiaDiaPorUnidade = new Map<string, number>();
    for (const row of energiaConfigDia) {
      energiaDiaPorUnidade.set(String(row.unidade_id).trim(), Number(row.energia_dia_kwh) || 0);
    }

    // Fallback legado: unidades SEM configuracao_demanda (ou sem equipamento que
    // soma) nao aparecem acima. Pra elas, mantem o comportamento antigo (agregar
    // TODOS os equipamentos). Roda a query legada SO pro subconjunto faltante.
    // Boundary aqui e CURRENT_DATE (UTC), como era — coerente com o card de custo.
    const faltantes = unidadeIds.filter(id => !energiaDiaPorUnidade.has(id));
    if (faltantes.length > 0) {
      const energiaLegado = await this.prisma.$queryRaw<any[]>`
        WITH DadosDia AS (
          SELECT
            e.unidade_id,
            te.nome AS tipo_equipamento,
            ed.equipamento_id,
            ed.dados,
            ed.energia_kwh,
            ed.timestamp_dados,
            ROW_NUMBER() OVER (PARTITION BY ed.equipamento_id ORDER BY ed.timestamp_dados DESC) as rn_ultima
          FROM equipamentos_dados ed
          INNER JOIN equipamentos e ON e.id = ed.equipamento_id
          INNER JOIN tipos_equipamentos te ON te.id = e.tipo_equipamento_id
          WHERE ed.timestamp_dados >= CURRENT_DATE::timestamp
            AND e.deleted_at IS NULL
            AND e.unidade_id = ANY(${faltantes}::text[])
            AND (ed.potencia_ativa_kw IS NULL OR ed.potencia_ativa_kw < ${CAP_POTENCIA_GLITCH_KW})
        ),
        EnergiaM160Deltas AS (
          -- M160: delta-phf cumulativo (phf[i] - MAX(phf anteriores)); descarta glitch
          -- isolado de phf. Window function em CTE separada do SUM.
          SELECT
            unidade_id,
            GREATEST(
              COALESCE(
                CAST(dados->>'phf' AS NUMERIC) - MAX(CAST(dados->>'phf' AS NUMERIC))
                  OVER (
                    PARTITION BY equipamento_id
                    ORDER BY timestamp_dados ASC
                    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                  ),
                0
              ),
              0
            ) AS delta_kwh
          FROM DadosDia
          WHERE (tipo_equipamento ILIKE '%M-160%' OR tipo_equipamento ILIKE '%M160%')
            AND dados->>'phf' IS NOT NULL
        ),
        EnergiaM160 AS (
          SELECT unidade_id, SUM(delta_kwh) AS energia_dia_kwh
          FROM EnergiaM160Deltas GROUP BY unidade_id
        ),
        EnergiaInversores AS (
          -- Inversores: energy.daily_yield da ultima leitura (JA EM kWh).
          SELECT
            unidade_id,
            COALESCE(
              CAST((dados->>'energy')::jsonb->>'daily_yield' AS NUMERIC),
              CAST(dados->>'daily_yield' AS NUMERIC),
              0
            ) as energia_dia_kwh
          FROM DadosDia
          WHERE rn_ultima = 1
            AND tipo_equipamento ILIKE '%INVERSOR%'
            AND (dados->>'energy' IS NOT NULL OR dados->>'daily_yield' IS NOT NULL)
        ),
        EnergiaOutros AS (
          SELECT unidade_id, SUM(COALESCE(energia_kwh, 0)) as energia_dia_kwh
          FROM DadosDia
          WHERE tipo_equipamento NOT ILIKE '%INVERSOR%'
            AND tipo_equipamento NOT ILIKE '%M-160%'
            AND tipo_equipamento NOT ILIKE '%M160%'
          GROUP BY unidade_id
        ),
        EnergiaUnificada AS (
          SELECT * FROM EnergiaM160
          UNION ALL SELECT * FROM EnergiaInversores
          UNION ALL SELECT * FROM EnergiaOutros
        )
        SELECT unidade_id, SUM(energia_dia_kwh) as energia_dia_kwh
        FROM EnergiaUnificada
        GROUP BY unidade_id
      `;
      for (const row of energiaLegado) {
        energiaDiaPorUnidade.set(String(row.unidade_id).trim(), Number(row.energia_dia_kwh) || 0);
      }
    }
    this.logger.log(`[COA] Energia hoje: ${energiaConfigDia.length} unidade(s) via config de demanda, ${faltantes.length} via fallback legado (somar tudo)`);

    // DEBUG: Mostrar resultado bruto da query config-driven
    this.logger.debug(`[COA DEBUG] energiaConfigDia raw:`, JSON.stringify(energiaConfigDia, null, 2));

    // 4. Criar mapa de leituras por unidade
    const leiturasPorUnidade = new Map<string, any[]>();
    for (const leitura of ultimasLeituras) {
      if (!leiturasPorUnidade.has(leitura.unidade_id)) {
        leiturasPorUnidade.set(leitura.unidade_id, []);
      }
      leiturasPorUnidade.get(leitura.unidade_id)!.push(leitura);
    }

    // 5. Processar dados das plantas e unidades
    const plantasProcessadas: PlantaResumo[] = [];
    const alertas: Alerta[] = [];
    let totalGeracao = 0;
    let totalConsumo = 0;
    let unidadesOnline = 0;
    let totalUnidades = 0;
    let totalGeradores = 0;
    let totalCargas = 0;
    const equipamentosContados = new Set<string>(); // Para evitar contar o mesmo equipamento duas vezes

    // Agrupar unidades por planta
    const unidadesPorPlanta = new Map<string, typeof unidades>();
    for (const unidade of unidades) {
      if (!unidadesPorPlanta.has(unidade.planta_id)) {
        unidadesPorPlanta.set(unidade.planta_id, []);
      }
      unidadesPorPlanta.get(unidade.planta_id)!.push(unidade);
    }

    // Unidades com TRIP real ativo (SOE não reconhecido) → vermelho no COA,
    // distinto de OFFLINE (sem info, cinza). reconhecido_em/dados_snapshot são raw.
    const tripUnidades = new Set<string>();
    try {
      const tripRows = await this.prisma.$queryRaw<Array<{ unidade_id: string }>>`
        SELECT DISTINCT TRIM(e.unidade_id) AS unidade_id
        FROM logs_mqtt l
        JOIN equipamentos e ON TRIM(e.id) = TRIM(l.equipamento_id)
        WHERE l.dados_snapshot->>'kind' = 'trip'
          AND l.reconhecido_em IS NULL
          AND e.deleted_at IS NULL
      `;
      for (const r of tripRows) if (r?.unidade_id) tripUnidades.add(String(r.unidade_id).trim());
    } catch (e) {
      this.logger.warn(`[COA] consulta de trips falhou (segue sem destaque): ${e instanceof Error ? e.message : e}`);
    }

    // Equipamentos esperados (mqtt_habilitado) por unidade — pra saber se ALGUM
    // está sem reportar (unidade não pode ficar verde com equipamento off).
    const expectedPorUnidade = new Map<string, Array<{ id: string; nome: string }>>();
    try {
      // "Esperado" = mqtt_habilitado QUE REALMENTE REPORTA (dado nos últimos 7 dias).
      // Sem o EXISTS, equipamento marcado mqtt_habilitado mas que NUNCA enviou (cadastro/
      // diagrama: disjuntor, trafo, TON sem feed, "Power Meter" fantasma) deixava a
      // unidade perma-AMARELA. Só conta quem tem feed real.
      const eqRows = await this.prisma.$queryRaw<Array<{ id: string; nome: string; unidade_id: string }>>`
        SELECT TRIM(e.id) AS id, e.nome, TRIM(e.unidade_id) AS unidade_id
        FROM equipamentos e
        WHERE e.mqtt_habilitado = true AND e.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM equipamentos_dados ed
            WHERE TRIM(ed.equipamento_id) = TRIM(e.id)
              AND ed.timestamp_dados > now() - interval '7 days'
          )
      `;
      for (const r of eqRows) {
        const uid = String(r.unidade_id || '').trim();
        if (!uid) continue;
        if (!expectedPorUnidade.has(uid)) expectedPorUnidade.set(uid, []);
        expectedPorUnidade.get(uid)!.push({ id: String(r.id).trim(), nome: r.nome });
      }
    } catch (e) {
      this.logger.warn(`[COA] consulta de equipamentos esperados falhou: ${e instanceof Error ? e.message : e}`);
    }

    // Unidades com geração de NUVEM recente (últimos 2 dias) — monitoradas por nuvem
    // (dado diário), sem TON ao vivo. Ganham cor própria no COA (não "sem info"/cinza).
    const cloudRecentUnidades = new Set<string>();
    try {
      const cloudRows = await this.prisma.$queryRaw<Array<{ unidade_id: string }>>`
        SELECT DISTINCT TRIM(unidade_id) AS unidade_id
        FROM geracao_diaria_plantas
        WHERE data >= current_date - 1 AND COALESCE(kwh_realizado, 0) > 0
      `;
      for (const r of cloudRows) if (r?.unidade_id) cloudRecentUnidades.add(String(r.unidade_id).trim());
    } catch (e) {
      this.logger.warn(`[COA] consulta de nuvem recente falhou: ${e instanceof Error ? e.message : e}`);
    }

    for (const planta of plantas) {
      const unidadesPlanta = unidadesPorPlanta.get(planta.id) || [];
      const unidadesProcessadas: UnidadeResumo[] = [];
      let geracaoPlanta = 0;
      let consumoPlanta = 0;
      let unidadesAtivasPlanta = 0;

      for (const unidade of unidadesPlanta) {
        totalUnidades++;

        const leiturasUnidade = leiturasPorUnidade.get(unidade.id) || [];

        // Calcular métricas da unidade
        let potenciaTotal = 0;
        let fatorPotencia = 0;
        let ultimaLeitura: Date | null = null;
        // Status "pior caso": ONLINE (verde) só se TODOS os equipamentos esperados
        // estão frescos. Qualquer um off (velho ou silencioso) → ALERTA; nada atual
        // → OFFLINE (sem info).
        let freshCount = 0;
        let suspeito = false;
        const reportingIds = new Set<string>();
        const offlineNomes: string[] = [];

        // ✅ CORRIGIDO: Usar energia agregada do dia (soma de todas as leituras desde meia-noite)
        // Em vez de somar apenas as últimas leituras
        const energiaTotal = energiaDiaPorUnidade.get(unidade.id.trim()) || 0;

        // DEBUG: Log energia por unidade
        if (energiaTotal > 0) {
          this.logger.log(`[COA] Unidade ${unidade.nome} (${unidade.tipo}): energia = ${energiaTotal} kWh`);
        }

        for (const leitura of leiturasUnidade) {
          // Extrair potência - tentar coluna primeiro, depois JSON
          let potencia = Number(leitura.potencia_ativa_kw) || 0;

          // Se potência não estiver na coluna, extrair do JSON (inversores e M-160)
          if (potencia === 0 && leitura.dados) {
            try {
              const dados = leitura.dados as any;
              // Formato inversores: power.active_total (em W, converter para kW)
              if (dados?.power?.active_total) {
                potencia = Number(dados.power.active_total) / 1000;
              }
              // ✅ Formato M-160 NOVO (flat): Pt na raiz (em W, converter para kW)
              else if (dados?.Pt !== undefined) {
                potencia = Number(dados.Pt) / 1000;
              }
              // ✅ Formato M-160 LEGADO (nested): Dados.Pa/Pb/Pc (em W, converter para kW)
              else if (dados?.Dados) {
                const Pa = Number(dados.Dados.Pa) || 0;
                const Pb = Number(dados.Dados.Pb) || 0;
                const Pc = Number(dados.Dados.Pc) || 0;
                potencia = (Pa + Pb + Pc) / 1000;
              }
            } catch (e) {
              // Ignorar erro de parsing
            }
          }

          // 🛑 Frame com overflow UINT do Modbus (mesmo detector da ingestao):
          // potencia absurda (>= 1 GW) inflava o card de usinas. Nao soma o glitch
          // (status segue normal pelo timestamp abaixo). Cobre o historico ja
          // gravado antes do fix de ingestao.
          if (detectarOverflowUint(leitura.dados as any).glitch || ehPotenciaGlitch(potencia)) {
            this.logger.warn(
              `🛑 [GLITCH UINT] ignorado no /coa: ${unidade.nome} @ ` +
              `${new Date(leitura.timestamp_dados).toISOString()} (potencia=${potencia} kW)`,
            );
            potencia = 0;
          }

          potenciaTotal += potencia;

          // Frescor por equipamento (uma linha = último dado de um equipamento).
          reportingIds.add(String(leitura.equipamento_id).trim());
          const tempoDesdeUltimaLeitura = Date.now() - new Date(leitura.timestamp_dados).getTime();
          if (tempoDesdeUltimaLeitura < 30 * 60 * 1000) { // fresco (<30 min)
            freshCount++;
            if (!ultimaLeitura || leitura.timestamp_dados > ultimaLeitura) {
              ultimaLeitura = leitura.timestamp_dados;
            }
            if (leitura.qualidade === 'SUSPEITO') suspeito = true;
          } else {
            // presente mas velho → equipamento parou de reportar (off)
            offlineNomes.push(leitura.equipamento_nome || 'Equipamento');
          }

          // Extrair fator de potência do JSON se disponível
          try {
            const dados = leitura.dados as any;
            if (dados?.Dados?.fp) {
              fatorPotencia = Number(dados.Dados.fp);
            }
          } catch (e) {
            // Ignorar erro de parsing
          }

          // Classificar geração vs consumo baseado no tipo do equipamento
          // Reconhecer inversores por múltiplos critérios:
          // 1. tipo_equipamento contém 'INVERSOR'
          // 2. Presença de dados de inversor no JSON (power.active_total, energy.daily_yield)
          const tipoEquip = (leitura.tipo_equipamento || '').toUpperCase();
          const isInversor = tipoEquip.includes('INVERSOR') ||
                            (leitura.dados?.power?.active_total !== undefined &&
                             leitura.dados?.energy?.daily_yield !== undefined);

          if (isInversor) {
            geracaoPlanta += potencia;
            totalGeracao += potencia;
            // Contar gerador apenas uma vez por equipamento
            if (!equipamentosContados.has(leitura.equipamento_id)) {
              totalGeradores++;
              equipamentosContados.add(leitura.equipamento_id);
            }
          } else {
            consumoPlanta += potencia;
            totalConsumo += potencia;
            // Contar carga apenas uma vez por equipamento
            if (!equipamentosContados.has(leitura.equipamento_id)) {
              totalCargas++;
              equipamentosContados.add(leitura.equipamento_id);
            }
          }
        }

        // Equipamentos esperados (mqtt_habilitado) que NÃO reportaram na última
        // hora = silenciosos (off). Somados aos "velhos" → lista do popup.
        const esperados = expectedPorUnidade.get(unidade.id.trim()) || [];
        for (const eq of esperados) {
          if (!reportingIds.has(eq.id)) offlineNomes.push(eq.nome || 'Equipamento');
        }
        const offlineUnicos = Array.from(new Set(offlineNomes));

        // Status pior-caso: verde só quando NADA está off.
        let status: 'ONLINE' | 'OFFLINE' | 'ALERTA';
        if (freshCount === 0) {
          status = 'OFFLINE'; // nada atual → sem info
        } else if (offlineUnicos.length > 0 || suspeito) {
          status = 'ALERTA'; // algum equipamento off/suspeito → não pode ficar verde
        } else {
          status = 'ONLINE';
        }
        if (status === 'ONLINE') {
          unidadesOnline++;
          unidadesAtivasPlanta++;
        }
        if (suspeito) {
          alertas.push({
            id: `${unidade.id}-quality`,
            tipo: 'QUALIDADE_DADOS',
            severidade: 'warning',
            mensagem: `Qualidade dos dados suspeita na unidade ${unidade.nome}`,
            unidadeId: unidade.id,
            unidadeNome: unidade.nome,
            timestamp: new Date(),
          });
        }

        // Buscar custo desta unidade (se calculado)
        const custoUnidade = custosPorUnidade.get(unidade.id);

        unidadesProcessadas.push({
          id: unidade.id,
          nome: unidade.nome,
          tipo: unidade.tipo,
          status,
          trip: tripUnidades.has(unidade.id.trim()),
          nuvem: status === 'OFFLINE' && cloudRecentUnidades.has(unidade.id.trim()),
          equipamentosOffline: offlineUnicos.length > 0 ? offlineUnicos : undefined,
          ultimaLeitura,
          coordenadas: unidade.latitude && unidade.longitude ? {
            latitude: Number(unidade.latitude),
            longitude: Number(unidade.longitude),
          } : undefined,
          cidade: unidade.cidade || undefined,
          estado: unidade.estado || undefined,
          potenciaInstalada: Number(unidade.potencia) || 0, // ✅ Potência instalada em kW
          metricas: {
            potenciaAtual: Math.round(potenciaTotal * 100) / 100,
            energiaHoje: Math.round(energiaTotal * 100) / 100,
            fatorPotencia: Math.round(fatorPotencia * 100) / 100,
            custoEnergiaHoje: custoUnidade !== undefined ? Math.round(custoUnidade * 100) / 100 : undefined,
          },
        });

        // Verificar alertas de fator de potência (usar módulo para aceitar valores negativos)
        if (fatorPotencia !== 0 && Math.abs(fatorPotencia) < 0.92) {
          alertas.push({
            id: `${unidade.id}-fp`,
            tipo: 'FATOR_POTENCIA_BAIXO',
            severidade: 'info',
            mensagem: `Fator de potência baixo: ${fatorPotencia.toFixed(2)}`,
            unidadeId: unidade.id,
            unidadeNome: unidade.nome,
            timestamp: new Date(),
          });
        }
      }

      plantasProcessadas.push({
        id: planta.id,
        nome: planta.nome,
        cliente: planta.proprietario.nome,
        unidades: unidadesProcessadas,
        totais: {
          geracao: Math.round(geracaoPlanta * 100) / 100,
          consumo: Math.round(consumoPlanta * 100) / 100,
          unidadesAtivas: unidadesAtivasPlanta,
        },
      });
    }

    // 6. Calcular custo total agregado
    const custoTotalHoje = Array.from(custosPorUnidade.values()).reduce((sum, custo) => sum + custo, 0);

    // 7. Montar resposta final
    return {
      timestamp: new Date(),
      resumoGeral: {
        totalGeracao: Math.round(totalGeracao * 100) / 100,
        totalConsumo: Math.round(totalConsumo * 100) / 100,
        balancoRede: Math.round((totalConsumo - totalGeracao) * 100) / 100,
        totalUnidades,
        unidadesOnline,
        alertasAtivos: alertas.length,
        totalGeradores,
        totalCargas,
        custoTotalHoje: custosPorUnidade.size > 0 ? Math.round(custoTotalHoje * 100) / 100 : undefined,
      },
      plantas: plantasProcessadas,
      alertas: alertas.slice(0, 10), // Limitar a 10 alertas mais recentes
    };
  }

  /**
   * Limpa entradas antigas do cache
   */
  private cleanupCache(): void {
    const now = Date.now();
    const expirationTime = this.CACHE_TTL * 2; // Limpar caches com mais de 60 segundos

    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp > expirationTime) {
        this.cache.delete(key);
        this.logger.debug(`Cache removido: ${key}`);
      }
    }
  }

  /**
   * Força atualização do cache (útil para testes ou refresh manual)
   */
  async refreshCache(clienteId?: string, user?: ScopedUser): Promise<DashboardData> {
    const cacheKey = `dashboard-${user?.id?.trim() || 'anon'}-${clienteId || 'all'}`;
    this.cache.delete(cacheKey);
    return this.getDashboardData(clienteId, user);
  }
}