/**
 * Provedor de irradiância (GER-8). Trocar Open-Meteo por Solcast = nova implementação desta
 * interface + trocar o `useClass` do token em geracao-analise.module.ts. Nada mais muda.
 */

export const IRRADIANCE_PROVIDER = Symbol('IRRADIANCE_PROVIDER');

export interface LocalUsina {
  latitude: number;
  longitude: number;
  /** Inclinação dos módulos (°, 0 = horizontal). */
  inclinacaoGraus: number;
  /** Azimute dos módulos (°, 0 = norte, sentido horário — convenção da spec). */
  azimuteGraus: number;
}

export interface PontoIrradiancia {
  /** INÍCIO do intervalo de 15 min, UTC. */
  inicio: Date;
  /** Irradiância média no plano dos módulos no intervalo (W/m²). */
  gPoaWm2: number;
}

export interface IrradianceProvider {
  /** Nome curto gravado em irradiancia_15min.provedor. */
  readonly nome: string;
  /** Irradiância observada (satélite) entre dois dias locais, inclusive. */
  observada(local: LocalUsina, diaInicio: string, diaFim: string): Promise<PontoIrradiancia[]>;
  /** Irradiância prevista (API de clima) para os próximos `dias` dias (inclui hoje). */
  prevista(local: LocalUsina, dias: number): Promise<PontoIrradiancia[]>;
}
