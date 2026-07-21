// Cliente HTTP para Deye Cloud OpenAPI v1.
//
// Fluxo (baseado no sample oficial DeyeCloudDevelopers/deye-openapi-client-sample-code):
//   1. POST /v1.0/account/token?appId=X  body={appSecret, email, password (SHA256 hex)}
//      -> retorna accessToken (Bearer), refreshToken, expiresIn (segundos)
//   2. Chamadas seguintes: Authorization: bearer <token>
//   3. POST /v1.0/station/list  {page, size} -> lista plantas
//   4. POST /v1.0/station/latest  {stationId} -> dado mais recente incluindo generationValue do dia
//   5. POST /v1.0/station/history  {stationId, granularity: 2 (day), startAt, endAt}
//      -> array de dias com energia gerada
//
// GOTCHA: senha vai como SHA256 hexadecimal minusculo (nao base64, nao HMAC).

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";

interface Session {
  token: string;
  expiresAt: number;
}

export interface DeyeStation {
  stationId: number;                 // Deye usa number, nao string
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  capacityKwp: number | null;        // total instalado (kWp)
  connectionStatus: string | null;
}

export interface DeyeDailyKpi {
  date: string;              // YYYY-MM-DD
  generationKwh: number;
}

@Injectable()
export class DeyeCloudService {
  private readonly logger = new Logger(DeyeCloudService.name);
  private readonly baseUrl: string;
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly user: string;
  private readonly password: string;
  // Opcional: se o usuario tem conta business (ex: LL ENGENHARIA), o token
  // pessoal retorna 0 plantas - precisa passar companyId pra listar as da empresa.
  private readonly companyId: number | undefined;
  private session: Session | null = null;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>("DEYE_BASE_URL") || "https://us1-developer.deyecloud.com";
    this.appId = config.get<string>("DEYE_APPID") || "";
    this.appSecret = config.get<string>("DEYE_APPSECRET") || "";
    this.user = config.get<string>("DEYE_USER") || "";
    this.password = config.get<string>("DEYE_PASSWORD") || "";
    const cid = config.get<string>("DEYE_COMPANY_ID");
    this.companyId = cid ? Number(cid) : undefined;
  }

  isEnabled(): boolean {
    return !!this.appId && !!this.appSecret && !!this.user && !!this.password;
  }

  private hashPassword(): string {
    return createHash("sha256").update(this.password, "utf-8").digest("hex");
  }

  private async ensureSession(): Promise<Session> {
    if (this.session && this.session.expiresAt > Date.now() + 60_000) {
      return this.session;
    }
    if (!this.isEnabled()) {
      throw new Error("Deye Cloud nao configurado (env vars ausentes)");
    }
    this.logger.log("Fazendo login no Deye Cloud...");
    const loginBody: Record<string, unknown> = {
      appSecret: this.appSecret,
      email: this.user,
      password: this.hashPassword(),
    };
    if (this.companyId) loginBody.companyId = this.companyId;
    const res = await fetch(
      `${this.baseUrl}/v1.0/account/token?appId=${encodeURIComponent(this.appId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(loginBody),
      },
    );
    if (!res.ok) throw new Error(`Deye Cloud login HTTP ${res.status}`);
    const body = await res.json();
    if (body.success === false || !body.accessToken) {
      throw new Error(`Deye Cloud login: ${body.msg || body.code || "resposta invalida"}`);
    }
    const expiresIn = Number(body.expiresIn) || 3600;
    this.session = {
      token: body.accessToken,
      // Usa 90% do TTL pra evitar corrida na expiracao.
      expiresAt: Date.now() + expiresIn * 900,
    };
    return this.session;
  }

  private async post(path: string, body: Record<string, unknown>): Promise<any> {
    const s = await this.ensureSession();
    const res = await fetch(`${this.baseUrl}/v1.0${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `bearer ${s.token}`,
      },
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      // Token invalidou - forca relogin
      this.session = null;
      const s2 = await this.ensureSession();
      const res2 = await fetch(`${this.baseUrl}/v1.0${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `bearer ${s2.token}`,
        },
        body: JSON.stringify(body),
      });
      if (!res2.ok) throw new Error(`Deye Cloud ${path}: HTTP ${res2.status}`);
      return res2.json();
    }
    if (!res.ok) throw new Error(`Deye Cloud ${path}: HTTP ${res.status}`);
    const payload = await res.json();
    if (payload.success === false) {
      throw new Error(`Deye Cloud ${path}: ${payload.msg || payload.code}`);
    }
    return payload;
  }

  async listStations(): Promise<DeyeStation[]> {
    const body = await this.post("/station/list", { page: 1, size: 100 });
    const list = body.stationList ?? body.data?.stationList ?? [];
    return list.map((p: any) => ({
      stationId: Number(p.id ?? p.stationId),
      name: p.name ?? "",
      address: p.locationAddress ?? p.address ?? null,
      latitude: p.locationLat ?? p.latitude ?? null,
      longitude: p.locationLng ?? p.longitude ?? null,
      capacityKwp: Number(p.installedCapacity ?? p.capacity ?? 0) || null,
      connectionStatus: p.connectionStatus ?? null,
    }));
  }

  // Retorna geracao diaria entre startAt (inclusivo) e endAt (EXCLUSIVO).
  // Deye limita a 31 dias por chamada. Response: stationDataItems[] com
  // {year, month, day, generationValue}.
  async getKpiDayRange(stationId: number, startAt: string, endAt: string): Promise<DeyeDailyKpi[]> {
    const body = await this.post("/station/history", {
      stationId,
      granularity: 2, // day
      startAt,
      endAt,
    });
    const list = body.stationDataItems ?? body.data?.stationDataItems ?? [];
    return list
      .map((d: any) => {
        const y = Number(d.year);
        const m = Number(d.month);
        const day = Number(d.day);
        if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(day)) return null;
        const iso = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        const gen = Number(d.generationValue ?? 0);
        if (!Number.isFinite(gen)) return null;
        return { date: iso, generationKwh: gen };
      })
      .filter((x: DeyeDailyKpi | null): x is DeyeDailyKpi => x !== null);
  }

  // Retorna geracao acumulada de UM dia especifico (para sync 21h).
  // Como Deye nao tem endpoint /latest de today_energy, chamamos /history
  // com range de 1 dia.
  async getDayEnergy(stationId: number, date: string): Promise<number | null> {
    // endAt eh EXCLUSIVO na Deye - passamos dia+1
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    const endAt = d.toISOString().slice(0, 10);
    const days = await this.getKpiDayRange(stationId, date, endAt);
    const alvo = days.find((x) => x.date === date);
    return alvo ? alvo.generationKwh : null;
  }
}
