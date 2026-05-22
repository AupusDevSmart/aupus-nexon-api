import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@aupus/api-shared';
import { ClassificacaoHorariosService } from './classificacao-horarios.service';
import { ConfiguracaoCustoService, ConfiguracaoCustoData } from './configuracao-custo.service';
import {
  TipoHorario,
  DadosUnidade,
  TarifasConcessionaria,
  TributosConfig,
  LeituraMQTT,
  AgregacaoEnergia,
  CalculoCustos,
} from '../interfaces/calculo-custos.interface';

/**
 * Serviço principal de cálculo de custos de energia
 *
 * Responsável por:
 * 1. Buscar leituras MQTT do período
 * 2. Classificar cada leitura por tipo de horário
 * 3. Agregar energia por categoria (P, FP, HR, Irrigante)
 * 4. Calcular custos totais
 */
@Injectable()
export class CalculoCustosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly classificacaoService: ClassificacaoHorariosService,
    private readonly configuracaoCustoService: ConfiguracaoCustoService,
  ) {}

  /**
   * Calcula custos de energia para um equipamento em um período
   */
  /** Período máximo aceito pelo cálculo (em milissegundos). 2 anos. */
  private readonly PERIODO_MAX_MS = 2 * 365 * 24 * 60 * 60 * 1000;

  async calcularCustos(
    equipamentoId: string,
    dataInicio: Date,
    dataFim: Date,
    periodo?: 'dia' | 'mes' | 'custom',
  ): Promise<{
    unidade: DadosUnidade;
    tarifas: TarifasConcessionaria;
    agregacao: AgregacaoEnergia;
    custos: CalculoCustos;
    periodo_tipo?: string;
    tributos: TributosConfig;
    tarifa_fonte: 'CONCESSIONARIA' | 'PERSONALIZADA';
    aviso?: string;
  }> {
    // Validações de entrada (mensagens em PT-BR direto pro usuário)
    if (!(dataInicio instanceof Date) || isNaN(dataInicio.getTime())) {
      throw new BadRequestException('Data inicial inválida.');
    }
    if (!(dataFim instanceof Date) || isNaN(dataFim.getTime())) {
      throw new BadRequestException('Data final inválida.');
    }
    if (dataInicio >= dataFim) {
      throw new BadRequestException(
        'Data inicial deve ser anterior à data final.',
      );
    }
    if (dataFim.getTime() - dataInicio.getTime() > this.PERIODO_MAX_MS) {
      throw new BadRequestException(
        'Período máximo permitido: 2 anos. Selecione um intervalo menor.',
      );
    }

    console.log(`\n[CUSTOS] Iniciando calculo de custos`);
    console.log(`   Equipamento: ${equipamentoId}`);
    console.log(`   Periodo: ${dataInicio.toLocaleString('pt-BR')} ate ${dataFim.toLocaleString('pt-BR')}`);
    console.log(`   Tipo: ${periodo || 'custom'}`);

    // 1. Buscar dados da unidade e tarifas da concessionaria + horarios dos postos
    const { unidade, tarifas: tarifasConcessionaria, horarios } =
      await this.buscarDadosUnidadeETarifas(equipamentoId);
    console.log(`   Unidade: ${unidade.nome} (Grupo ${unidade.grupo}, Irrigante: ${unidade.irrigante ? 'SIM' : 'NAO'})`);

    // 2. Buscar configuracao de custo (tributos + tarifa personalizada)
    const config = await this.configuracaoCustoService.buscarOuDefault(equipamentoId);
    const tributos: TributosConfig = {
      icms: config.icms,
      pis: config.pis,
      cofins: config.cofins,
      perdas: config.perdas,
    };

    // 3. Determinar tarifas finais (personalizada ou concessionaria)
    let tarifas = tarifasConcessionaria;
    let tarifaFonte: 'CONCESSIONARIA' | 'PERSONALIZADA' = 'CONCESSIONARIA';

    if (config.usa_tarifa_personalizada) {
      tarifas = this.aplicarTarifaPersonalizada(tarifasConcessionaria, config);
      tarifaFonte = 'PERSONALIZADA';
      console.log(`   Usando tarifa PERSONALIZADA`);
    }

    console.log(`   Tributos: ICMS=${(tributos.icms * 100).toFixed(2)}% PIS=${(tributos.pis * 100).toFixed(2)}% COFINS=${(tributos.cofins * 100).toFixed(2)}% Perdas=${(tributos.perdas || 0).toFixed(2)}%`);

    // Aviso (nao-fatal) quando concessionaria nao tem tarifa do grupo da unidade.
    // Custos ainda sao calculados (com tarifa zerada), mas a UI pode alertar.
    const avisoTarifa = this.detectarTarifaFaltando(unidade, tarifas);

    // 4. Buscar leituras MQTT do periodo
    const leituras = await this.buscarLeiturasPeriodo(equipamentoId, dataInicio, dataFim);
    console.log(`   Leituras encontradas: ${leituras.length}`);

    // 5. Agregar energia por tipo de horario (horarios vem da concessionaria)
    const agregacao = this.agregarEnergiaPorTipo(leituras, unidade, tarifas, horarios);
    console.log(`   Energia total: ${agregacao.energia_total_kwh.toFixed(3)} kWh`);

    // 6. Decidir se inclui demanda no custo
    const incluirDemanda = this.deveIncluirDemanda(periodo, dataInicio, dataFim);

    // 7. Calcular custos com tributos
    const custos = this.calcularCustosPorCategoria(agregacao, unidade, tarifas, incluirDemanda, tributos);
    console.log(`   Custo s/ tributos: R$ ${custos.custo_total_sem_tributos.toFixed(2)}`);
    console.log(`   Custo c/ tributos: R$ ${custos.custo_total.toFixed(2)} (fator: ${custos.fator_tributos.toFixed(4)}x)`);
    console.log('');

    // Aviso de empty: total de leituras COM phf (a base do delta) eh 0.
    // Eh diferente de "energia 0" — significa "sem leituras no periodo".
    const aviso = leituras.length === 0
      ? 'Nenhuma leitura encontrada para o período selecionado.'
      : avisoTarifa;

    return {
      unidade,
      tarifas,
      agregacao,
      custos,
      periodo_tipo: periodo,
      tributos,
      tarifa_fonte: tarifaFonte,
      ...(aviso ? { aviso } : {}),
    };
  }

  /**
   * Detecta se a concessionaria nao tem tarifa configurada pro grupo da
   * unidade. Retorna mensagem amigavel pra UI ou undefined se OK.
   *
   * Grupo A precisa de tusd_p OU te_p OU tusd_fp OU te_fp configurados.
   * Grupo B precisa de tusd_b OU te_b.
   */
  private detectarTarifaFaltando(
    unidade: DadosUnidade,
    tarifas: TarifasConcessionaria,
  ): string | undefined {
    if (unidade.grupo === 'A') {
      const temAlguma = (tarifas.tusd_p || tarifas.te_p ||
                        tarifas.tusd_fp || tarifas.te_fp);
      if (!temAlguma) {
        return `Concessionária sem tarifa configurada para o Grupo A da unidade (${unidade.subgrupo}). Custos exibidos com tarifa zerada.`;
      }
    } else if (unidade.grupo === 'B') {
      const temAlguma = (tarifas.tusd_b || tarifas.te_b);
      if (!temAlguma) {
        return `Concessionária sem tarifa configurada para o Grupo B da unidade. Custos exibidos com tarifa zerada.`;
      }
    }
    return undefined;
  }

  /**
   * Aplica tarifas personalizadas, usando concessionaria como fallback para campos null
   */
  private aplicarTarifaPersonalizada(
    tarifasConcessionaria: TarifasConcessionaria,
    config: ConfiguracaoCustoData,
  ): TarifasConcessionaria {
    return {
      tusd_p: config.tusd_p ?? tarifasConcessionaria.tusd_p,
      te_p: config.te_p ?? tarifasConcessionaria.te_p,
      tusd_fp: config.tusd_fp ?? tarifasConcessionaria.tusd_fp,
      te_fp: config.te_fp ?? tarifasConcessionaria.te_fp,
      tusd_d: config.tusd_d ?? tarifasConcessionaria.tusd_d,
      te_d: config.te_d ?? tarifasConcessionaria.te_d,
      tusd_b: config.tusd_b ?? tarifasConcessionaria.tusd_b,
      te_b: config.te_b ?? tarifasConcessionaria.te_b,
    };
  }

  /**
   * Calcula fator multiplicador dos tributos
   * Formula: Preco = (TE + TUSD) / ((1 - ICMS) * (1 - PIS - COFINS))
   * Fator = 1 / ((1 - ICMS) * (1 - PIS - COFINS))
   */
  private calcularFatorTributos(tributos: TributosConfig): number {
    const denominador = (1 - tributos.icms) * (1 - tributos.pis - tributos.cofins);
    return denominador > 0 ? 1 / denominador : 1;
  }

  /**
   * Decide se deve incluir demanda contratada no cálculo de custos
   *
   * ATUALIZAÇÃO: Demanda nunca é incluída no cálculo
   * Apenas demanda_maxima_kw é exibida como informação
   */
  private deveIncluirDemanda(
    periodo: 'dia' | 'mes' | 'custom' | undefined,
    dataInicio: Date,
    dataFim: Date,
  ): boolean {
    // Nunca incluir demanda no custo
    return false;
  }

  /**
   * Busca dados da unidade e tarifas da concessionária
   */
  private async buscarDadosUnidadeETarifas(
    equipamentoId: string,
  ): Promise<{
    unidade: DadosUnidade;
    tarifas: TarifasConcessionaria;
    horarios: Partial<import('../interfaces/calculo-custos.interface').ConfiguracaoHorarios>;
  }> {
    // Buscar equipamento com unidade e concessionária
    const equipamento = await this.prisma.equipamentos.findUnique({
      where: { id: equipamentoId },
      include: {
        unidade: {
          include: {
            concessionaria: true,
          },
        },
      },
    });

    if (!equipamento) {
      throw new NotFoundException('Equipamento não encontrado.');
    }
    if (!equipamento.unidade) {
      throw new NotFoundException(
        'Equipamento não está vinculado a uma unidade. Verifique o cadastro.',
      );
    }

    const unidadeDb = equipamento.unidade;
    const concessionariaDb = unidadeDb.concessionaria;

    if (!concessionariaDb) {
      throw new NotFoundException(
        'Unidade sem concessionária cadastrada. Configure no cadastro da unidade.',
      );
    }

    // Montar dados da unidade
    const unidade: DadosUnidade = {
      id: unidadeDb.id,
      nome: unidadeDb.nome,
      grupo: unidadeDb.grupo || 'B', // Default para Grupo B se não especificado
      subgrupo: unidadeDb.subgrupo || '',
      irrigante: unidadeDb.irrigante,
      demanda_contratada: unidadeDb.demanda_carga
        ? parseFloat(unidadeDb.demanda_carga.toString())
        : undefined,
      concessionaria_id: concessionariaDb.id,
    };

    // Montar tarifas com base no grupo e subgrupo
    const tarifas: TarifasConcessionaria = this.montarTarifas(unidade, concessionariaDb);

    // Horarios dos postos tarifarios — vem da concessionaria (com defaults via schema).
    // Mapeia hora_inicio_reservado_decimal -> hora_inicio_irrigante_decimal (mesma janela
    // do reservado se aplica tambem ao desconto irrigante).
    const concAny = concessionariaDb as any;
    const horarios = {
      hora_inicio_ponta: Number(concAny.hora_inicio_ponta ?? 18),
      hora_fim_ponta: Number(concAny.hora_fim_ponta ?? 21),
      // ConfiguracaoHorarios usa nomes legados *_irrigante_*; mapeia do banco
      // que agora chama *_reservado (semantica unificada).
      hora_inicio_irrigante_decimal: Number(concAny.hora_inicio_reservado ?? 21.5),
      hora_fim_irrigante: Number(concAny.hora_fim_reservado ?? 6),
    };

    return { unidade, tarifas, horarios };
  }

  /**
   * Monta objeto de tarifas com base no grupo/subgrupo da unidade
   */
  private montarTarifas(unidade: DadosUnidade, concessionaria: any): TarifasConcessionaria {
    if (unidade.grupo === 'A') {
      // Determinar qual conjunto de tarifas usar (A3a ou A4)
      const prefixo = unidade.subgrupo.toLowerCase().replace(/[^a-z0-9]/g, ''); // a3a, a4, etc

      // Verificar se contém 'a3a' no subgrupo
      if (prefixo.includes('a3a')) {
        return {
          tusd_p: this.parseDecimal(concessionaria.a3a_verde_tusd_p),
          te_p: this.parseDecimal(concessionaria.a3a_verde_te_p),
          tusd_fp: this.parseDecimal(concessionaria.a3a_verde_tusd_fp),
          te_fp: this.parseDecimal(concessionaria.a3a_verde_te_fp),
          tusd_d: this.parseDecimal(concessionaria.a3a_verde_tusd_d),
          te_d: this.parseDecimal(concessionaria.a3a_verde_te_d),
        };
      } else if (prefixo.includes('a4')) {
        // Verifica se contém 'a4' (pega tanto 'a4' quanto 'a4verde')
        return {
          tusd_p: this.parseDecimal(concessionaria.a4_verde_tusd_p),
          te_p: this.parseDecimal(concessionaria.a4_verde_te_p),
          tusd_fp: this.parseDecimal(concessionaria.a4_verde_tusd_fp),
          te_fp: this.parseDecimal(concessionaria.a4_verde_te_fp),
          tusd_d: this.parseDecimal(concessionaria.a4_verde_tusd_d),
          te_d: this.parseDecimal(concessionaria.a4_verde_te_d),
        };
      }
    }

    // Grupo B (padrão)
    return {
      tusd_b: this.parseDecimal(concessionaria.b_tusd_valor),
      te_b: this.parseDecimal(concessionaria.b_te_valor),
    };
  }

  /**
   * Converte Decimal do Prisma para number
   */
  private parseDecimal(value: any): number {
    if (value === null || value === undefined) return 0;
    return parseFloat(value.toString());
  }

  /**
   * Busca leituras MQTT do período com energia derivada de delta-phf.
   *
   * Mudança de fonte da verdade (ver docs/tickets/powermeter-delta-phf.md):
   * - Antes: somava consumo_phf direto do JSON, com cap de 5 kWh/leitura e
   *   compensação extra de gap via delta-phf. Resultado divergia do medidor
   *   quando havia bug de firmware (consumo_phf ≈ phf cumulativo).
   * - Agora: energia_kwh de cada leitura = phf[i] - phf[i-1]. Cobre gaps
   *   por natureza (sem dupla contagem), ignora outliers do firmware, e
   *   trata reset de medidor (phf cai) zerando o delta nesse ponto.
   *
   * Primeira leitura tem energia_kwh = 0 (sem antecessor). A "última leitura
   * do período" carrega o consumo do intervalo [prev → atual] no bucket de
   * horário do timestamp atual — erro de borda < 30s, irrelevante na prática.
   */
  private async buscarLeiturasPeriodo(
    equipamentoId: string,
    dataInicio: Date,
    dataFim: Date,
  ): Promise<LeituraMQTT[]> {
    const dados = await this.prisma.equipamentos_dados.findMany({
      where: {
        equipamento_id: equipamentoId,
        timestamp_dados: {
          gte: dataInicio,
          lte: dataFim,
        },
      },
      orderBy: { timestamp_dados: 'asc' },
      select: {
        timestamp_dados: true,
        dados: true,
        potencia_ativa_kw: true,
      },
    });

    const leituras: LeituraMQTT[] = [];
    let phfPrev: number | null = null;
    let glitchCount = 0;

    for (const d of dados) {
      const dadosJson = d.dados as any;
      const phf = this.extrairPhf(dadosJson);

      let energia_kwh = 0;

      if (phf !== null) {
        if (phfPrev === null) {
          // Primeira leitura do periodo: define baseline, nao conta energia.
          phfPrev = phf;
        } else {
          const delta = phf - phfPrev;
          if (delta > 0) {
            // Caso normal: phf cresceu, conta o delta.
            energia_kwh = delta;
            phfPrev = phf;
          } else if (delta < 0) {
            // Glitch: phf caiu. Padrao real do CHINT — leitura solitaria com
            // phf corrompido (firmware enviando snapshot velho de NVM) entre
            // duas leituras normais. Ex: 10557 → 175 → 10557 → 10557.
            //
            // Algoritmo anterior atualizava phfPrev=175 na queda, e tratava a
            // proxima leitura (10557) como consumo legitimo de +10381, causando
            // soma falsa de +90k kWh nas 10 leituras outlier do CHINT.
            //
            // Correcao: NAO atualiza phfPrev. Mantém o ultimo valor "saudavel"
            // ate uma proxima leitura voltar a crescer a partir dele.
            //
            // Trade-off conhecido: RESET REAL de medidor (eletromecanico zerado
            // em manutencao — evento anual ou menos) tambem seria descartado.
            // Se ocorrer, adicionar heuristica de detecao (ex: N+ leituras
            // consecutivas estaveis em valor baixo = reset real, reiniciar
            // phfPrev). Por ora, descartar todo decremento eh o melhor
            // compromisso porque cobre o caso real em prod.
            glitchCount++;
          } else {
            // delta == 0: phf estavel (medidor parado ou janela curta), nada
            // a contar. phfPrev ja igual a phf — sem atualizacao necessaria.
          }
        }
      }

      // Potência: tentar coluna primeiro, depois JSON
      let potencia_kw = d.potencia_ativa_kw
        ? parseFloat(d.potencia_ativa_kw.toString())
        : 0;
      if (potencia_kw === 0 && dadosJson?.Pt) {
        potencia_kw = parseFloat(dadosJson.Pt.toString()) / 1000; // W → kW
      }

      leituras.push({
        timestamp: d.timestamp_dados,
        energia_kwh,
        potencia_kw,
      });
    }

    if (glitchCount > 0) {
      console.log(
        `   ⚠️ ${glitchCount} glitch(es) de phf descartado(s) em ${equipamentoId} ` +
        `(leituras com phf abaixo do anterior — provavelmente snapshot velho do firmware).`,
      );
    }

    return leituras;
  }

  /**
   * Extrai o valor phf do JSON de dados.
   * Aceita phf = 0 nas leituras pra suportar reset/snapshot vazio — quem decide
   * se aquela leitura conta é a lógica de delta em buscarLeiturasPeriodo.
   */
  private extrairPhf(dados: any): number | null {
    const json = dados as any;
    if (json?.phf !== undefined && json.phf !== null) {
      const val = parseFloat(json.phf.toString());
      return Number.isFinite(val) && val >= 0 ? val : null;
    }
    return null;
  }

  /**
   * Agrega energia por tipo de horário
   */
  private agregarEnergiaPorTipo(
    leituras: LeituraMQTT[],
    unidade: DadosUnidade,
    tarifas: TarifasConcessionaria,
    horarios: Partial<import('../interfaces/calculo-custos.interface').ConfiguracaoHorarios>,
  ): AgregacaoEnergia {
    const agregacao: AgregacaoEnergia = {
      energia_ponta_kwh: 0,
      energia_fora_ponta_kwh: 0,
      energia_reservado_kwh: 0,
      energia_irrigante_kwh: 0,
      energia_total_kwh: 0,
      demanda_maxima_kw: 0,
      num_leituras: leituras.length,
    };

    for (const leitura of leituras) {
      // Pular leituras sem delta (primeira do período, reset).
      if (leitura.energia_kwh <= 0) {
        // Demanda ainda interessa, mas atribuição por bucket sem energia eh no-op.
        if (leitura.potencia_kw > agregacao.demanda_maxima_kw) {
          agregacao.demanda_maxima_kw = leitura.potencia_kw;
        }
        continue;
      }

      // Classificar horário (horarios vem da concessionaria; fallback nos defaults
      // do ClassificacaoHorariosService se algum campo estiver null/undefined).
      const classificacao = this.classificacaoService.classificar(
        leitura.timestamp,
        unidade,
        tarifas,
        horarios,
      );

      // Agregar energia por tipo
      switch (classificacao.tipo) {
        case TipoHorario.PONTA:
          agregacao.energia_ponta_kwh += leitura.energia_kwh;
          break;
        case TipoHorario.FORA_PONTA:
          agregacao.energia_fora_ponta_kwh += leitura.energia_kwh;
          break;
        case TipoHorario.RESERVADO:
          agregacao.energia_reservado_kwh += leitura.energia_kwh;
          break;
        case TipoHorario.IRRIGANTE:
          agregacao.energia_irrigante_kwh += leitura.energia_kwh;
          break;
      }

      // Atualizar demanda máxima
      if (leitura.potencia_kw > agregacao.demanda_maxima_kw) {
        agregacao.demanda_maxima_kw = leitura.potencia_kw;
      }

      // Acumular total
      agregacao.energia_total_kwh += leitura.energia_kwh;
    }

    return agregacao;
  }

  /**
   * Calcula custos por categoria
   * ✅ ATUALIZADO: Parâmetro incluirDemanda para controlar se demanda entra no custo
   */
  private calcularCustosPorCategoria(
    agregacao: AgregacaoEnergia,
    unidade: DadosUnidade,
    tarifas: TarifasConcessionaria,
    incluirDemanda: boolean = false,
    tributos: TributosConfig = { icms: 0, pis: 0, cofins: 0, perdas: 0 },
  ): CalculoCustos {
    const fatorTributos = this.calcularFatorTributos(tributos);
    const fatorPerdas = 1 + (tributos.perdas || 0) / 100;

    const custos: CalculoCustos = {
      custo_ponta: 0,
      custo_fora_ponta: 0,
      custo_reservado: 0,
      custo_irrigante: 0,
      custo_demanda: 0,
      custo_total: 0,
      custo_medio_kwh: 0,
      economia_irrigante: 0,
      custo_total_sem_tributos: 0,
      fator_tributos: fatorTributos,
      fator_perdas: fatorPerdas,
    };

    if (unidade.grupo === 'A') {
      // Ponta: (TUSD_P + TE_P) * fatorTributos
      const tarifa_ponta = (tarifas.tusd_p || 0) + (tarifas.te_p || 0);
      custos.custo_ponta = agregacao.energia_ponta_kwh * fatorPerdas * tarifa_ponta * fatorTributos;

      // Fora Ponta
      const tarifa_fp = (tarifas.tusd_fp || 0) + (tarifas.te_fp || 0);
      custos.custo_fora_ponta = agregacao.energia_fora_ponta_kwh * fatorPerdas * tarifa_fp * fatorTributos;

      // Reservado (= FP na Verde)
      custos.custo_reservado = agregacao.energia_reservado_kwh * fatorPerdas * tarifa_fp * fatorTributos;

      // Irrigante (com 80% desconto na TE, tributos aplicados sobre tarifa com desconto)
      if (agregacao.energia_irrigante_kwh > 0) {
        const tusd = tarifas.tusd_fp || 0;
        const te_original = tarifas.te_fp || 0;
        const te_com_desconto = te_original * 0.20;
        const tarifa_irrigante = tusd + te_com_desconto;

        custos.custo_irrigante = agregacao.energia_irrigante_kwh * fatorPerdas * tarifa_irrigante * fatorTributos;

        const custo_sem_desconto = agregacao.energia_irrigante_kwh * fatorPerdas * tarifa_fp * fatorTributos;
        custos.economia_irrigante = custo_sem_desconto - custos.custo_irrigante;
      }

      // Demanda
      if (incluirDemanda && unidade.demanda_contratada && tarifas.tusd_d) {
        custos.custo_demanda = unidade.demanda_contratada * fatorPerdas * tarifas.tusd_d * fatorTributos;
      }
    } else {
      // Grupo B (tarifa unica)
      const tarifa_b = (tarifas.tusd_b || 0) + (tarifas.te_b || 0);

      const energia_normal =
        agregacao.energia_total_kwh - agregacao.energia_irrigante_kwh;
      custos.custo_fora_ponta = energia_normal * fatorPerdas * tarifa_b * fatorTributos;

      if (agregacao.energia_irrigante_kwh > 0) {
        const tusd = tarifas.tusd_b || 0;
        const te_original = tarifas.te_b || 0;
        const te_com_desconto = te_original * 0.20;
        const tarifa_irrigante = tusd + te_com_desconto;

        custos.custo_irrigante = agregacao.energia_irrigante_kwh * fatorPerdas * tarifa_irrigante * fatorTributos;

        const custo_sem_desconto = agregacao.energia_irrigante_kwh * fatorPerdas * tarifa_b * fatorTributos;
        custos.economia_irrigante = custo_sem_desconto - custos.custo_irrigante;
      }
    }

    // Total com tributos
    custos.custo_total =
      custos.custo_ponta +
      custos.custo_fora_ponta +
      custos.custo_reservado +
      custos.custo_irrigante +
      custos.custo_demanda;

    // Total sem tributos (para comparacao)
    custos.custo_total_sem_tributos = fatorTributos > 0
      ? custos.custo_total / fatorTributos
      : custos.custo_total;

    // Custo medio por kWh
    if (agregacao.energia_total_kwh > 0) {
      custos.custo_medio_kwh = custos.custo_total / agregacao.energia_total_kwh;
    }

    return custos;
  }
}
