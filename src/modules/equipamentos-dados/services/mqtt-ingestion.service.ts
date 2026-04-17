import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@aupus/api-shared';
import { ClassificacaoHorariosService } from './classificacao-horarios.service';
import { Prisma } from '@prisma/client';

/**
 * Service responsável por processar e salvar dados MQTT
 * com cálculo de PHF delta e classificação de horários
 *
 * Funcionalidades:
 * - Calcula energia consumida (phf_atual - phf_anterior)
 * - Extrai potência ativa para cálculo de demanda
 * - Classifica horário tarifário
 * - Trata duplicatas (múltiplos backends)
 * - Valida qualidade dos dados
 */
@Injectable()
export class MqttIngestionService {
  private readonly logger = new Logger(MqttIngestionService.name);

  // ✅ Cache em memória para evitar queries N+1
  private equipamentosCache = new Map<string, {
    data: any;
    timestamp: number;
  }>();
  private readonly CACHE_TTL = 60000; // 60 segundos

  constructor(
    private readonly prisma: PrismaService,
    private readonly classificacaoService: ClassificacaoHorariosService,
  ) {}

  /**
   * Processa e salva leitura MQTT com cálculo de PHF e classificação
   *
   * @param equipamentoId ID do equipamento
   * @param mqttPayload Payload completo do MQTT
   * @param timestamp Timestamp da leitura (do MQTT, não do servidor!)
   */
  async processarLeituraMQTT(
    equipamentoId: string,
    mqttPayload: any,
    timestamp: Date,
  ): Promise<void> {
    try {
      // 1. Extrair PHF atual do payload
      const phfAtual = this.extrairPHF(mqttPayload);

      if (phfAtual === null) {
        this.logger.warn(
          `PHF não encontrado no payload MQTT para equipamento ${equipamentoId}`,
        );
        return;
      }

      // 2. Buscar último PHF deste equipamento
      const ultimaLeitura = await this.buscarUltimaLeitura(equipamentoId);

      // 3. Calcular energia e determinar qualidade
      const { energiaKwh, qualidade, phfAnterior } = this.calcularEnergia(
        phfAtual,
        ultimaLeitura,
        equipamentoId,
      );

      // 4. Extrair potência ativa (para demanda)
      const potenciaAtivaKw = this.extrairPotenciaAtiva(mqttPayload);

      // 5. Classificar horário tarifário
      const tipoHorario = await this.classificarHorario(
        timestamp,
        equipamentoId,
      );

      // 6. Salvar no banco de dados
      await this.salvarLeitura({
        equipamentoId,
        timestamp,
        dados: mqttPayload,
        phfAtual,
        phfAnterior,
        energiaKwh,
        potenciaAtivaKw,
        qualidade,
        tipoHorario,
      });
    } catch (error) {
      // Não propagar erro se for duplicata (P2002)
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') {
          this.logger.debug(
            `Leitura duplicada ignorada: ${equipamentoId} @ ${timestamp.toISOString()}`,
          );
          return;
        }
      }

      // Outros erros devem subir
      this.logger.error(
        `Erro ao processar leitura MQTT: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Extrai PHF (Period Hour Forward) do payload MQTT
   * Suporta múltiplos formatos:
   * - M-160: Dados.phf (em kWh)
   * - Inversores: energy.total_yield (em kWh acumulado)
   */
  private extrairPHF(payload: any): number | null {
    // Formato 1: M-160 (Dados.phf)
    const phfM160 = payload?.Dados?.phf;
    if (typeof phfM160 === 'number' && phfM160 >= 0) {
      return phfM160;
    }

    // Formato 2: Inversores (energy.total_yield)
    const totalYield = payload?.energy?.total_yield;
    if (typeof totalYield === 'number' && totalYield >= 0) {
      return totalYield;
    }

    return null;
  }

  /**
   * Extrai potência ativa total do payload MQTT
   * Suporta múltiplos formatos:
   * - M-160: Dados.Pa + Dados.Pb + Dados.Pc (em W)
   * - Inversores: power.active_total (em W)
   */
  private extrairPotenciaAtiva(payload: any): number | null {
    // Formato 1: Inversores (power.active_total)
    if (payload?.power?.active_total !== undefined) {
      const potenciaW = Number(payload.power.active_total);
      if (!isNaN(potenciaW) && potenciaW >= 0) {
        // Converter de W para kW
        return potenciaW / 1000;
      }
    }

    // Formato 2: M-160 (Dados.Pa + Dados.Pb + Dados.Pc)
    const dados = payload?.Dados;
    if (dados) {
      const Pa = typeof dados.Pa === 'number' ? dados.Pa : 0;
      const Pb = typeof dados.Pb === 'number' ? dados.Pb : 0;
      const Pc = typeof dados.Pc === 'number' ? dados.Pc : 0;

      const potenciaTotal = Pa + Pb + Pc;

      if (potenciaTotal > 0) {
        // Converter de W para kW
        return potenciaTotal / 1000;
      }
    }

    return null;
  }

  /**
   * Busca última leitura válida do equipamento
   */
  private async buscarUltimaLeitura(equipamentoId: string) {
    return await this.prisma.equipamentos_dados.findFirst({
      where: {
        equipamento_id: equipamentoId,
        phf_atual: { not: null },
      },
      orderBy: { timestamp_dados: 'desc' },
      select: {
        phf_atual: true,
        timestamp_dados: true,
      },
    });
  }

  /**
   * Calcula energia consumida e determina qualidade
   */
  private calcularEnergia(
    phfAtual: number,
    ultimaLeitura: any,
    equipamentoId: string,
  ): {
    energiaKwh: number | null;
    qualidade: string;
    phfAnterior: number | null;
  } {
    // CASO 1: Primeira leitura - não há PHF anterior
    if (!ultimaLeitura) {
      this.logger.log(
        `Primeira leitura de ${equipamentoId}, PHF inicial = ${phfAtual} kWh`,
      );

      return {
        energiaKwh: null,
        qualidade: 'PRIMEIRA_LEITURA',
        phfAnterior: null,
      };
    }

    const phfAnterior = Number(ultimaLeitura.phf_atual);
    const deltaPhf = phfAtual - phfAnterior;

    // CASO 2: PHF resetou (valor atual < anterior)
    if (deltaPhf < 0) {
      this.logger.warn(
        `PHF reset detectado em ${equipamentoId}: ${phfAnterior} → ${phfAtual}`,
      );

      return {
        energiaKwh: phfAtual, // Assumir que resetou, usar valor atual
        qualidade: 'PHF_RESET',
        phfAnterior,
      };
    }

    // CASO 3: Consumo suspeito (muito alto)
    const THRESHOLD_SUSPEITO = 1000; // 1000 kWh entre leituras
    if (deltaPhf > THRESHOLD_SUSPEITO) {
      this.logger.warn(
        `Consumo anormalmente alto detectado: ${deltaPhf.toFixed(3)} kWh em ${equipamentoId}`,
      );

      return {
        energiaKwh: deltaPhf,
        qualidade: 'SUSPEITO',
        phfAnterior,
      };
    }

    // CASO 4: Leitura normal
    return {
      energiaKwh: deltaPhf,
      qualidade: 'OK',
      phfAnterior,
    };
  }

  /**
   * Busca equipamento com cache para evitar queries N+1
   */
  private async buscarEquipamentoComCache(equipamentoId: string, select: any) {
    const cacheKey = `${equipamentoId}_${JSON.stringify(select)}`;
    const cached = this.equipamentosCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data;
    }

    const equipamento = await this.prisma.equipamentos.findUnique({
      where: { id: equipamentoId },
      select,
    });

    this.equipamentosCache.set(cacheKey, {
      data: equipamento,
      timestamp: Date.now(),
    });

    return equipamento;
  }

  /**
   * Classifica horário tarifário do timestamp
   */
  private async classificarHorario(
    timestamp: Date,
    equipamentoId: string,
  ): Promise<string | null> {
    try {
      // Buscar dados da unidade para classificação (com cache)
      const equipamento = await this.buscarEquipamentoComCache(equipamentoId, {
        unidade_id: true,
        unidade: {
          select: {
            grupo: true,
            irrigante: true,
          },
        },
      });

      if (!equipamento?.unidade) {
        return null;
      }

      const hora = timestamp.getHours();
      const minuto = timestamp.getMinutes();
      const horaDecimal = hora + minuto / 60;
      const diaSemana = timestamp.getDay();

      // Usar lógica simplificada de classificação inline
      // (evita dependência circular e é mais performático)

      // PRIORIDADE 1: Feriado/Fim de semana + Irrigante = HR
      const isFimDeSemana = diaSemana === 0 || diaSemana === 6;
      if (equipamento.unidade.irrigante && isFimDeSemana) {
        return 'HORARIO_RESERVADO';
      }

      // PRIORIDADE 2: Horário Reservado (21:30-06:00)
      if (horaDecimal >= 21.5 || horaDecimal < 6) {
        return 'HORARIO_RESERVADO';
      }

      // PRIORIDADE 3: Ponta (18:00-21:00)
      if (hora >= 18 && hora < 21) {
        return 'PONTA';
      }

      // PRIORIDADE 4: Fora Ponta
      return 'FORA_PONTA';
    } catch (error) {
      this.logger.error(
        `Erro ao classificar horário: ${error.message}`,
        error.stack,
      );
      return null;
    }
  }

  /**
   * Salva leitura no banco de dados
   * Trata duplicatas silenciosamente (P2002)
   */
  private async salvarLeitura(data: {
    equipamentoId: string;
    timestamp: Date;
    dados: any;
    phfAtual: number;
    phfAnterior: number | null;
    energiaKwh: number | null;
    potenciaAtivaKw: number | null;
    qualidade: string;
    tipoHorario: string | null;
  }) {
    await this.prisma.equipamentos_dados.create({
      data: {
        equipamento_id: data.equipamentoId,
        timestamp_dados: data.timestamp,
        dados: data.dados,
        phf_atual: data.phfAtual,
        phf_anterior: data.phfAnterior,
        energia_kwh: data.energiaKwh,
        potencia_ativa_kw: data.potenciaAtivaKw,
        qualidade: data.qualidade,
        tipo_horario: data.tipoHorario,
        fonte: 'MQTT',
      },
    });

    // Log detalhado se for leitura OK com energia calculada
    if (data.qualidade === 'OK' && data.energiaKwh !== null) {
      // Buscar tarifas e calcular custo
      const detalhes = await this.calcularDetalhesDebug(
        data.equipamentoId,
        data.energiaKwh,
        data.tipoHorario,
      );

      this.logger.debug(
        `✅ ${data.equipamentoId}: ${data.energiaKwh.toFixed(3)} kWh [${data.tipoHorario}] | ${detalhes}`,
      );
    }
  }

  /**
   * Calcula detalhes de tarifa e custo para debug
   */
  private async calcularDetalhesDebug(
    equipamentoId: string,
    energiaKwh: number,
    tipoHorario: string | null,
  ): Promise<string> {
    try {
      // Buscar unidade e concessionária (com cache)
      const equipamento = await this.buscarEquipamentoComCache(equipamentoId, {
        unidade: {
          include: {
            concessionaria: true,
          },
        },
      });

      if (!equipamento?.unidade?.concessionaria) {
        return 'Tarifas: N/A';
      }

      const unidade = equipamento.unidade;
      const conc = unidade.concessionaria;
      const grupo = unidade.grupo || 'B';
      const subgrupo = (unidade.subgrupo || '').toLowerCase().replace(/[^a-z0-9]/g, '');

      let tarifaTUSD = 0;
      let tarifaTE = 0;
      let tarifaTotal = 0;
      let custoTotal = 0;

      // Determinar tarifas com base no grupo, subgrupo e tipo horário
      if (grupo === 'A') {
        const prefixo = subgrupo.includes('a3a') ? 'a3a' : 'a4';

        if (tipoHorario === 'PONTA') {
          tarifaTUSD = this.parseDecimal(conc[`${prefixo}_verde_tusd_p`]);
          tarifaTE = this.parseDecimal(conc[`${prefixo}_verde_te_p`]);
        } else {
          // FORA_PONTA, HORARIO_RESERVADO, IRRIGANTE (na Verde HR = FP)
          tarifaTUSD = this.parseDecimal(conc[`${prefixo}_verde_tusd_fp`]);
          tarifaTE = this.parseDecimal(conc[`${prefixo}_verde_te_fp`]);

          // Se irrigante, aplicar 80% desconto na TE
          if (tipoHorario === 'IRRIGANTE' ||
              (unidade.irrigante && tipoHorario === 'HORARIO_RESERVADO')) {
            tarifaTE = tarifaTE * 0.20; // 80% desconto
          }
        }
      } else {
        // Grupo B
        tarifaTUSD = this.parseDecimal(conc.b_tusd_valor);
        tarifaTE = this.parseDecimal(conc.b_te_valor);

        // Se irrigante, aplicar 80% desconto na TE
        if (tipoHorario === 'IRRIGANTE' ||
            (unidade.irrigante && tipoHorario === 'HORARIO_RESERVADO')) {
          tarifaTE = tarifaTE * 0.20;
        }
      }

      tarifaTotal = tarifaTUSD + tarifaTE;
      custoTotal = energiaKwh * tarifaTotal;

      return `TUSD=${tarifaTUSD.toFixed(8)} TE=${tarifaTE.toFixed(8)} Total=${tarifaTotal.toFixed(8)} R$/kWh | Custo=R$ ${custoTotal.toFixed(8)}`;
    } catch (error) {
      return `Erro ao calcular tarifas: ${error.message}`;
    }
  }

  private parseDecimal(value: any): number {
    if (value === null || value === undefined) return 0;
    return parseFloat(value.toString());
  }
}
