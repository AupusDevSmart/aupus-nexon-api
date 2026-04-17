/**
 * ADAPTER PATTERN - Normalização de Dados de Equipamentos
 *
 * ✅ Objetivo: Criar uma camada de abstração que:
 * 1. Detecta automaticamente o formato dos dados MQTT
 * 2. Normaliza para uma interface padronizada
 * 3. Facilita manutenção quando o formato JSON mudar
 *
 * 📦 Suporta múltiplos formatos:
 * - Power Meter (M-160, CHINT, etc.) - JSON flat com Pt, Qt, St, Va, Vb, Vc, etc.
 * - Inversores (Sungrow, etc.) - JSON com power.active, voltage.phase_a, etc.
 * - Formato legado - JSON com estrutura Dados.{...}
 */

/**
 * Interface normalizada para dados elétricos
 * Todos os adapters convertem para este formato
 */
export interface NormalizedElectricalData {
  // Tensões (V)
  voltage: {
    L1: number;
    L2: number;
    L3: number;
    average: number;
  };

  // Correntes (A)
  current: {
    L1: number;
    L2: number;
    L3: number;
    average: number;
  };

  // Potências (kW)
  power: {
    active: number;      // Pt - Potência ativa total (kW)
    reactive: number;    // Qt - Potência reativa total (kvar)
    apparent: number;    // St - Potência aparente total (kVA)
    L1?: number;         // Pa - Potência fase A (kW)
    L2?: number;         // Pb - Potência fase B (kW)
    L3?: number;         // Pc - Potência fase C (kW)
  };

  // Fatores de potência
  powerFactor: {
    total: number;       // FP total calculado (Pt/St)
    L1: number;          // FPa
    L2: number;          // FPb
    L3: number;          // FPc
  };

  // Energia acumulada (kWh)
  energy: {
    activeImport: number;    // phf - Consumo ativo
    activeExport: number;    // phr - Geração ativa
    reactiveImport: number;  // qhfi - Reativo indutivo
    reactiveExport: number;  // qhfr - Reativo capacitivo
  };

  // Frequência (Hz)
  frequency: number;

  // Timestamp da leitura
  timestamp: string;
}

/**
 * Tipo dos dados brutos (formato variável)
 */
export type RawEquipmentData = Record<string, any>;

/**
 * Detecta o tipo de equipamento baseado na estrutura dos dados
 */
export function detectDataFormat(data: RawEquipmentData): 'power-meter' | 'inverter' | 'legacy' | 'unknown' {
  if (!data || typeof data !== 'object') {
    return 'unknown';
  }

  // Power Meter (M-160, CHINT): tem Pt, Qt, St diretamente na raiz
  if (data.Pt !== undefined && data.Qt !== undefined && data.St !== undefined) {
    return 'power-meter';
  }

  // Inversor: tem power.active_total OU power.active OU voltage.phase_a OU voltage.line_average
  if (
    data.power?.active_total !== undefined ||
    data.power?.active !== undefined ||
    data.voltage?.phase_a !== undefined ||
    data.voltage?.line_average !== undefined ||
    data.energy?.total_yield !== undefined
  ) {
    return 'inverter';
  }

  // Legado: tem dados dentro de Dados.{...}
  if (data.Dados && typeof data.Dados === 'object') {
    return 'legacy';
  }

  return 'unknown';
}

/**
 * ADAPTER para Power Meter (M-160, CHINT, etc.)
 * Formato: { Pt, Qt, St, Va, Vb, Vc, Ia, Ib, Ic, FPa, FPb, FPc, phf, ... }
 */
export class PowerMeterAdapter {
  static normalize(data: RawEquipmentData): NormalizedElectricalData {
    // Tensões
    const Va = data.Va || 0;
    const Vb = data.Vb || 0;
    const Vc = data.Vc || 0;

    // Correntes
    const Ia = data.Ia || 0;
    const Ib = data.Ib || 0;
    const Ic = data.Ic || 0;

    // Potências (já vêm em W, converter para kW)
    const Pt = (data.Pt || 0) / 1000;  // W → kW
    const Qt = (data.Qt || 0) / 1000;  // VAr → kvar
    const St = (data.St || 0) / 1000;  // VA → kVA
    const Pa = (data.Pa || 0) / 1000;
    const Pb = (data.Pb || 0) / 1000;
    const Pc = (data.Pc || 0) / 1000;

    // Fatores de potência
    const FPa = data.FPa || 0;
    const FPb = data.FPb || 0;
    const FPc = data.FPc || 0;
    const FP_total = St > 0 ? Pt / St : 1;

    // Energia (phf já vem em kWh)
    const phf = data.phf || data.consumo_phf || 0;
    const phr = data.phr || data.consumo_phr || 0;
    const qhfi = data.qhfi || data.consumo_qhf || 0;
    const qhfr = data.qhfr || data.consumo_qhr || 0;

    return {
      voltage: {
        L1: Va,
        L2: Vb,
        L3: Vc,
        average: (Va + Vb + Vc) / 3,
      },
      current: {
        L1: Ia,
        L2: Ib,
        L3: Ic,
        average: (Ia + Ib + Ic) / 3,
      },
      power: {
        active: Pt,
        reactive: Qt,
        apparent: St,
        L1: Pa,
        L2: Pb,
        L3: Pc,
      },
      powerFactor: {
        total: FP_total,
        L1: FPa,
        L2: FPb,
        L3: FPc,
      },
      energy: {
        activeImport: phf,
        activeExport: phr,
        reactiveImport: qhfi,
        reactiveExport: qhfr,
      },
      frequency: data.freq || 60.0,
      timestamp: data.timestamp || new Date().toISOString(),
    };
  }
}

/**
 * ADAPTER para Inversor (Sungrow, etc.)
 * Formato: { power: { active: ... }, voltage: { phase_a: ... }, ... }
 */
export class InverterAdapter {
  static normalize(data: RawEquipmentData): NormalizedElectricalData {
    const power = data.power || {};
    const voltage = data.voltage || {};
    const current = data.current || {};
    const energy = data.energy || {};

    // Converter W para kW
    const activePowerKw = (power.active_total || power.active || 0) / 1000;
    const reactivePowerKvar = (power.reactive_total || power.reactive || 0) / 1000;
    const apparentPowerKva = (power.apparent_total || power.apparent || 0) / 1000;

    // Tensões - suportar múltiplos formatos
    const vL1 = voltage.phase_a || voltage['phase_a-b'] || 0;
    const vL2 = voltage.phase_b || voltage['phase_b-c'] || 0;
    const vL3 = voltage.phase_c || voltage['phase_c-a'] || 0;
    const vAverage = voltage.line_average || voltage.average || ((vL1 + vL2 + vL3) / 3);

    return {
      voltage: {
        L1: vL1,
        L2: vL2,
        L3: vL3,
        average: vAverage,
      },
      current: {
        L1: current.phase_a || 0,
        L2: current.phase_b || 0,
        L3: current.phase_c || 0,
        average: ((current.phase_a || 0) + (current.phase_b || 0) + (current.phase_c || 0)) / 3,
      },
      power: {
        active: activePowerKw,
        reactive: reactivePowerKvar,
        apparent: apparentPowerKva,
      },
      powerFactor: {
        total: power.power_factor || 0,
        L1: 0,
        L2: 0,
        L3: 0,
      },
      energy: {
        activeImport: (energy.total_yield || energy.daily_yield || 0) / 1000,
        activeExport: 0,
        reactiveImport: 0,
        reactiveExport: 0,
      },
      frequency: power.frequency || 60.0,
      timestamp: data.timestamp || new Date().toISOString(),
    };
  }
}

/**
 * ADAPTER para formato legado
 * Formato: { Dados: { Pt, Qt, ... } }
 */
export class LegacyAdapter {
  static normalize(data: RawEquipmentData): NormalizedElectricalData {
    // Delegar para PowerMeterAdapter passando data.Dados
    return PowerMeterAdapter.normalize(data.Dados || {});
  }
}

/**
 * FUNÇÃO PRINCIPAL - Auto-detecta e normaliza
 *
 * ✅ USO:
 * ```typescript
 * const normalized = normalizeEquipmentData(rawMqttData);
 * console.log(normalized.power.active); // sempre em kW
 * console.log(normalized.voltage.L1);   // sempre em V
 * ```
 */
export function normalizeEquipmentData(data: RawEquipmentData): NormalizedElectricalData {
  const format = detectDataFormat(data);

  switch (format) {
    case 'power-meter':
      return PowerMeterAdapter.normalize(data);
    case 'inverter':
      return InverterAdapter.normalize(data);
    case 'legacy':
      return LegacyAdapter.normalize(data);
    default:
      // Fallback: retornar estrutura vazia
      return {
        voltage: { L1: 0, L2: 0, L3: 0, average: 0 },
        current: { L1: 0, L2: 0, L3: 0, average: 0 },
        power: { active: 0, reactive: 0, apparent: 0 },
        powerFactor: { total: 0, L1: 0, L2: 0, L3: 0 },
        energy: { activeImport: 0, activeExport: 0, reactiveImport: 0, reactiveExport: 0 },
        frequency: 0,
        timestamp: new Date().toISOString(),
      };
  }
}
