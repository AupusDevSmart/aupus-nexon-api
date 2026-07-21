// Cliente HTTP para Fusion Solar (Huawei) OpenAPI Northbound.
//
// Fluxo:
//   1. POST /thirdData/login  -> retorna cookies XSRF-TOKEN + HWWAFSESID (validade ~20min).
//   2. POST /thirdData/stations         -> lista de plantas
//   3. POST /thirdData/getKpiStationDay -> geracao diaria (retorna mes inteiro)
//
// A sessao eh cacheada em memoria; renova automaticamente se der 401/expirar.

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

interface Session {
  cookies: string;   // cookie header ja formatado
  xsrf: string;
  expiresAt: number; // epoch ms
}

export interface FusionStation {
  plantCode: string;      // ex: "NE=33904862"
  plantName: string;      // ex: "UFV Fazenda Sol II"
  plantAddress: string | null;
  capacity: number;       // kWp
  gridConnectionDate: string | null;
  latitude: string | null;
  longitude: string | null;
}

export interface FusionDailyKpi {
  date: string;             // YYYY-MM-DD
  inverterPowerKwh: number; // geracao diaria em kWh (dataItemMap.inverter_power)
}

@Injectable()
export class FusionSolarService {
  private readonly logger = new Logger(FusionSolarService.name);
  private readonly baseUrl: string;
  private readonly user: string;
  private readonly password: string;
  private session: Session | null = null;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>("FUSION_SOLAR_BASE_URL") || "https://la5.fusionsolar.huawei.com";
    this.user = config.get<string>("FUSION_SOLAR_USER") || "";
    this.password = config.get<string>("FUSION_SOLAR_PASSWORD") || "";
  }

  private isEnabled(): boolean {
    return !!this.user && !!this.password;
  }

  private async ensureSession(): Promise<Session> {
    if (this.session && this.session.expiresAt > Date.now() + 30_000) {
      return this.session;
    }
    if (!this.isEnabled()) {
      throw new Error("FusionSolar nao configurado (FUSION_SOLAR_USER/PASSWORD ausentes)");
    }
    this.logger.log("Fazendo login no Fusion Solar...");
    const res = await fetch(`${this.baseUrl}/thirdData/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userName: this.user, systemCode: this.password }),
    });
    if (!res.ok) {
      throw new Error(`Fusion Solar login HTTP ${res.status}`);
    }
    const body = await res.json();
    if (!body.success) {
      throw new Error(`Fusion Solar login: ${body.message || body.failCode}`);
    }
    // Cookies vem em Set-Cookie multiplos - node fetch usa getSetCookie().
    const rawCookies = (res.headers as any).getSetCookie?.() ?? [];
    const xsrf = res.headers.get("xsrf-token") || "";
    // Constroi cookie header consolidado
    const cookieMap = new Map<string, string>();
    for (const raw of rawCookies) {
      const [pair] = raw.split(";");
      const [k, v] = pair.split("=");
      if (k && v !== undefined) cookieMap.set(k.trim(), v.trim());
    }
    const cookies = Array.from(cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
    this.session = {
      cookies,
      xsrf,
      // Sessao dura ~20min segundo Max-Age dos cookies HW; usamos 18min de margem.
      expiresAt: Date.now() + 18 * 60 * 1000,
    };
    return this.session;
  }

  private async post<T = any>(path: string, body: unknown): Promise<T> {
    const s = await this.ensureSession();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "XSRF-TOKEN": s.xsrf,
        Cookie: s.cookies,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Fusion Solar ${path}: HTTP ${res.status}`);
    const payload = await res.json();
    if (payload.failCode === 305 || payload.failCode === 401) {
      // Sessao expirou - reseta e tenta 1x novamente.
      this.session = null;
      const s2 = await this.ensureSession();
      const res2 = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "XSRF-TOKEN": s2.xsrf,
          Cookie: s2.cookies,
        },
        body: JSON.stringify(body),
      });
      const p2 = await res2.json();
      if (!p2.success) throw new Error(`Fusion Solar ${path}: ${p2.message || p2.failCode}`);
      return p2 as T;
    }
    if (!payload.success) throw new Error(`Fusion Solar ${path}: ${payload.message || payload.failCode}`);
    return payload as T;
  }

  async listStations(): Promise<FusionStation[]> {
    const body = await this.post<any>("/thirdData/stations", { pageNo: 1, pageSize: 100 });
    return (body.data?.list ?? []).map((p: any) => ({
      plantCode: p.plantCode,
      plantName: p.plantName,
      plantAddress: p.plantAddress ?? null,
      capacity: Number(p.capacity ?? 0),
      gridConnectionDate: p.gridConnectionDate ?? null,
      latitude: p.latitude ?? null,
      longitude: p.longitude ?? null,
    }));
  }

  // Retorna geracao diaria do mes que contem `date` (ate ~30 dias).
  // Cada elemento retornado tem o kWh do dia. `date` no formato YYYY-MM-DD.
  async getKpiDay(plantCode: string, date: string): Promise<FusionDailyKpi[]> {
    // collectTime: timestamp ms de qualquer dia do mes desejado
    const collectTime = new Date(`${date}T12:00:00Z`).getTime();
    const body = await this.post<any>("/thirdData/getKpiStationDay", {
      stationCodes: plantCode,
      collectTime,
    });
    const list = body.data ?? [];
    return list
      .map((d: any) => {
        const ts = Number(d.collectTime);
        if (!Number.isFinite(ts)) return null;
        const iso = new Date(ts).toISOString().slice(0, 10);
        const kwh = Number(d.dataItemMap?.inverter_power ?? 0);
        return { date: iso, inverterPowerKwh: kwh };
      })
      .filter((x: FusionDailyKpi | null): x is FusionDailyKpi => x !== null);
  }
}
