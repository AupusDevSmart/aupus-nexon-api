import { Controller, Get, Param, Query, Logger, Post, Put, Body } from '@nestjs/common';
import { EquipamentosDadosService } from './equipamentos-dados.service';
import { CalculoCustosService } from './services/calculo-custos.service';
import { ConfiguracaoCustoService } from './services/configuracao-custo.service';
import { GatewayGraficosService } from './services/gateway-graficos.service';
import { EquipamentoDadosQueryDto } from './dto/equipamento-dados-query.dto';
import { CustosEnergiaQueryDto, PeriodoTipo } from './dto/custos-energia-query.dto';
import { UpsertConfiguracaoCustoDto } from './dto/configuracao-custo.dto';

@Controller('equipamentos-dados')
export class EquipamentosDadosController {
  private readonly logger = new Logger(EquipamentosDadosController.name);
  // Controller de dados de equipamentos com endpoint de custos de energia

  constructor(
    private readonly service: EquipamentosDadosService,
    private readonly custosService: CalculoCustosService,
    private readonly configuracaoCustoService: ConfiguracaoCustoService,
    private readonly gatewayGraficosService: GatewayGraficosService,
  ) {}

  /**
   * GET /equipamentos-dados/:id/latest
   * Retorna o dado mais recente de um equipamento
   */
  @Get(':id/latest')
  async getLatest(@Param('id') id: string) {
    this.logger.log(`GET /equipamentos-dados/${id}/latest`);
    return this.service.findLatest(id);
  }

  /**
   * GET /equipamentos-dados/:id/history
   * Retorna o histórico de dados de um equipamento
   */
  @Get(':id/history')
  async getHistory(
    @Param('id') id: string,
    @Query() query: EquipamentoDadosQueryDto,
  ) {
    this.logger.log(`GET /equipamentos-dados/${id}/history`);
    return this.service.findHistory(id, query);
  }

  /**
   * GET /equipamentos-dados/:id/stats
   * Retorna estatísticas de dados de um equipamento
   */
  @Get(':id/stats')
  async getStats(@Param('id') id: string) {
    this.logger.log(`GET /equipamentos-dados/${id}/stats`);
    return this.service.getStats(id);
  }

  /**
   * GET /equipamentos-dados/:id/grafico-dia
   * Retorna dados para gráfico do dia (curva de potência)
   */
  @Get(':id/grafico-dia')
  async getGraficoDia(
    @Param('id') id: string,
    @Query('data') data?: string,       // formato: YYYY-MM-DD (opcional, default: hoje)
    @Query('intervalo') intervalo?: string, // '1' | '5' | '15' | '30' (minutos, default: 30)
    @Query('inicio') inicio?: string,   // ISO datetime - janela específica (zoom)
    @Query('fim') fim?: string,         // ISO datetime - janela específica (zoom)
  ) {
    this.logger.log(`GET /equipamentos-dados/${id}/grafico-dia?intervalo=${intervalo || '30'}`);
    return this.service.getGraficoDia(id, data, intervalo, inicio, fim);
  }

  /**
   * GET /equipamentos-dados/:id/grafico-mes
   * Retorna dados para gráfico do mês (energia por dia)
   */
  @Get(':id/grafico-mes')
  async getGraficoMes(
    @Param('id') id: string,
    @Query('mes') mes?: string, // formato: YYYY-MM (opcional, default: mês atual)
  ) {
    this.logger.log(`GET /equipamentos-dados/${id}/grafico-mes?mes=${mes || 'atual'}`);
    return this.service.getGraficoMes(id, mes);
  }

  /**
   * GET /equipamentos-dados/:id/grafico-ano
   * Retorna dados para gráfico do ano (energia por mês)
   */
  @Get(':id/grafico-ano')
  async getGraficoAno(
    @Param('id') id: string,
    @Query('ano') ano?: string, // formato: YYYY (opcional, default: ano atual)
  ) {
    this.logger.log(`GET /equipamentos-dados/${id}/grafico-ano?ano=${ano || 'atual'}`);
    return this.service.getGraficoAno(id, ano);
  }

  // ============================================================================
  // GATEWAY (A966 / categoria Gateway) - phf/phr direto do payload MQTT
  // ============================================================================

  @Get(':id/gateway/grafico-dia')
  async getGatewayGraficoDia(
    @Param('id') id: string,
    @Query('data') data?: string,
    @Query('intervalo') intervalo?: string,
    @Query('inicio') inicio?: string,
    @Query('fim') fim?: string,
  ) {
    this.logger.log(`GET /equipamentos-dados/${id}/gateway/grafico-dia`);
    return this.gatewayGraficosService.getGraficoDia(id, data, intervalo, inicio, fim);
  }

  @Get(':id/gateway/grafico-mes')
  async getGatewayGraficoMes(
    @Param('id') id: string,
    @Query('mes') mes?: string,
  ) {
    this.logger.log(`GET /equipamentos-dados/${id}/gateway/grafico-mes`);
    return this.gatewayGraficosService.getGraficoMes(id, mes);
  }

  // ============================================================================
  // ✅ ENDPOINTS COM ALIASES - Para Compatibilidade com Frontend Existente
  // ============================================================================

  /**
   * POST /equipamentos-dados/multiplos-inversores/grafico-dia
   * Alias que aponta para versão otimizada V2
   * ✅ Usado pelo frontend (AupusNexOn)
   */
  @Post('multiplos-inversores/grafico-dia')
  async getGraficoDiaMultiplosInversoresAlias(
    @Body('equipamentosIds') equipamentosIds: string[],
    @Query('data') data?: string,
  ) {
    this.logger.log(`⚡ POST /multiplos-inversores/grafico-dia → V2 (${equipamentosIds.length} equipamentos)`);
    return this.service.getGraficoDiaMultiplosInversores_V2(equipamentosIds, data);
  }

  /**
   * POST /equipamentos-dados/multiplos-inversores/grafico-mes
   * Alias que aponta para versão otimizada V2
   * ✅ Usado pelo frontend (AupusNexOn)
   */
  @Post('multiplos-inversores/grafico-mes')
  async getGraficoMesMultiplosInversoresAlias(
    @Body('equipamentosIds') equipamentosIds: string[],
    @Query('mes') mes?: string,
  ) {
    this.logger.log(`⚡ POST /multiplos-inversores/grafico-mes → V2 (${equipamentosIds.length} equipamentos)`);
    return this.service.getGraficoMesMultiplosInversores_V2(equipamentosIds, mes);
  }

  /**
   * POST /equipamentos-dados/multiplos-inversores/grafico-ano
   * Alias que aponta para versão otimizada V2
   * ✅ Usado pelo frontend (AupusNexOn)
   */
  @Post('multiplos-inversores/grafico-ano')
  async getGraficoAnoMultiplosInversoresAlias(
    @Body('equipamentosIds') equipamentosIds: string[],
    @Query('ano') ano?: string,
  ) {
    this.logger.log(`⚡ POST /multiplos-inversores/grafico-ano → V2 (${equipamentosIds.length} equipamentos)`);
    return this.service.getGraficoAnoMultiplosInversores_V2(equipamentosIds, ano);
  }

  // ============================================================================
  // ✅ ENDPOINTS OTIMIZADOS V2 - Agregação no Banco (Múltiplos Equipamentos)
  // ============================================================================

  /**
   * POST /equipamentos-dados/grafico-dia-multiplos-v2
   * 🚀 OTIMIZADO: Agregação no PostgreSQL (5 min intervals)
   * Performance: 100x mais rápido (5s → 50ms)
   */
  @Post('grafico-dia-multiplos-v2')
  async getGraficoDiaMultiplosV2(
    @Body('equipamentosIds') equipamentosIds: string[],
    @Body('data') data?: string,
  ) {
    this.logger.log(`⚡ POST /grafico-dia-multiplos-v2 (${equipamentosIds.length} equipamentos)`);
    return this.service.getGraficoDiaMultiplosInversores_V2(equipamentosIds, data);
  }

  /**
   * POST /equipamentos-dados/grafico-mes-multiplos-v2
   * 🚀 OTIMIZADO: Agregação no PostgreSQL (daily)
   * Performance: 100x mais rápido (30s → 300ms)
   */
  @Post('grafico-mes-multiplos-v2')
  async getGraficoMesMultiplosV2(
    @Body('equipamentosIds') equipamentosIds: string[],
    @Body('mes') mes?: string,
  ) {
    this.logger.log(`⚡ POST /grafico-mes-multiplos-v2 (${equipamentosIds.length} equipamentos)`);
    return this.service.getGraficoMesMultiplosInversores_V2(equipamentosIds, mes);
  }

  /**
   * POST /equipamentos-dados/grafico-ano-multiplos-v2
   * 🚀 OTIMIZADO: Agregação no PostgreSQL (monthly)
   * Performance: 100x mais rápido (60s → 600ms)
   */
  @Post('grafico-ano-multiplos-v2')
  async getGraficoAnoMultiplosV2(
    @Body('equipamentosIds') equipamentosIds: string[],
    @Body('ano') ano?: string,
  ) {
    this.logger.log(`⚡ POST /grafico-ano-multiplos-v2 (${equipamentosIds.length} equipamentos)`);
    return this.service.getGraficoAnoMultiplosInversores_V2(equipamentosIds, ano);
  }

  // ============================================================================
  // 📊 ENDPOINTS ANTIGOS (manter para compatibilidade)
  // ============================================================================

  /**
   * POST /equipamentos-dados/grafico-dia-multiplos
   * ⚠️ DEPRECATED: Use grafico-dia-multiplos-v2 para melhor performance
   */
  @Post('grafico-dia-multiplos')
  async getGraficoDiaMultiplos(
    @Body('equipamentosIds') equipamentosIds: string[],
    @Body('data') data?: string,
  ) {
    this.logger.log(`POST /grafico-dia-multiplos (${equipamentosIds.length} equipamentos) [DEPRECATED]`);
    return this.service.getGraficoDiaMultiplosInversores(equipamentosIds, data);
  }

  /**
   * POST /equipamentos-dados/grafico-mes-multiplos
   * ⚠️ DEPRECATED: Use grafico-mes-multiplos-v2 para melhor performance
   */
  @Post('grafico-mes-multiplos')
  async getGraficoMesMultiplos(
    @Body('equipamentosIds') equipamentosIds: string[],
    @Body('mes') mes?: string,
  ) {
    this.logger.log(`POST /grafico-mes-multiplos (${equipamentosIds.length} equipamentos) [DEPRECATED]`);
    return this.service.getGraficoMesMultiplosInversores(equipamentosIds, mes);
  }

  /**
   * POST /equipamentos-dados/grafico-ano-multiplos
   * ⚠️ DEPRECATED: Use grafico-ano-multiplos-v2 para melhor performance
   */
  @Post('grafico-ano-multiplos')
  async getGraficoAnoMultiplos(
    @Body('equipamentosIds') equipamentosIds: string[],
    @Body('ano') ano?: string,
  ) {
    this.logger.log(`POST /grafico-ano-multiplos (${equipamentosIds.length} equipamentos) [DEPRECATED]`);
    return this.service.getGraficoAnoMultiplosInversores(equipamentosIds, ano);
  }

  /**
   * GET /equipamentos-dados/:id/configuracao-custo
   * Retorna configuracao de tributos e tarifas personalizadas do equipamento
   */
  @Get(':id/configuracao-custo')
  async getConfiguracaoCusto(@Param('id') id: string) {
    this.logger.log(`GET /equipamentos-dados/${id}/configuracao-custo`);
    return this.configuracaoCustoService.buscarOuDefault(id);
  }

  /**
   * PUT /equipamentos-dados/:id/configuracao-custo
   * Cria ou atualiza configuracao de tributos e tarifas personalizadas
   */
  @Put(':id/configuracao-custo')
  async upsertConfiguracaoCusto(
    @Param('id') id: string,
    @Body() dto: UpsertConfiguracaoCustoDto,
  ) {
    this.logger.log(`PUT /equipamentos-dados/${id}/configuracao-custo`);
    return this.configuracaoCustoService.upsert(id, dto);
  }

  /**
   * GET /equipamentos-dados/:id/custos-energia
   * Retorna calculo de custos de energia com tributos aplicados
   */
  @Get(':id/custos-energia')
  async getCustosEnergia(
    @Param('id') id: string,
    @Query() query: CustosEnergiaQueryDto,
  ) {
    this.logger.log(
      `GET /equipamentos-dados/${id}/custos-energia?periodo=${query.periodo || 'custom'}&data=${query.data || ''}&timestamp_inicio=${query.timestamp_inicio || ''}&timestamp_fim=${query.timestamp_fim || ''}`,
    );

    // Determinar range de datas com base no período
    const { dataInicio, dataFim } = this.calcularRangeDatas(query);

    this.logger.log(
      `📊 [CUSTOS] Calculando custos para equipamento ${id} de ${dataInicio.toISOString()} até ${dataFim.toISOString()}`,
    );

    // Chamar serviço de cálculo (✅ passar tipo de período)
    const resultado = await this.custosService.calcularCustos(id, dataInicio, dataFim, query.periodo);

    // Montar response DTO
    return this.montarResponseCustos(resultado, query, dataInicio, dataFim);
  }

  /**
   * Calcula range de datas com base no período solicitado
   * ✅ CORRIGIDO: Usa conversão de timezone dinâmica (America/Sao_Paulo)
   */
  private calcularRangeDatas(query: CustosEnergiaQueryDto): {
    dataInicio: Date;
    dataFim: Date;
  } {
    // MODO 1: Período customizado com timestamps
    if (query.periodo === PeriodoTipo.CUSTOM || (query.timestamp_inicio && query.timestamp_fim)) {
      if (!query.timestamp_inicio || !query.timestamp_fim) {
        throw new Error(
          'Para período customizado, timestamp_inicio e timestamp_fim são obrigatórios',
        );
      }

      const dataInicio = new Date(query.timestamp_inicio);
      const dataFim = new Date(query.timestamp_fim);

      // Validar que início é antes do fim
      if (dataInicio >= dataFim) {
        throw new Error('timestamp_inicio deve ser anterior a timestamp_fim');
      }

      // Validar que não é um período muito longo (máximo 1 ano)
      const diffDias = (dataFim.getTime() - dataInicio.getTime()) / (1000 * 60 * 60 * 24);
      if (diffDias > 366) {
        throw new Error('Período máximo permitido: 1 ano (366 dias)');
      }

      return { dataInicio, dataFim };
    }

    // MODO 2 e 3: Dia ou Mês com data de referência
    // O banco armazena timestamps em BRT sem timezone (Prisma trata como UTC)
    // Então criamos datas UTC com os valores de BRT para comparação direta
    let ano: number, mes: number, dia: number;

    if (query.data) {
      // query.data vem como "YYYY-MM-DD" — parsear diretamente os componentes
      const parts = query.data.split('-');
      ano = parseInt(parts[0]);
      mes = parseInt(parts[1]);
      dia = parseInt(parts[2]) || 1; // Para periodo=mes, data pode ser "YYYY-MM"
    } else {
      // Sem data informada: pegar data atual em Brasília
      const { ano: a, mes: m, dia: d } = this.obterDataAtualBrasilia();
      ano = a;
      mes = m;
      dia = d;
    }

    if (query.periodo === PeriodoTipo.DIA) {
      // Dia completo: enviar BRT como UTC literal (banco armazena BRT sem tz)
      const dataInicio = new Date(Date.UTC(ano, mes - 1, dia, 0, 0, 0, 0));
      const dataFim = new Date(Date.UTC(ano, mes - 1, dia, 23, 59, 59, 999));

      return { dataInicio, dataFim };
    } else if (query.periodo === PeriodoTipo.MES) {
      const ultimoDia = new Date(ano, mes, 0).getDate();

      const dataInicio = new Date(Date.UTC(ano, mes - 1, 1, 0, 0, 0, 0));
      const dataFim = new Date(Date.UTC(ano, mes - 1, ultimoDia, 23, 59, 59, 999));

      return { dataInicio, dataFim };
    }

    // Default: mês atual em Brasília (backward compatibility)
    const agora = this.obterDataAtualBrasilia();
    const ultimoDiaDefault = new Date(agora.ano, agora.mes, 0).getDate();
    const dataInicio = new Date(Date.UTC(agora.ano, agora.mes - 1, 1, 0, 0, 0, 0));
    const dataFim = new Date(Date.UTC(agora.ano, agora.mes - 1, ultimoDiaDefault, 23, 59, 59, 999));

    return { dataInicio, dataFim };
  }

  /**
   * Retorna ano, mês e dia atuais no fuso de Brasília (America/Sao_Paulo)
   */
  private obterDataAtualBrasilia(): { ano: number; mes: number; dia: number } {
    const now = new Date();
    const brasilStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); // formato YYYY-MM-DD
    const [ano, mes, dia] = brasilStr.split('-').map(Number);
    return { ano, mes, dia };
  }

  /**
   * Cria uma data interpretando os componentes como timezone de Brasília
   * ✅ NOVO: Método auxiliar para conversão dinâmica de timezone
   *
   * Exemplo:
   * Input: criarDataBrasilia(2026, 3, 6, 0, 0, 0, 0)
   * Output: Date em UTC que representa 06/03/2026 00:00:00 em Brasília
   *         Se BRT = UTC-3 → retorna 06/03/2026 03:00:00 UTC
   */
  private criarDataBrasilia(
    ano: number,
    mes: number,
    dia: number,
    hora: number,
    minuto: number,
    segundo: number,
    ms: number,
  ): Date {
    // Criar string ISO da data/hora em Brasília
    const mesStr = String(mes).padStart(2, '0');
    const diaStr = String(dia).padStart(2, '0');
    const horaStr = String(hora).padStart(2, '0');
    const minutoStr = String(minuto).padStart(2, '0');
    const segundoStr = String(segundo).padStart(2, '0');

    const isoStringBrasilia = `${ano}-${mesStr}-${diaStr}T${horaStr}:${minutoStr}:${segundoStr}`;

    // Criar Date assumindo que é UTC (vai estar errado)
    const dateUTC = new Date(isoStringBrasilia + 'Z');

    // Obter como seria essa data em Brasília
    const dataBrasiliaStr = dateUTC.toLocaleString('en-US', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

    // Parsear o resultado
    const [datePart, timePart] = dataBrasiliaStr.split(', ');
    const [monthBrt, dayBrt, yearBrt] = datePart.split('/');
    const [hourBrt, minuteBrt, secondBrt] = timePart.split(':');

    // Calcular diferença (offset) entre UTC e Brasília para esta data
    const dateBrasiliaLocal = new Date(
      `${yearBrt}-${monthBrt}-${dayBrt}T${hourBrt}:${minuteBrt}:${secondBrt}`,
    );

    // Offset em milissegundos
    const offset = dateUTC.getTime() - dateBrasiliaLocal.getTime();

    // Criar data original em UTC
    const dateOriginalUTC = new Date(isoStringBrasilia);

    // Aplicar offset para converter de Brasília para UTC
    return new Date(dateOriginalUTC.getTime() + offset + ms);
  }

  /**
   * Monta o response DTO com os dados calculados
   */
  private montarResponseCustos(
    resultado: any,
    query: CustosEnergiaQueryDto,
    dataInicio: Date,
    dataFim: Date,
  ) {
    const { unidade, tarifas, agregacao, custos, tributos, tarifa_fonte } = resultado;

    return {
      periodo: {
        tipo: query.periodo,
        data_inicio: dataInicio.toISOString(),
        data_fim: dataFim.toISOString(),
      },
      unidade: {
        id: unidade.id,
        nome: unidade.nome,
        grupo: unidade.grupo,
        subgrupo: unidade.subgrupo,
        irrigante: unidade.irrigante,
      },
      concessionaria: {
        id: unidade.concessionaria_id,
      },
      tarifas_aplicadas: this.montarTarifasAplicadas(unidade, tarifas),
      tarifa_fonte: tarifa_fonte || 'CONCESSIONARIA',
      consumo: {
        energia_ponta_kwh: agregacao.energia_ponta_kwh,
        energia_fora_ponta_kwh: agregacao.energia_fora_ponta_kwh,
        energia_reservado_kwh: agregacao.energia_reservado_kwh,
        energia_irrigante_kwh: agregacao.energia_irrigante_kwh,
        energia_total_kwh: agregacao.energia_total_kwh,
        demanda_maxima_kw: agregacao.demanda_maxima_kw,
        demanda_contratada_kw: unidade.demanda_contratada,
      },
      custos: {
        custo_ponta: custos.custo_ponta,
        custo_fora_ponta: custos.custo_fora_ponta,
        custo_reservado: custos.custo_reservado,
        custo_irrigante: custos.custo_irrigante,
        custo_demanda: custos.custo_demanda,
        custo_total: custos.custo_total,
        custo_medio_kwh: custos.custo_medio_kwh,
        custo_total_sem_tributos: custos.custo_total_sem_tributos,
        fator_tributos: custos.fator_tributos,
        fator_perdas: custos.fator_perdas,
      },
      tributos: tributos
        ? {
            icms: tributos.icms,
            pis: tributos.pis,
            cofins: tributos.cofins,
            perdas: tributos.perdas,
            fator_multiplicador: custos.fator_tributos,
          }
        : { icms: 0, pis: 0, cofins: 0, perdas: 0, fator_multiplicador: 1 },
      irrigante: unidade.irrigante
        ? {
            energia_periodo_kwh: agregacao.energia_irrigante_kwh,
            economia_total: custos.economia_irrigante,
            percentual_desconto: 80,
            horario_inicio: '21:30',
            horario_fim: '06:00',
          }
        : undefined,
    };
  }

  /**
   * Monta array de tarifas aplicadas com base no grupo da unidade
   */
  private montarTarifasAplicadas(unidade: any, tarifas: any) {
    if (unidade.grupo === 'A') {
      return [
        {
          tipo_horario: 'PONTA',
          tarifa_tusd: tarifas.tusd_p,
          tarifa_te: tarifas.te_p,
          tarifa_total: tarifas.tusd_p + tarifas.te_p,
          horario_inicio: '18:00', // ✅ ATUALIZADO de 17:00 para 18:00
          horario_fim: '21:00',    // ✅ ATUALIZADO de 20:00 para 21:00
          dias_aplicacao: 'Todos', // ✅ ATUALIZADO: ponta agora é todos os dias
        },
        {
          tipo_horario: 'FORA_PONTA',
          tarifa_tusd: tarifas.tusd_fp,
          tarifa_te: tarifas.te_fp,
          tarifa_total: tarifas.tusd_fp + tarifas.te_fp,
          horario_inicio: '06:00', // ✅ ATUALIZADO: FP tem 2 períodos: 06:00-18:00 e 21:00-21:30
          horario_fim: '18:00',
          dias_aplicacao: 'Todos',
        },
        {
          tipo_horario: 'RESERVADO',
          tarifa_tusd: tarifas.tusd_fp,
          tarifa_te: tarifas.te_fp,
          tarifa_total: tarifas.tusd_fp + tarifas.te_fp,
          horario_inicio: '21:30', // ✅ ATUALIZADO: HR inicia às 21:30
          horario_fim: '06:00',
          dias_aplicacao: 'Todos',
          observacao: 'Na tarifa Verde: HR = FP',
        },
        {
          tipo_horario: 'DEMANDA',
          tarifa_tusd: tarifas.tusd_d,
          tarifa_te: tarifas.te_d,
          tarifa_total: tarifas.tusd_d + (tarifas.te_d || 0),
        },
      ];
    } else {
      // Grupo B
      return [
        {
          tipo_horario: 'FORA_PONTA',
          tarifa_tusd: tarifas.tusd_b,
          tarifa_te: tarifas.te_b,
          tarifa_total: tarifas.tusd_b + tarifas.te_b,
          horario_inicio: null,
          horario_fim: null,
          dias_aplicacao: 'Todos',
        },
      ];
    }
  }
}
