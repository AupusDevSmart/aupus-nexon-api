import { Injectable } from '@nestjs/common';
import {
  TipoHorario,
  ClassificacaoHorario,
  TarifasConcessionaria,
  DadosUnidade,
  ConfiguracaoHorarios,
} from '../interfaces/calculo-custos.interface';
import { FeriadosNacionaisService } from './feriados-nacionais.service';
import { toZonedTime } from 'date-fns-tz';

/**
 * Serviço responsável por classificar horários em tipos tarifários
 *
 * ✅ NOVOS HORÁRIOS (GDD v2.0):
 * - Fora Ponta: 06:00-18:00 + 21:00-21:30
 * - Ponta: 18:00-21:00 (todos os dias)
 * - Horário Reservado: 21:30-06:00 (todos os dias)
 *
 * Prioridade de classificação:
 * 1. FERIADO/FIM DE SEMANA + IRRIGANTE → HR 24h (desconto 80% na TE)
 * 2. HORÁRIO RESERVADO (21:30-06:00) → HR
 * 3. PONTA (18:00-21:00) → P
 * 4. FORA PONTA (06:00-18:00 + 21:00-21:30) → FP
 */
@Injectable()
export class ClassificacaoHorariosService {
  private readonly config: ConfiguracaoHorarios = {
    hora_inicio_ponta: 18, // ✅ MUDOU de 17 para 18
    hora_fim_ponta: 21,    // ✅ MUDOU de 20 para 21
    hora_inicio_irrigante_decimal: 21.5, // 21:30
    hora_fim_irrigante: 6,
    percentual_desconto_irrigante: 0.80, // 80% desconto na TE
  };

  constructor(private readonly feriadosService: FeriadosNacionaisService) {}

  /**
   * Classifica um timestamp específico e retorna o tipo de horário e tarifas aplicáveis
   * ✅ CORRIGIDO: Usa timezone America/Sao_Paulo com date-fns-tz (conversão correta)
   */
  classificar(
    timestamp: Date,
    unidade: DadosUnidade,
    tarifas: TarifasConcessionaria,
  ): ClassificacaoHorario {
    // O banco armazena timestamps em BRT sem timezone (Prisma lê como UTC)
    // Usar os componentes UTC diretamente pois já representam horário de Brasília
    const hora = timestamp.getUTCHours();
    const minutos = timestamp.getUTCMinutes();
    const horaDecimal = hora + minutos / 60;
    const diaSemana = timestamp.getUTCDay(); // 0 = domingo, 6 = sábado

    // ✅ PRIORIDADE 1: Feriado/Fim de semana + Irrigante = HR 24h
    const isFeriado = this.feriadosService.isFeriadoNacional(timestamp);
    const isFimDeSemana = diaSemana === 0 || diaSemana === 6;

    if (unidade.irrigante && (isFeriado || isFimDeSemana)) {
      // Todo o dia é Horário Reservado com desconto irrigante
      return this.criarClassificacaoIrrigante(unidade, tarifas);
    }

    // ✅ PRIORIDADE 2: Horário Reservado noturno (21:30-06:00)
    const isHorarioReservado = this.isHorarioReservado(horaDecimal);
    if (isHorarioReservado) {
      if (unidade.irrigante) {
        // HR com desconto irrigante
        return this.criarClassificacaoIrrigante(unidade, tarifas);
      } else {
        // HR sem desconto
        return this.criarClassificacaoReservado(unidade, tarifas);
      }
    }

    // ✅ PRIORIDADE 3: Ponta (18:00-21:00) - TODOS OS DIAS
    if (hora >= this.config.hora_inicio_ponta && hora < this.config.hora_fim_ponta) {
      return this.criarClassificacaoPonta(unidade, tarifas);
    }

    // ✅ PRIORIDADE 4: Fora Ponta (06:00-18:00 + 21:00-21:30)
    return this.criarClassificacaoForaPonta(unidade, tarifas);
  }

  /**
   * Verifica se hora está no Horário Reservado (21:30 - 06:00)
   */
  private isHorarioReservado(horaDecimal: number): boolean {
    // Período atravessa meia-noite: 21:30 até 06:00
    return (
      horaDecimal >= this.config.hora_inicio_irrigante_decimal || // >= 21:30
      horaDecimal < this.config.hora_fim_irrigante // < 06:00
    );
  }

  /**
   * Cria classificação para horário PONTA
   */
  private criarClassificacaoPonta(
    unidade: DadosUnidade,
    tarifas: TarifasConcessionaria,
  ): ClassificacaoHorario {
    if (unidade.grupo === 'A') {
      const tusd = tarifas.tusd_p || 0;
      const te = tarifas.te_p || 0;

      return {
        tipo: TipoHorario.PONTA,
        tarifa_tusd: tusd,
        tarifa_te: te,
        tarifa_total: tusd + te,
        desconto_irrigante: false,
      };
    }

    // Grupo B não tem diferenciação de horário de ponta
    return this.criarClassificacaoGrupoB(tarifas);
  }

  /**
   * Cria classificação para horário IRRIGANTE
   * Desconto de 80% aplicado SOMENTE na TE
   */
  private criarClassificacaoIrrigante(
    unidade: DadosUnidade,
    tarifas: TarifasConcessionaria,
  ): ClassificacaoHorario {
    if (unidade.grupo === 'A') {
      // Usar tarifas de Fora de Ponta como base
      const tusd = tarifas.tusd_fp || 0;
      const te_original = tarifas.te_fp || 0;

      // Aplicar desconto de 80% SOMENTE na TE
      const te_com_desconto = te_original * (1 - this.config.percentual_desconto_irrigante);

      return {
        tipo: TipoHorario.IRRIGANTE,
        tarifa_tusd: tusd,
        tarifa_te: te_com_desconto,
        tarifa_total: tusd + te_com_desconto,
        desconto_irrigante: true,
      };
    }

    // Grupo B com desconto irrigante
    const tusd = tarifas.tusd_b || 0;
    const te_original = tarifas.te_b || 0;
    const te_com_desconto = te_original * (1 - this.config.percentual_desconto_irrigante);

    return {
      tipo: TipoHorario.IRRIGANTE,
      tarifa_tusd: tusd,
      tarifa_te: te_com_desconto,
      tarifa_total: tusd + te_com_desconto,
      desconto_irrigante: true,
    };
  }

  /**
   * ✅ NOVO: Cria classificação para horário RESERVADO (sem desconto)
   */
  private criarClassificacaoReservado(
    unidade: DadosUnidade,
    tarifas: TarifasConcessionaria,
  ): ClassificacaoHorario {
    if (unidade.grupo === 'A') {
      const tusd = tarifas.tusd_fp || 0;
      const te = tarifas.te_fp || 0;

      return {
        tipo: TipoHorario.RESERVADO,
        tarifa_tusd: tusd,
        tarifa_te: te,
        tarifa_total: tusd + te,
        desconto_irrigante: false,
      };
    }

    // Grupo B não tem diferenciação de horário
    return this.criarClassificacaoGrupoB(tarifas);
  }

  /**
   * ✅ NOVO: Cria classificação para horário FORA_PONTA
   */
  private criarClassificacaoForaPonta(
    unidade: DadosUnidade,
    tarifas: TarifasConcessionaria,
  ): ClassificacaoHorario {
    if (unidade.grupo === 'A') {
      const tusd = tarifas.tusd_fp || 0;
      const te = tarifas.te_fp || 0;

      return {
        tipo: TipoHorario.FORA_PONTA,
        tarifa_tusd: tusd,
        tarifa_te: te,
        tarifa_total: tusd + te,
        desconto_irrigante: false,
      };
    }

    // Grupo B não tem diferenciação de horário
    return this.criarClassificacaoGrupoB(tarifas);
  }

  /**
   * Cria classificação para Grupo B (tarifa única)
   */
  private criarClassificacaoGrupoB(
    tarifas: TarifasConcessionaria,
  ): ClassificacaoHorario {
    const tusd = tarifas.tusd_b || 0;
    const te = tarifas.te_b || 0;

    return {
      tipo: TipoHorario.FORA_PONTA, // Grupo B usa FP como referência
      tarifa_tusd: tusd,
      tarifa_te: te,
      tarifa_total: tusd + te,
      desconto_irrigante: false,
    };
  }

  /**
   * Retorna a configuração de horários atual (útil para testes e documentação)
   */
  getConfiguracao(): ConfiguracaoHorarios {
    return { ...this.config };
  }
}
