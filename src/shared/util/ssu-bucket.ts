/**
 * Conversão dos blocos da SSU (NBR 14522) — gateway A-966 e TON-V2 (entrada SU+).
 * Usado pela ingestão (mqtt.service salvarDadosGateway) e pelo gateway-dashboard.
 *
 * Ke (kWh/pulso):
 *   - `ke` > 0 no envelope → vale (a TON-V2 publica o do cadastro: 0,0003 × RTC × RTP).
 *   - TON-V2 sem ke (envelope tem `fmt`/`seg`) → 0,3 Wh/pulso = 0,0003 kWh (constante
 *     do medidor no secundário; validado em bancada 14/10/2026: 220 V × 5 A por 5 min =
 *     0,0917 kWh = 305 pulsos).
 *   - A-966 (não publica ke) → 0,048, o padrão histórico da instalação que ele atende.
 *
 * Intervalo do bloco: a TON-V2 publica `seg` (duração do intervalo do medidor, ~297 s
 * num medidor de 5 min). Sem `seg` (A-966) → 15 min. kW = kWh do bloco ÷ horas do bloco.
 */
export const KE_PADRAO_A966 = 0.048;
export const KE_PADRAO_TON_SSU = 0.0003;

const env = (dados: any, k: string) => dados?.[k] ?? dados?.data?.[k];

export function keDoBloco(dados: any): number {
  const v = Number(env(dados, 'ke') ?? NaN);
  if (Number.isFinite(v) && v > 0) return v;
  const ehTonV2 = env(dados, 'fmt') !== undefined || env(dados, 'seg') !== undefined;
  return ehTonV2 ? KE_PADRAO_TON_SSU : KE_PADRAO_A966;
}

export function horasDoBloco(dados: any): number {
  const seg = Number(env(dados, 'seg') ?? NaN);
  if (Number.isFinite(seg) && seg >= 50 && seg <= 3600) {
    // arredonda para o minuto cheio (297 s → 300 s = 5 min; 897 s → 15 min)
    const s = Math.max(60, Math.round((seg + 3) / 60) * 60);
    return s / 3600;
  }
  return 0.25;
}
