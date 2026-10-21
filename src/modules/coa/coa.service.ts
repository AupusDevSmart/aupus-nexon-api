import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService, PermissionScopeService, ScopedUser, AcessoOperador } from '@/core';
import { Prisma } from '@/core';
import { CalculoCustosService } from '../equipamentos-dados/services/calculo-custos.service';
import { detectarOverflowUint, ehPotenciaGlitch, CAP_POTENCIA_GLITCH_KW } from '../../shared/util/inverter-overflow';
import { CATEGORIA_SINAL_PAIRS } from '../../shared/util/categoria-fluxo.backend';
import { condicaoStatus } from '../logs-mqtt/logs-mqtt-filtros';
import { DiaFonteCalc, FonteGeracaoService } from '../geracao-analise/fonte-geracao.service';

/** Energia de ontem por unidade + parcela dos inversores (cache de 10 min). */
interface EnergiaOntem {
  valores: Map<string, number>;
  parcela: Map<string, ParcelaInversores>;
}

/** Parcela dos inversores na energia do dia de uma unidade (para trocar pela fonte escolhida). */
interface ParcelaInversores {
  /** kWh dos inversores já somado na energia (com perdas). */
  kwh: number;
  /** Fator de perdas da config de demanda (1 = sem perdas). */
  fator: number;
  /** Config de demanda inclui inversor; null = legado (somar tudo): decide a lista de inversores. */
  temInv: boolean | null;
}

export interface DashboardData {
  timestamp: Date;
  resumoGeral: {
    totalGeracao: number;
    totalConsumo: number;
    balancoRede: number;
    totalUnidades: number;
    unidadesOnline: number;
    unidadesMonitoradas?: number; // ONLINE + monitoradas pela nuvem (card "Instalações Monitoradas")
    alertasAtivos: number;
    totalGeradores: number;
    totalCargas: number;
    custoTotalHoje?: number; // ✅ NOVO: Custo total agregado do dia
    cargaTotal?: number;     // Carga real = Geração + líquido dos PMs (3 situações do A966/medidor)
    totalReativo?: number;   // Σ Q (kVAr) dos Power Meters
    totalAparente?: number;  // S_T = √(P_T² + Q_T²) dos Power Meters
    totalNaoComissionados?: number; // pontos monitorados ainda sem comissionamento (gate suave)
    alarmesLogsAtivos?: number; // [apps v2] alarmes de logs_mqtt ativos (sem reconhecer/resolver, não silenciados)
    alarmesDesde?: string | null; // [apps v2] ISO do alarme ativo mais antigo
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
  tonViva?: boolean; // TON dá sinal de vida no broker (liveness). OFFLINE+tonViva = device/Modbus (âmbar), não internet (cinza)
  fonteDados?: 'ton' | 'nuvem'; // origem de potência/energia (nuvem = fallback: sem TON ao vivo, dado do portal do provedor)
  fonteGeracao?: 'ton' | 'nuvem' | 'manual' | null; // NEXON-37: fonte da geração de hoje (FonteGeracaoService)
  fontesDivergem?: boolean; // NEXON-37: TON e nuvem divergem hoje (> 5%, usando TON)
  nuvemAtualizadoEm?: string | null; // horário local (SP) do snapshot de nuvem usado no fallback
  naoComissionados?: string[]; // pontos monitorados desta unidade ainda sem comissionamento (dado não validado)
  equipamentosOffline?: string[]; // nomes de equipamentos sem comunicação (pior-caso do status)
  ultimaLeitura: Date | null;
  coordenadas?: {
    latitude: number;
    longitude: number;
  };
  cidade?: string;
  estado?: string;
  potenciaInstalada: number; // ✅ NOVO: Potência instalada/cadastrada da unidade (kW)
  equipamentosScs?: number; // [apps v2] equipamentos no arqIoT (componente do diagrama IoT ou ponto com vínculo)
  metricas: {
    potenciaAtual: number;
    energiaHoje: number;
    energiaOntem?: number; // [apps v2] D-1 (BRT), mesmo método do energiaHoje
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
    private readonly fontes: FonteGeracaoService,
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
  private async calcularCustosAgregados(unidades: any[], acesso: AcessoOperador | null = null): Promise<Map<string, number>> {
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
                // Operador: R$ só de medidor com "Ver valores em R$" (seção 6.4).
                ...(acesso && { id: { in: [...acesso.verRs] } }),
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

    // Operador (PER-21e/23/24): só instalações com equipamento liberado e, nelas,
    // só os liberados entram em leituras, energia, status, alarmes e totais.
    const acesso = await this.scopeService.acessoPorEquipamento(user);
    const eqScope = acesso ? [...acesso.equipamentos] : null;
    const eqLiberado = (id: unknown) => !acesso || acesso.equipamentos.has(String(id ?? '').trim());
    // Geração de nuvem é da usina inteira, não de um equipamento: operador só com "Ver geração".
    const nuvemLiberada = (uid: string) => !acesso || acesso.verGeracao.has(uid);

    // 2. Buscar unidades com suas plantas
    const unidades = await this.prisma.unidades.findMany({
      where: {
        deleted_at: null,
        planta_id: {
          in: plantas.map(p => p.id),
        },
        ...(acesso && { id: { in: [...acesso.unidades] } }),
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
          where: { deleted_at: null, ...(eqScope && { id: { in: eqScope } }) },
          select: {
            id: true,
            nome: true,
          },
        },
      },
    });
    // Planta sem nenhuma instalação visível some para o operador.
    if (acesso) {
      const comUnidade = new Set(unidades.map((u) => u.planta_id));
      plantas.splice(0, plantas.length, ...plantas.filter((p) => comUnidade.has(p.id)));
    }

    // 2.5. Calcular custos de energia para unidades do tipo "Carga" com M160 ativo
    this.logger.log('[COA] Calculando custos de energia...');
    const unidadesCargas = unidades.filter(u => u.tipo === 'Carga');
    const custosPorUnidade = await this.calcularCustosAgregados(unidadesCargas, acesso);

    // 3. Buscar últimas leituras de todos os equipamentos (query otimizada)
    const horaAtras = new Date(Date.now() - 60 * 60 * 1000); // 1 hora atrás

    const ultimasLeiturasTodas = await this.prisma.$queryRaw<any[]>`
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
    const ultimasLeituras = ultimasLeiturasTodas.filter((l) => eqLiberado(l.equipamento_id));

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

    const parcelaHoje = new Map<string, ParcelaInversores>();
    const energiaDiaPorUnidade = await this.energiaPorUnidade(unidadeIds, dataInicioBRT, dataFimBRT, null, catSinalValues, eqScope, parcelaHoje);

    // [apps v2] Energia de ONTEM (D-1 BRT) pelo MESMO método — "12% acima de ontem"
    // no Início. Cache de 10 min por conjunto de unidades (dado de ontem é estável).
    const dataOntemBRT = new Date(dataInicioBRT.getTime() - 24 * 60 * 60 * 1000);
    const { valores: energiaOntemPorUnidade, parcela: parcelaOntem } = await this.energiaOntemCacheada(unidadeIds, hojeSP, async () => {
      const parcela = new Map<string, ParcelaInversores>();
      const valores = await this.energiaPorUnidade(unidadeIds, dataOntemBRT, dataInicioBRT, dataOntemBRT, catSinalValues, eqScope, parcela);
      return { valores, parcela };
    }, eqScope);

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
    let totalReativo = 0;   // Σ Q (kVAr) dos PMs — card de Reativo
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
      const tripRows = await this.prisma.$queryRaw<Array<{ unidade_id: string; equipamento_id: string }>>`
        SELECT DISTINCT TRIM(e.unidade_id) AS unidade_id, TRIM(e.id) AS equipamento_id
        FROM logs_mqtt l
        JOIN equipamentos e ON TRIM(e.id) = TRIM(l.equipamento_id)
        WHERE l.dados_snapshot->>'kind' = 'trip'
          AND l.reconhecido_em IS NULL
          AND e.deleted_at IS NULL
      `;
      for (const r of tripRows) if (r?.unidade_id && eqLiberado(r.equipamento_id)) tripUnidades.add(String(r.unidade_id).trim());
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
            WHERE ed.equipamento_id = e.id
              AND ed.timestamp_dados > now() - interval '7 days'
          )
      `;
      for (const r of eqRows) {
        const uid = String(r.unidade_id || '').trim();
        if (!uid || !eqLiberado(r.id)) continue;
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
      for (const r of cloudRows) if (r?.unidade_id && nuvemLiberada(String(r.unidade_id).trim())) cloudRecentUnidades.add(String(r.unidade_id).trim());
    } catch (e) {
      this.logger.warn(`[COA] consulta de nuvem recente falhou: ${e instanceof Error ? e.message : e}`);
    }

    // FALLBACK DE NUVEM (Fase 2 do fallback horário): snapshot de HOJE por unidade.
    //   energia  = kwh_acumulado do último snapshot do dia (acumulado diário do provedor);
    //   potência = kwh_hora do último snapshot (kWh em 1h ≈ média em kW naquela hora).
    // A MADRUGADA (00h–05h) é IGNORADA: até o provedor virar o dia a nuvem ainda devolve
    // o total de ONTEM (visto até 05h em algumas plantas) — incluí-la inflaria "energia hoje".
    // `hora` é timestamp local de SP (sem fuso) → a idade é calculada no próprio SQL.
    // Geração que veio da NUVEM entra em "Potência de Geração", mas NÃO em "Potência de
    // Carga": sem medidor, a carga da unidade é desconhecida (não é igual à geração).
    let totalGeracaoNuvem = 0;
    let unidadesMonitoradasNuvem = 0;
    const nuvemHojePorUnidade = new Map<string, { energiaKwh: number; potenciaKw: number; horaLocal: string; idadeMin: number }>();
    try {
      const nRows = await this.prisma.$queryRaw<Array<{
        unidade_id: string; kwh_acumulado: number | null; kwh_hora: number | null; hora_local: string; idade_min: number;
      }>>`
        SELECT DISTINCT ON (TRIM(unidade_id))
               TRIM(unidade_id) AS unidade_id,
               kwh_acumulado::float8 AS kwh_acumulado,
               kwh_hora::float8 AS kwh_hora,
               to_char(hora, 'YYYY-MM-DD"T"HH24:MI:SS') AS hora_local,
               (EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'America/Sao_Paulo') - hora)) / 60)::float8 AS idade_min
        FROM geracao_horaria_plantas
        WHERE hora::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date
          AND EXTRACT(HOUR FROM hora) > 5
        ORDER BY TRIM(unidade_id), hora DESC
      `;
      for (const r of nRows) {
        if (!r?.unidade_id || !nuvemLiberada(String(r.unidade_id).trim())) continue;
        nuvemHojePorUnidade.set(String(r.unidade_id).trim(), {
          energiaKwh: Number(r.kwh_acumulado) || 0,
          potenciaKw: Number(r.kwh_hora) || 0,
          horaLocal: r.hora_local,
          idadeMin: Number(r.idade_min) || 0,
        });
      }
    } catch (e) {
      this.logger.warn(`[COA] consulta de nuvem horária (fallback) falhou: ${e instanceof Error ? e.message : e}`);
    }

    // Unidades cuja TON DÁ SINAL DE VIDA no broker (last_seen fresco em
    // iot_dispositivos_online), mesmo sem dado de equipamento chegando. Distingue
    // "device/Modbus com problema" (TON viva → âmbar) de "sem sinal" (internet/energia
    // → cinza). Match por prefixo: equipamento.topico_mqtt começa com a base da TON.
    // `starts_with` (não LIKE) porque os tópicos contêm '_'. Janela 15 min (a TON
    // carimba last_seen a cada telemetria — ver MqttService.touchLiveness).
    const tonVivaUnidades = new Set<string>();
    try {
      const vivaRows = await this.prisma.$queryRaw<Array<{ unidade_id: string; equipamento_id: string }>>`
        SELECT DISTINCT TRIM(e.unidade_id) AS unidade_id, TRIM(e.id) AS equipamento_id
        FROM equipamentos e
        JOIN iot_dispositivos_online d
          ON (TRIM(e.topico_mqtt) = TRIM(d.topico_mqtt)
              OR starts_with(TRIM(e.topico_mqtt), TRIM(d.topico_mqtt) || '/'))
        WHERE e.deleted_at IS NULL AND e.unidade_id IS NOT NULL
          -- viva = online=true (touchLiveness liga em telemetria VIVA; LWT desliga)
          -- E last_seen fresco. online=true sozinho fica preso; last_seen sozinho pega
          -- o carimbo do LWT (que grava now() com online=false). Os dois juntos = confiável.
          AND d.online = true
          AND d.last_seen > now() - interval '15 minutes'
      `;
      for (const r of vivaRows) if (r?.unidade_id && eqLiberado(r.equipamento_id)) tonVivaUnidades.add(String(r.unidade_id).trim());
    } catch (e) {
      this.logger.warn(`[COA] consulta de TON viva (liveness) falhou: ${e instanceof Error ? e.message : e}`);
    }

    // Pontos COMISSIONADOS (aceite registrado) — para sinalizar no COA quais equipamentos
    // ainda NÃO passaram por comissionamento (dado não validado na instalação). Gate SUAVE:
    // só sinaliza (não esconde do COA). Ver docs/IOT-NEXON-CONFIABILIDADE.md §3.2.
    const comissionadosIds = new Set<string>();
    try {
      const cRows = await this.prisma.$queryRaw<Array<{ equipamento_id: string }>>`
        SELECT TRIM(equipamento_id) AS equipamento_id FROM iot_comissionamento
        WHERE status IN ('comissionado', 'comissionado_com_ressalva')
      `;
      for (const r of cRows) if (r?.equipamento_id) comissionadosIds.add(String(r.equipamento_id).trim());
    } catch (e) {
      this.logger.warn(`[COA] consulta de comissionamento falhou: ${e instanceof Error ? e.message : e}`);
    }
    let totalNaoComissionados = 0;

    // [apps v2] Alarmes ativos da trilha, equipamentos do arqIoT e nuvem de ontem.
    const ontemSP = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(dataOntemBRT.getTime() + 12 * 60 * 60 * 1000);
    // NEXON-37: fonte da geração (TON × nuvem × manual) de ontem e hoje, um lote por dashboard.
    // Só onde a geração da usina é visível (operador com "Ver geração").
    const comFonte = unidadeIds.filter(nuvemLiberada);
    const [alarmesAtivos, scsPorUnidade, nuvemOntem, fontes, inversoresFonte] = await Promise.all([
      this.alarmesLogsAtivos(unidadeIds, eqScope),
      this.equipamentosScsPorUnidade(unidadeIds, eqScope),
      this.nuvemOntemPorUnidade(comFonte, ontemSP),
      this.fontes.porDias(comFonte, ontemSP, hojeSP, agora).catch((e) => {
        this.logger.warn(`[COA] fonte da geração falhou (energia pelo método antigo): ${e instanceof Error ? e.message : e}`);
        return new Map<string, Map<string, DiaFonteCalc>>();
      }),
      this.fontes.inversoresPorUnidade(comFonte).catch(() => new Map<string, string[]>()),
    ]);
    // Geração do dia pela fonte escolhida: tira a parcela dos inversores já somada e põe o kWh
    // escolhido (com as mesmas perdas). Consumo e o resto da energia seguem iguais.
    const energiaComFonte = (
      uid: string, base: number, parcela: ParcelaInversores | undefined, esc: DiaFonteCalc | undefined,
      semTelemetria: boolean, fallback: number,
    ): number => {
      if (esc?.kwh != null) {
        const comInv = parcela?.temInv ?? (inversoresFonte.get(uid)?.length ?? 0) > 0;
        if (comInv) return base - (parcela?.kwh ?? 0) + esc.kwh * (parcela?.fator ?? 1);
        if (semTelemetria) return esc.kwh;
      }
      return semTelemetria ? fallback : base;
    };

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

          // A966 (gateway SSU): a potência do card é o LÍQUIDO do medidor de entrada,
          // importação − exportação (import +), derivado na ingestão em P_direto/P_rev
          // (phf/phr). Sobrepõe o potencia_ativa_kw (que é geração líquida, sinal oposto).
          const _a966 = leitura.dados as any;
          const ehGatewayA966 = !!(_a966 && (_a966.P_direto !== undefined || _a966.P_rev !== undefined || _a966.phf !== undefined));
          if (ehGatewayA966) {
            potencia = (Number(_a966.P_direto) || 0) - (Number(_a966.P_rev) || 0);
          }

          // Se potência não estiver na coluna, extrair do JSON (inversores e M-160)
          if (!ehGatewayA966 && potencia === 0 && leitura.dados) {
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

          // Reativo (Q, kVAr) — só dos Power Meters (não inversores). M160 flat: Qt
          // (var→kVAr); inversor: power.reactive_total; M160 legado: Qa/Qb/Qc.
          let reativo = 0;
          try {
            const dr = leitura.dados as any;
            if (dr?.Q_liquido !== undefined) reativo = Number(dr.Q_liquido);   // A966 (já em kVAr)
            else if (dr?.Qt !== undefined) reativo = Number(dr.Qt) / 1000;
            else if (dr?.power?.reactive_total !== undefined) reativo = Number(dr.power.reactive_total) / 1000;
            else if (dr?.Dados) { const Qa = Number(dr.Dados.Qa) || 0, Qb = Number(dr.Dados.Qb) || 0, Qc = Number(dr.Dados.Qc) || 0; reativo = (Qa + Qb + Qc) / 1000; }
          } catch (e) { /* ignore */ }

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
            } else if (dados?.FP_calc !== undefined) {
              fatorPotencia = Number(dados.FP_calc);   // A966: FP derivado (|P|/√(P²+Q²))
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
            totalReativo += reativo;
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

        // Pontos esperados (mqtt_habilitado + reportando) que ainda NÃO foram comissionados.
        const naoComissionadosNomes = esperados
          .filter((eq) => !comissionadosIds.has(eq.id))
          .map((eq) => eq.nome || 'Equipamento');
        const naoComissionadosUnicos = Array.from(new Set(naoComissionadosNomes));
        totalNaoComissionados += naoComissionadosUnicos.length;

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

        // FALLBACK DE NUVEM: nenhuma telemetria ao vivo (freshCount = 0), mas a nuvem do
        // provedor fotografou a geração de hoje. Mostra o dado da nuvem em vez de zero:
        // potência = média da última hora (estimada), energia = acumulado do dia.
        let fonteDados: 'ton' | 'nuvem' = 'ton';
        let nuvemAtualizadoEm: string | null = null;
        let potenciaNuvem = 0;
        let energiaNuvem = 0;
        const nuvemHoje = nuvemHojePorUnidade.get(unidade.id.trim());
        if (freshCount === 0 && nuvemHoje) {
          fonteDados = 'nuvem';
          nuvemAtualizadoEm = nuvemHoje.horaLocal;
          energiaNuvem = nuvemHoje.energiaKwh;
          // Snapshot com mais de 2h = coleta parada: não finge potência atual.
          potenciaNuvem = nuvemHoje.idadeMin <= 120 ? nuvemHoje.potenciaKw : 0;
          geracaoPlanta += potenciaNuvem;
          totalGeracao += potenciaNuvem;
          totalGeracaoNuvem += potenciaNuvem;
        }
        // Monitorada pela nuvem (hoje ou nos últimos 2 dias): conta como instalação
        // monitorada no card do COA mesmo sem telemetria ao vivo — de dia e à noite.
        if (status !== 'ONLINE' && (fonteDados === 'nuvem' || cloudRecentUnidades.has(unidade.id.trim()))) {
          unidadesMonitoradasNuvem++;
        }

        // Buscar custo desta unidade (se calculado)
        const custoUnidade = custosPorUnidade.get(unidade.id);
        const uidT = unidade.id.trim();
        const escHoje = fontes.get(uidT)?.get(hojeSP);
        const escOntem = fontes.get(uidT)?.get(ontemSP);

        unidadesProcessadas.push({
          id: unidade.id,
          nome: unidade.nome,
          tipo: unidade.tipo,
          status,
          trip: tripUnidades.has(unidade.id.trim()),
          nuvem: status === 'OFFLINE' && (cloudRecentUnidades.has(unidade.id.trim()) || fonteDados === 'nuvem'),
          fonteDados,
          nuvemAtualizadoEm,
          // TON viva no broker: dado fresco chegando OU liveness fresco (birth/telemetria
          // recente). Usado pelo COA p/ pintar OFFLINE+tonViva de âmbar (device/Modbus,
          // não internet) em vez de cinza. Ver docs/IOT-NEXON-CONFIABILIDADE.md.
          tonViva: freshCount > 0 || tonVivaUnidades.has(unidade.id.trim()),
          // Pontos monitorados desta unidade ainda sem comissionamento (dado não validado).
          // Comissionamento e lista de quem caiu são comunicação: operador não recebe (PER-22).
          naoComissionados: !acesso && naoComissionadosUnicos.length > 0 ? naoComissionadosUnicos : undefined,
          equipamentosOffline: !acesso && offlineUnicos.length > 0 ? offlineUnicos : undefined,
          ultimaLeitura,
          coordenadas: unidade.latitude && unidade.longitude ? {
            latitude: Number(unidade.latitude),
            longitude: Number(unidade.longitude),
          } : undefined,
          cidade: unidade.cidade || undefined,
          estado: unidade.estado || undefined,
          potenciaInstalada: Number(unidade.potencia) || 0, // ✅ Potência instalada em kW
          ...(scsPorUnidade ? { equipamentosScs: scsPorUnidade.get(unidade.id.trim()) ?? 0 } : {}),
          fonteGeracao: escHoje?.fonte ?? null,
          fontesDivergem: escHoje?.motivo === 'divergem',
          metricas: {
            potenciaAtual: Math.round((fonteDados === 'nuvem' ? potenciaNuvem : potenciaTotal) * 100) / 100,
            // Geração pela fonte escolhida (NEXON-37); sem escolha, o método antigo.
            energiaHoje: Math.round(
              energiaComFonte(uidT, energiaTotal, parcelaHoje.get(uidT), escHoje, fonteDados === 'nuvem', energiaNuvem) * 100,
            ) / 100,
            // D-1: telemetria pelo mesmo método; unidade que hoje vem da nuvem (ou
            // sem telemetria ontem) usa o fechamento diário da nuvem.
            energiaOntem:
              Math.round(
                energiaComFonte(
                  uidT, energiaOntemPorUnidade.get(uidT) ?? 0, parcelaOntem.get(uidT), escOntem,
                  fonteDados === 'nuvem' || !energiaOntemPorUnidade.has(uidT),
                  nuvemOntem.get(uidT) ?? energiaOntemPorUnidade.get(uidT) ?? 0,
                ) * 100,
              ) / 100,
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
        unidadesMonitoradas: unidadesOnline + unidadesMonitoradasNuvem, // ONLINE + monitoradas pela nuvem
        alertasAtivos: alertas.length,
        totalGeradores,
        totalCargas,
        custoTotalHoje: custosPorUnidade.size > 0 ? Math.round(custoTotalHoje * 100) / 100 : undefined,
        // Carga real (3 situações): Geração + líquido dos medidores (import +, export −).
        cargaTotal: Math.round((totalGeracao - totalGeracaoNuvem + totalConsumo) * 100) / 100,
        totalReativo: Math.round(totalReativo * 100) / 100,
        // Aparente total dos PMs: S_T = √(P_T² + Q_T²), P_T = Σ PM ativo, Q_T = Σ PM reativo.
        totalAparente: Math.round(Math.sqrt(totalConsumo * totalConsumo + totalReativo * totalReativo) * 100) / 100,
        totalNaoComissionados: acesso ? 0 : totalNaoComissionados, // pontos monitorados ainda sem comissionamento (gate suave)
        ...(alarmesAtivos ? { alarmesLogsAtivos: alarmesAtivos.total, alarmesDesde: alarmesAtivos.desde } : {}),
      },
      plantas: plantasProcessadas,
      alertas: alertas.slice(0, 10), // Limitar a 10 alertas mais recentes
    };
  }

  /**
   * Energia por unidade no intervalo [dataInicioBRT, dataFimBRT): config de demanda
   * (sinal por categoria + perdas) e, para as unidades sem config, o fallback
   * legado (somar tudo). `legadoInicio` null = hoje, com o boundary de sempre do
   * legado (CURRENT_DATE); com data = janela fechada [legadoInicio, dataFimBRT) (D-1).
   */
  private async energiaPorUnidade(
    unidadeIds: string[],
    dataInicioBRT: Date,
    dataFimBRT: Date,
    legadoInicio: Date | null,
    catSinalValues: Prisma.Sql,
    eqScope: string[] | null = null,
    parcela?: Map<string, ParcelaInversores>,
  ): Promise<Map<string, number>> {
    // Operador: soma só os equipamentos liberados (PER-24), sem rótulo do recorte.
    const soLiberados = eqScope ? Prisma.sql`AND trim(e.id) = ANY(${eqScope}::text[])` : Prisma.empty;
    const janelaLegado = legadoInicio
      ? Prisma.sql`ed.timestamp_dados >= ${legadoInicio} AND ed.timestamp_dados < ${dataFimBRT}`
      : Prisma.sql`ed.timestamp_dados >= CURRENT_DATE::timestamp`;
    if (unidadeIds.length === 0) return new Map();
    const energiaConfigDia = await this.prisma.$queryRaw<any[]>(Prisma.sql`
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
        SELECT s.unidade_id, e.id AS equipamento_id, cs.sinal, s.aplicar_perdas, s.fator_perdas,
               -- inversor = mesma detecção da análise de geração (NEXON-37: parcela trocada pela fonte)
               (COALESCE(e.tipo_equipamento, '') NOT ILIKE 'TON%'
                AND CONCAT_WS(' ', te.codigo, te.nome, e.tipo_equipamento, e.topico_mqtt, ce.nome) ~* 'INVERSOR') AS inversor
        FROM sel s
        JOIN equipamentos e ON trim(e.id) = s.equipamento_id AND e.deleted_at IS NULL ${soLiberados}
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
             ) AS energia_dia_kwh,
             SUM(CASE WHEN d.inversor AND d.sinal = 1 THEN
               COALESCE(ed.energia_total, 0)
               * CASE WHEN d.aplicar_perdas AND d.fator_perdas > 0 THEN 1 - d.fator_perdas / 100.0 ELSE 1 END
             END)::float8 AS inv_kwh,
             BOOL_OR(d.inversor AND d.sinal = 1) AS tem_inv,
             MAX(CASE WHEN d.aplicar_perdas AND d.fator_perdas > 0 THEN 1 - d.fator_perdas / 100.0 ELSE 1 END)::float8 AS fator
      FROM dev d
      LEFT JOIN energia_device ed ON ed.equipamento_id = d.equipamento_id
      GROUP BY d.unidade_id
    `);

    // Mapa de energia diaria por unidade (config-driven)
    const energiaDiaPorUnidade = new Map<string, number>();
    for (const row of energiaConfigDia) {
      const uid = String(row.unidade_id).trim();
      energiaDiaPorUnidade.set(uid, Number(row.energia_dia_kwh) || 0);
      parcela?.set(uid, { kwh: Number(row.inv_kwh) || 0, fator: Number(row.fator) || 1, temInv: row.tem_inv === true });
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
          WHERE ${janelaLegado}
            AND e.deleted_at IS NULL
            AND e.unidade_id = ANY(${faltantes}::text[])
            ${soLiberados}
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
          SELECT unidade_id, energia_dia_kwh, false AS inv FROM EnergiaM160
          UNION ALL SELECT unidade_id, energia_dia_kwh, true FROM EnergiaInversores
          UNION ALL SELECT unidade_id, energia_dia_kwh, false FROM EnergiaOutros
        )
        SELECT unidade_id, SUM(energia_dia_kwh) as energia_dia_kwh,
               SUM(CASE WHEN inv THEN energia_dia_kwh END)::float8 AS inv_kwh
        FROM EnergiaUnificada
        GROUP BY unidade_id
      `;
      for (const row of energiaLegado) {
        const uid = String(row.unidade_id).trim();
        energiaDiaPorUnidade.set(uid, Number(row.energia_dia_kwh) || 0);
        parcela?.set(uid, { kwh: Number(row.inv_kwh) || 0, fator: 1, temInv: null });
      }
    }
    this.logger.log(`[COA] Energia ${legadoInicio ? 'ontem' : 'hoje'}: ${energiaConfigDia.length} unidade(s) via config de demanda, ${faltantes.length} via fallback legado (somar tudo)`);

    // DEBUG: Mostrar resultado bruto da query config-driven
    this.logger.debug(`[COA DEBUG] energiaConfigDia raw:`, JSON.stringify(energiaConfigDia, null, 2));
    return energiaDiaPorUnidade;
  }

  private energiaOntemCache = new Map<string, { dia: string; ts: number; valores: EnergiaOntem }>();

  private async energiaOntemCacheada(
    unidadeIds: string[],
    hojeSP: string,
    calcular: () => Promise<EnergiaOntem>,
    eqScope: string[] | null = null,
  ): Promise<EnergiaOntem> {
    // Recorte do operador entra na chave: mesma instalação, outros equipamentos.
    const chave = [...unidadeIds].sort().join(',') + (eqScope ? `|eq:${[...eqScope].sort().join(',')}` : '');
    const c = this.energiaOntemCache.get(chave);
    if (c && c.dia === hojeSP && Date.now() - c.ts < 10 * 60 * 1000) return c.valores;
    try {
      const valores = await calcular();
      if (this.energiaOntemCache.size > 200) this.energiaOntemCache.clear();
      this.energiaOntemCache.set(chave, { dia: hojeSP, ts: Date.now(), valores });
      return valores;
    } catch (e) {
      this.logger.warn(`[COA] energia de ontem falhou (campo omitido): ${e instanceof Error ? e.message : e}`);
      return { valores: new Map(), parcela: new Map() };
    }
  }

  /** Geração diária de NUVEM de ontem (geracao_diaria_plantas) — fallback do energiaOntem. */
  private async nuvemOntemPorUnidade(unidadeIds: string[], ontemSP: string): Promise<Map<string, number>> {
    const m = new Map<string, number>();
    if (unidadeIds.length === 0) return m;
    try {
      const rows = await this.prisma.$queryRaw<Array<{ unidade_id: string; kwh: number | null }>>`
        SELECT TRIM(unidade_id) AS unidade_id, SUM(COALESCE(kwh_realizado, 0))::float8 AS kwh
        FROM geracao_diaria_plantas
        WHERE data = ${ontemSP}::date AND TRIM(unidade_id) = ANY(${unidadeIds}::text[])
        GROUP BY TRIM(unidade_id)`;
      for (const r of rows) m.set(String(r.unidade_id).trim(), Number(r.kwh) || 0);
    } catch (e) {
      this.logger.warn(`[COA] nuvem de ontem falhou: ${e instanceof Error ? e.message : e}`);
    }
    return m;
  }

  /** Alarmes ativos (logs_mqtt) das unidades do dashboard: total + o mais antigo. */
  private async alarmesLogsAtivos(unidadeIds: string[], eqScope: string[] | null = null): Promise<{ total: number; desde: string | null } | null> {
    if (unidadeIds.length === 0) return { total: 0, desde: null };
    try {
      const rows = await this.prisma.$queryRaw<Array<{ total: number; desde: Date | null }>>`
        SELECT COUNT(*)::int AS total, MIN(l.created_at) AS desde
        FROM logs_mqtt l
        JOIN equipamentos e ON e.id = l.equipamento_id
        WHERE ${condicaoStatus('ativo', new Date())}
          AND TRIM(e.unidade_id) = ANY(${unidadeIds}::text[])
          ${eqScope ? Prisma.sql`AND TRIM(e.id) = ANY(${eqScope}::text[])` : Prisma.empty}`;
      const r = rows[0];
      return { total: Number(r?.total ?? 0), desde: r?.desde ? new Date(r.desde).toISOString() : null };
    } catch (e) {
      this.logger.warn(`[COA] alarmes ativos (SQL da trilha aplicado?): ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /**
   * Equipamentos instrumentados por unidade: componente do diagrama IoT (menos a própria
   * TON), ponto com vínculo ativo, SCS declarado ou MQTT habilitado. 0 = "Sem instrumentação".
   * Erro → null (omite).
   */
  private async equipamentosScsPorUnidade(unidadeIds: string[], eqScope: string[] | null = null): Promise<Map<string, number> | null> {
    const m = new Map<string, number>();
    if (unidadeIds.length === 0) return m;
    try {
      const rows = await this.prisma.$queryRaw<Array<{ unidade_id: string; n: number }>>`
        SELECT unidade_id, COUNT(DISTINCT eq_id)::int AS n FROM (
          SELECT TRIM(e.unidade_id) AS unidade_id, TRIM(e.id) AS eq_id
          FROM iot_componentes c
          JOIN equipamentos e ON TRIM(e.id) = COALESCE(NULLIF(TRIM(c.equipamento_id), ''), c.props->>'equipamento_id')
          WHERE COALESCE(c.tipo, '') NOT LIKE 'ton%' AND e.deleted_at IS NULL
          UNION
          SELECT TRIM(e.unidade_id), TRIM(e.id)
          FROM iot_vinculos v
          JOIN equipamento_pontos ep ON ep.id = v.equipamento_ponto_id AND ep.deleted_at IS NULL
          JOIN equipamentos e ON e.id = ep.equipamento_id AND e.deleted_at IS NULL
          WHERE v.ativo = true AND v.deleted_at IS NULL
          UNION
          -- SCS declarado ou telemetria MQTT também é instrumentação (a lista do app une os dois).
          SELECT TRIM(e.unidade_id), TRIM(e.id)
          FROM equipamentos e
          WHERE e.deleted_at IS NULL AND (e.scs = true OR e.mqtt_habilitado = true)
        ) x
        WHERE unidade_id = ANY(${unidadeIds}::text[])
          ${eqScope ? Prisma.sql`AND eq_id = ANY(${eqScope}::text[])` : Prisma.empty}
        GROUP BY unidade_id`;
      for (const r of rows) m.set(String(r.unidade_id).trim(), Number(r.n) || 0);
      return m;
    } catch (e) {
      this.logger.warn(`[COA] equipamentos do arqIoT falhou (campo omitido): ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /**
   * Série histórica de geração de uma unidade — alimenta o gráfico no estilo do
   * portal do provedor (Dia / Mês / Ano / Total). Fontes:
   *   dia   → geracao_horaria_plantas: kWh por hora (madrugada 00h–05h = 0 — até o
   *           provedor virar o dia a nuvem ainda devolve o total de ONTEM);
   *   mês   → geracao_diaria_plantas: kWh por dia (o dia corrente vem do horário,
   *           mais fresco que o fechamento diário das 21h);
   *   ano   → soma mensal do diário;  total → soma anual do diário.
   * Escopado por dono (assertEntityInScope na unidade).
   */
  async historicoGeracao(unidadeId: string, periodo?: string, data?: string, user?: ScopedUser) {
    const uid = (unidadeId ?? '').trim();
    const r2 = (v: number) => Math.round(v * 100) / 100;
    if (!uid) return { periodo: 'dia', referencia: null, total_kwh: 0, pontos: [] as any[] };
    if (user) await this.scopeService.assertEntityInScope('unidade', uid, user);
    // PER-40: operador só com "Ver geração" na instalação; 403 sem dar pista.
    if (user && !(await this.scopeService.podeVerGeracao(uid, user))) {
      throw new ForbiddenException('Recurso fora do escopo do usuario');
    }

    const p = ['dia', 'mes', 'ano', 'total'].includes(String(periodo)) ? String(periodo) : 'dia';
    const hojeRow = await this.prisma.$queryRaw<Array<{ hoje: string }>>`
      SELECT to_char((now() AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS hoje`;
    const hoje = hojeRow[0]?.hoje ?? new Date().toISOString().slice(0, 10);
    const ref = data && /^\d{4}-\d{2}-\d{2}$/.test(data) ? data : hoje;

    // Acumulado de HOJE pelo snapshot horário (último do dia, ignorando a hora 00).
    const acumHoje = async (): Promise<number | null> => {
      const r = await this.prisma.$queryRaw<Array<{ acum: number | null }>>`
        SELECT kwh_acumulado::float8 AS acum FROM geracao_horaria_plantas
        WHERE TRIM(unidade_id) = ${uid} AND hora::date = ${hoje}::date AND EXTRACT(HOUR FROM hora) > 5
        ORDER BY hora DESC LIMIT 1`;
      return r[0]?.acum ?? null;
    };
    // Hoje só entra pelo horário se o diário ainda não fechou o dia (não conta 2x).
    const hojeSeFaltarNoDiario = async (): Promise<number> => {
      const t = await this.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM geracao_diaria_plantas
        WHERE TRIM(unidade_id) = ${uid} AND data = ${hoje}::date`;
      if ((t[0]?.n ?? 0) > 0) return 0;
      return (await acumHoje()) ?? 0;
    };

    if (p === 'dia') {
      const rows = await this.prisma.$queryRaw<Array<{ h: number; kwh: number | null; acum: number | null }>>`
        SELECT EXTRACT(HOUR FROM hora)::int AS h, kwh_hora::float8 AS kwh, kwh_acumulado::float8 AS acum
        FROM geracao_horaria_plantas
        WHERE TRIM(unidade_id) = ${uid} AND hora::date = ${ref}::date AND EXTRACT(HOUR FROM hora) > 0
        ORDER BY hora`;
      const porHora = new Map<number, (typeof rows)[number]>(rows.map((r) => [Number(r.h), r] as [number, (typeof rows)[number]]));
      const pontos = Array.from({ length: 24 }, (_, h) => {
        const r = porHora.get(h);
        return {
          rotulo: `${String(h).padStart(2, '0')}:00`,
          // Madrugada (00h–05h) = 0: sem sol; o que houver ali é resíduo de ontem na nuvem.
          kwh: r ? (h <= 5 ? 0 : r2(Number(r.kwh) || 0)) : null,
          acumulado: r ? (h <= 5 ? 0 : r2(Number(r.acum) || 0)) : null,
        };
      });
      const diurnas = rows.filter((r) => Number(r.h) > 5);
      const total = diurnas.length ? Number(diurnas[diurnas.length - 1].acum) || 0 : 0;
      return { periodo: p, referencia: ref, total_kwh: r2(total), pontos };
    }

    if (p === 'mes') {
      const rows = await this.prisma.$queryRaw<Array<{ d: number; kwh: number | null }>>`
        SELECT EXTRACT(DAY FROM data)::int AS d, kwh_realizado::float8 AS kwh
        FROM geracao_diaria_plantas
        WHERE TRIM(unidade_id) = ${uid} AND date_trunc('month', data) = date_trunc('month', ${ref}::date)
        ORDER BY data`;
      const porDia = new Map<number, number>(rows.map((r) => [Number(r.d), Number(r.kwh) || 0] as [number, number]));
      if (ref.slice(0, 7) === hoje.slice(0, 7)) {
        const a = await acumHoje();
        if (a != null) porDia.set(Number(hoje.slice(8, 10)), a);
      }
      const nDias = new Date(Number(ref.slice(0, 4)), Number(ref.slice(5, 7)), 0).getDate();
      const pontos = Array.from({ length: nDias }, (_, i) => ({
        rotulo: String(i + 1).padStart(2, '0'),
        kwh: porDia.has(i + 1) ? r2(porDia.get(i + 1) as number) : null,
      }));
      const total = Array.from(porDia.values()).reduce((acc, v) => acc + v, 0);
      return { periodo: p, referencia: ref, total_kwh: r2(total), pontos };
    }

    if (p === 'ano') {
      const rows = await this.prisma.$queryRaw<Array<{ m: number; kwh: number | null }>>`
        SELECT EXTRACT(MONTH FROM data)::int AS m, SUM(kwh_realizado)::float8 AS kwh
        FROM geracao_diaria_plantas
        WHERE TRIM(unidade_id) = ${uid} AND EXTRACT(YEAR FROM data) = EXTRACT(YEAR FROM ${ref}::date)
        GROUP BY 1 ORDER BY 1`;
      const porMes = new Map<number, number>(rows.map((r) => [Number(r.m), Number(r.kwh) || 0] as [number, number]));
      if (ref.slice(0, 4) === hoje.slice(0, 4)) {
        const extra = await hojeSeFaltarNoDiario();
        if (extra > 0) { const m = Number(hoje.slice(5, 7)); porMes.set(m, (porMes.get(m) ?? 0) + extra); }
      }
      const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
      const pontos = MESES.map((rot, i) => ({ rotulo: rot, kwh: porMes.has(i + 1) ? r2(porMes.get(i + 1) as number) : null }));
      const total = Array.from(porMes.values()).reduce((acc, v) => acc + v, 0);
      return { periodo: p, referencia: ref, total_kwh: r2(total), pontos };
    }

    // total — soma anual
    const rows = await this.prisma.$queryRaw<Array<{ a: number; kwh: number | null }>>`
      SELECT EXTRACT(YEAR FROM data)::int AS a, SUM(kwh_realizado)::float8 AS kwh
      FROM geracao_diaria_plantas WHERE TRIM(unidade_id) = ${uid}
      GROUP BY 1 ORDER BY 1`;
    const porAno = new Map<number, number>(rows.map((r) => [Number(r.a), Number(r.kwh) || 0] as [number, number]));
    const extra = await hojeSeFaltarNoDiario();
    if (extra > 0) { const a = Number(hoje.slice(0, 4)); porAno.set(a, (porAno.get(a) ?? 0) + extra); }
    const pontos = Array.from(porAno.entries()).sort((x, y) => x[0] - y[0]).map(([a, v]) => ({ rotulo: String(a), kwh: r2(v) }));
    const total = Array.from(porAno.values()).reduce((acc, v) => acc + v, 0);
    return { periodo: p, referencia: ref, total_kwh: r2(total), pontos };
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