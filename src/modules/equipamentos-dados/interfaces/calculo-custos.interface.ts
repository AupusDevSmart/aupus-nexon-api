/**
 * Interfaces para o sistema de cálculo de custos de energia
 *
 * Estruturado de forma modular para facilitar ajustes futuros
 */

export enum TipoHorario {
  PONTA = 'PONTA',
  FORA_PONTA = 'FORA_PONTA',
  RESERVADO = 'RESERVADO',
  IRRIGANTE = 'IRRIGANTE',
}

export interface ClassificacaoHorario {
  tipo: TipoHorario;
  tarifa_tusd: number;
  tarifa_te: number;
  tarifa_total: number;
  desconto_irrigante: boolean;
}

export interface TarifasConcessionaria {
  // Grupo A
  tusd_p?: number;
  te_p?: number;
  tusd_fp?: number;
  te_fp?: number;
  tusd_d?: number;
  te_d?: number;

  // Grupo B
  tusd_b?: number;
  te_b?: number;
}

export interface DadosUnidade {
  id: string;
  nome: string;
  grupo: string; // 'A' ou 'B'
  subgrupo: string; // 'A3a', 'A4', 'B1', etc.
  irrigante: boolean;
  demanda_contratada?: number;
  concessionaria_id: string;
}

export interface LeituraMQTT {
  timestamp: Date;
  energia_kwh: number;
  potencia_kw: number;
  _forcaForaPonta?: boolean; // Leitura virtual de compensação de gap - sempre Fora Ponta
}

export interface AgregacaoEnergia {
  energia_ponta_kwh: number;
  energia_fora_ponta_kwh: number;
  energia_reservado_kwh: number;
  energia_irrigante_kwh: number;
  energia_total_kwh: number;
  demanda_maxima_kw: number;
  num_leituras: number;
}

export interface TributosConfig {
  icms: number;
  pis: number;
  cofins: number;
  perdas: number;
}

export interface CalculoCustos {
  custo_ponta: number;
  custo_fora_ponta: number;
  custo_reservado: number;
  custo_irrigante: number;
  custo_demanda: number;
  custo_total: number;
  custo_medio_kwh: number;
  economia_irrigante?: number;
  // Tributos
  custo_total_sem_tributos: number;
  fator_tributos: number;
  fator_perdas: number;
}

export interface ConfiguracaoHorarios {
  // Horário de Ponta
  hora_inicio_ponta: number; // 17
  hora_fim_ponta: number; // 20

  // Horário Irrigante
  hora_inicio_irrigante_decimal: number; // 21.5 (21:30)
  hora_fim_irrigante: number; // 6

  // Desconto irrigante
  percentual_desconto_irrigante: number; // 0.80 (80%)
}
