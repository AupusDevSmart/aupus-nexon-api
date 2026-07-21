// Cliente HTTP para iSolarCloud (Sungrow) OpenAPI.
//
// Gotchas descobertos em campo:
//   1. Gateway internacional funciona pra contas do Brasil:
//      https://gateway.isolarcloud.com.hk
//   2. Header `x-access-key` = SecretKey (nao AppKey). AppKey vai no body.
//   3. Login endpoint: POST /openapi/login
//      body: { appkey, user_account, user_password }
//   4. Token vale 24h e o timer reseta a cada call - so precisa relogar se cai.
//   5. Plano Free da Sungrow libera getPowerStationList e getPowerStationDetail.
//      A boa noticia: getPowerStationList ja retorna today_energy (kWh do dia)
//      pra cada planta em uma unica chamada. Nao precisa endpoint separado.
//   6. Unidade `度` no response = kWh; `万度` = 10.000 kWh (10 MWh).

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

interface Session {
  token: string;
  expiresAt: number;
}

export interface IsolarStation {
  psId: string;                    // "1296271"
  psName: string;                  // "Aupus II"
  psLocation: string | null;
  installDate: string | null;      // "2024-03-03 10:26:19"
  latitude: number | null;
  longitude: number | null;
  capacityKwp: number | null;      // total_capcity convertido pra kWp
  todayEnergyKwh: number;          // geracao acumulada de hoje em kWh
  currentPowerKw: number | null;   // potencia atual em kW
  todayEnergyUpdatedAt: string | null; // ISO da ultima medicao
  status: number;                  // 1=normal, 2=disabled, 3=connecting
}

@Injectable()
export class IsolarCloudService {
  private readonly logger = new Logger(IsolarCloudService.name);
  private readonly baseUrl: string;
  private readonly appkey: string;
  private readonly secret: string;
  private readonly user: string;
  private readonly password: string;
  private session: Session | null = null;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>("ISOLARCLOUD_BASE_URL") || "https://gateway.isolarcloud.com.hk";
    this.appkey = config.get<string>("ISOLARCLOUD_APPKEY") || "";
    this.secret = config.get<string>("ISOLARCLOUD_SECRET") || "";
    this.user = config.get<string>("ISOLARCLOUD_USER") || "";
    this.password = config.get<string>("ISOLARCLOUD_PASSWORD") || "";
  }

  private isEnabled(): boolean {
    return !!this.appkey && !!this.secret && !!this.user && !!this.password;
  }

  private async ensureSession(): Promise<Session> {
    if (this.session && this.session.expiresAt > Date.now() + 60_000) {
      return this.session;
    }
    if (!this.isEnabled()) {
      throw new Error("iSolarCloud nao configurado (env vars ausentes)");
    }
    this.logger.log("Fazendo login no iSolarCloud...");
    const res = await this.rawPost("/openapi/login", {
      appkey: this.appkey,
      user_account: this.user,
      user_password: this.password,
    });
    if (res.result_code !== "1") {
      throw new Error(`iSolarCloud login: ${res.result_msg} (${res.result_code})`);
    }
    // Token vale 24h; renova a cada call. Usamos 23h de margem.
    this.session = {
      token: res.result_data.token,
      expiresAt: Date.now() + 23 * 60 * 60 * 1000,
    };
    return this.session;
  }

  // POST cru (sem token) - usado no login.
  private async rawPost(path: string, body: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        sys_code: "901",
        "x-access-key": this.secret,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`iSolarCloud ${path}: HTTP ${res.status}`);
    return res.json();
  }

  private async post(path: string, body: Record<string, unknown>): Promise<any> {
    const s = await this.ensureSession();
    const full = { appkey: this.appkey, token: s.token, ...body };
    const payload = await this.rawPost(path, full);
    // Codigo 006/007 = token invalido/expirado. Reseta e tenta 1x.
    if (payload.result_code === "006" || payload.result_code === "007") {
      this.session = null;
      const s2 = await this.ensureSession();
      const payload2 = await this.rawPost(path, { ...full, token: s2.token });
      if (payload2.result_code !== "1") {
        throw new Error(`iSolarCloud ${path}: ${payload2.result_msg} (${payload2.result_code})`);
      }
      return payload2;
    }
    if (payload.result_code !== "1") {
      throw new Error(`iSolarCloud ${path}: ${payload.result_msg} (${payload.result_code})`);
    }
    return payload;
  }

  // Converte {unit, value} do iSolar pra numero em kWh (unidade padrao BDO).
  // Unidades: "度" (kWh), "万度" (10.000 kWh), "度x10" nao existe.
  private toKwh(v: { unit?: string; value?: string } | null | undefined): number {
    if (!v || v.value == null) return 0;
    const n = Number(v.value);
    if (!Number.isFinite(n)) return 0;
    const unit = v.unit ?? "";
    if (unit === "万度") return n * 10000;
    if (unit === "度") return n;
    if (unit === "MWh") return n * 1000;
    if (unit === "kWh") return n;
    // Assume default kWh
    return n;
  }

  // Igual toKwh mas para capacidade instalada (MWp/kWp).
  private toKwp(v: { unit?: string; value?: string } | null | undefined): number | null {
    if (!v || v.value == null) return null;
    const n = Number(v.value);
    if (!Number.isFinite(n)) return null;
    const unit = v.unit ?? "";
    if (unit === "MWp") return n * 1000;
    if (unit === "kWp") return n;
    return n;
  }

  private toKw(v: { unit?: string; value?: string } | null | undefined): number | null {
    if (!v || v.value == null) return null;
    const n = Number(v.value);
    if (!Number.isFinite(n)) return null;
    const unit = v.unit ?? "";
    if (unit === "MW") return n * 1000;
    if (unit === "kW") return n;
    if (unit === "W") return n / 1000;
    return n;
  }

  async listStations(): Promise<IsolarStation[]> {
    const body = await this.post("/openapi/getPowerStationList", { curPage: 1, size: 100 });
    const list = body.result_data?.pageList ?? body.result_data?.list ?? [];
    return list.map((p: any) => ({
      psId: String(p.ps_id),
      psName: (p.ps_name ?? "").trim(),
      psLocation: p.ps_location ?? null,
      installDate: p.install_date ?? null,
      latitude: p.latitude ?? null,
      longitude: p.longitude ?? null,
      capacityKwp: this.toKwp(p.total_capcity),
      todayEnergyKwh: this.toKwh(p.today_energy),
      currentPowerKw: this.toKw(p.curr_power),
      todayEnergyUpdatedAt: p.today_energy_update_time ?? null,
      status: Number(p.ps_status ?? 0),
    }));
  }
}
