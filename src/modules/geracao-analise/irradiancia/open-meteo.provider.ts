import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { azimuteParaOpenMeteo } from '../geracao-calculo';
import { IrradianceProvider, LocalUsina, PontoIrradiancia } from './irradiance-provider';

/**
 * Open-Meteo (GER-8/9). Observado: Satellite Radiation API (`global_tilted_irradiance`, resolução
 * nativa — 15 min na América do Sul pelo MSG, ~2 h de atraso). Previsão: Forecast API
 * (`minutely_15`). Com OPEN_METEO_API_KEY usa os hosts `customer-*` do plano comercial.
 * Os valores do Open-Meteo são médias do intervalo ANTERIOR ao horário: o ponto "10:15" cobre
 * 10:00–10:15, por isso o início do intervalo é o horário − 15 min.
 */
@Injectable()
export class OpenMeteoProvider implements IrradianceProvider {
  readonly nome = 'open-meteo';
  private readonly logger = new Logger(OpenMeteoProvider.name);

  constructor(private readonly config: ConfigService) {}

  private get apiKey(): string | null {
    return this.config.get<string>('OPEN_METEO_API_KEY')?.trim() || null;
  }

  private host(sub: 'satellite-api' | 'api'): string {
    return this.apiKey ? `https://customer-${sub}.open-meteo.com` : `https://${sub}.open-meteo.com`;
  }

  private parametrosBase(local: LocalUsina): URLSearchParams {
    const p = new URLSearchParams({
      latitude: local.latitude.toFixed(5),
      longitude: local.longitude.toFixed(5),
      tilt: String(local.inclinacaoGraus),
      azimuth: String(azimuteParaOpenMeteo(local.azimuteGraus)),
      timezone: 'GMT',
    });
    if (this.apiKey) p.set('apikey', this.apiKey);
    return p;
  }

  async observada(local: LocalUsina, diaInicio: string, diaFim: string): Promise<PontoIrradiancia[]> {
    const p = this.parametrosBase(local);
    p.set('hourly', 'global_tilted_irradiance');
    p.set('temporal_resolution', 'native');
    p.set('models', 'satellite_radiation_seamless');
    // O dia local começa 03:00 UTC e termina 02:59 UTC do dia seguinte.
    p.set('start_date', diaInicio);
    // …mas o arquivo do satélite não aceita data final depois de hoje (UTC).
    const hojeUtc = new Date().toISOString().slice(0, 10);
    const fim = proximoDia(diaFim);
    p.set('end_date', fim > hojeUtc ? hojeUtc : fim);
    const json = await this.buscar(`${this.host('satellite-api')}/v1/archive?${p}`);
    return this.pontos(json?.hourly);
  }

  async prevista(local: LocalUsina, dias: number): Promise<PontoIrradiancia[]> {
    const p = this.parametrosBase(local);
    p.set('minutely_15', 'global_tilted_irradiance');
    p.set('forecast_days', String(Math.min(Math.max(dias, 1), 16)));
    const json = await this.buscar(`${this.host('api')}/v1/forecast?${p}`);
    return this.pontos(json?.minutely_15);
  }

  private pontos(bloco: any): PontoIrradiancia[] {
    const tempos: string[] = bloco?.time ?? [];
    const valores: Array<number | null> = bloco?.global_tilted_irradiance ?? [];
    const out: PontoIrradiancia[] = [];
    for (let i = 0; i < tempos.length; i++) {
      const v = valores[i];
      if (v == null || !Number.isFinite(v)) continue;
      const fim = Date.parse(`${tempos[i]}:00Z`);
      if (!Number.isFinite(fim)) continue;
      out.push({ inicio: new Date(fim - 15 * 60_000), gPoaWm2: Math.max(0, v) });
    }
    return out;
  }

  private async buscar(url: string): Promise<any> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      const json: any = await r.json().catch(() => null);
      if (!r.ok || json?.error) {
        throw new Error(`Open-Meteo ${r.status}: ${json?.reason ?? r.statusText}`);
      }
      return json;
    } catch (e: any) {
      this.logger.warn(`Falha no Open-Meteo: ${e?.message ?? e} (${url.replace(/apikey=[^&]+/, "apikey=***").slice(0, 300)})`);
      throw e;
    } finally {
      clearTimeout(t);
    }
  }
}

function proximoDia(dia: string): string {
  const [a, m, d] = dia.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d + 1)).toISOString().slice(0, 10);
}
