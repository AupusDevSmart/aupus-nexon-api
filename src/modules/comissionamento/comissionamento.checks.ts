/**
 * MOTOR DE COMISSIONAMENTO (Fase 0) — verificações de COERÊNCIA de dado na instalação.
 *
 * Roda sobre as últimas leituras de UM equipamento e devolve um relatório pass/warn/fail
 * por verificação. Foco desta fase: MEDIDORES (M160 / Power Meter, shape flat
 * Va/Vb/Vc, Ia/Ib/Ic, Pt/Qt/St, FPa/FPb/FPc) — onde mora a dor de inconsistência
 * (ex.: tensão do painel-2 por config de TP/casa decimal). Inversores têm shape aninhado
 * e monitoramento do fabricante → nesta fase só liveness + presença de potência.
 *
 * ⚠️ As faixas abaixo são DEFAULTS canônicos (tunáveis). Fase futura: mover pro catálogo
 * `iot_device_tipos` por tipo/modelo. Ver docs/IOT-NEXON-CONFIABILIDADE.md §3.2/§4.
 *
 * Função PURA (sem Nest/Prisma) — testável isolada.
 */

export type CheckStatus = 'ok' | 'alerta' | 'falha' | 'na';

export interface CheckItem {
  chave: string;
  titulo: string;
  status: CheckStatus;
  detalhe: string;
  valores?: Record<string, unknown>;
}

export interface ChecksResult {
  resumo: 'ok' | 'alerta' | 'falha';
  n_leituras: number;
  itens: CheckItem[];
}

export interface LeituraComissionamento {
  dados: any;
  timestamp_dados: Date | string;
  qualidade?: string | null;
}

export interface TonDiag {
  online?: boolean | null;
  wifi_rssi?: number | null;
  uptime_sec?: number | null;
  modbus_ok?: number | null;
  modbus_err?: number | null;
}

export interface ComissionamentoCtx {
  nome?: string | null;
  tipo?: string | null;      // tipo_equipamento (ex.: 'MEDIDOR', 'INVERSOR', ...)
  agoraMs?: number;          // injetável p/ teste; default Date.now()
  tonDiag?: TonDiag | null;  // diagnóstico da TON (<base>/diagnostics) — saúde Modbus/link
}

// ---- Faixas canônicas (defaults) --------------------------------------------
const V_MIN = 90;            // tensão de fase plausível (V) — abaixo = casa decimal/TP errado
const V_MAX = 500;           // acima = escala x10 ou linha-linha marcada como fase
const V_DESBAL = 1.20;       // max/min entre fases > 20% → desbalanceamento (pega painel-2)
const I_MAX = 20000;         // corrente absurda (A) — provável glitch/escala
const FP_BAIXO = 0.30;       // |FP| muito baixo → alerta (carga reativa ou erro)
const FREQ_MIN = 58;
const FREQ_MAX = 62;
const LIVENESS_OK_MS = 15 * 60 * 1000;   // <15min = fresco
const LIVENESS_ALERTA_MS = 60 * 60 * 1000; // 15-60min = alerta; >60min = falha

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Coleta as fases presentes de um prefixo flat (Va/Vb/Vc → [213,214,215]). */
function fasesFlat(d: any, prefixo: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const suf of ['a', 'b', 'c']) {
    const v = num(d?.[`${prefixo}${suf}`]);
    if (v !== null) out[`${prefixo}${suf}`] = v;
  }
  return out;
}

const piorStatus = (a: CheckStatus, b: CheckStatus): CheckStatus => {
  const rank: Record<CheckStatus, number> = { na: 0, ok: 1, alerta: 2, falha: 3 };
  return rank[a] >= rank[b] ? a : b;
};

/** true se a leitura tem shape flat de medidor (Va.. ou Pt na raiz). */
export function ehMedidorFlat(d: any): boolean {
  if (!d || typeof d !== 'object') return false;
  return d.Va !== undefined || d.Vb !== undefined || d.Vc !== undefined || d.Pt !== undefined;
}

export function rodarChecks(
  leituras: LeituraComissionamento[],
  ctx: ComissionamentoCtx = {},
): ChecksResult {
  const agora = ctx.agoraMs ?? Date.now();
  const itens: CheckItem[] = [];
  const add = (i: CheckItem) => itens.push(i);

  // -- 1. Liveness / recência --------------------------------------------------
  if (!leituras.length) {
    add({ chave: 'liveness', titulo: 'Chega leitura', status: 'falha', detalhe: 'Nenhuma leitura recebida deste equipamento.' });
    return { resumo: 'falha', n_leituras: 0, itens };
  }
  const maisRecente = leituras
    .map((l) => new Date(l.timestamp_dados).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => b - a)[0];
  const idadeMs = agora - maisRecente;
  const idadeMin = Math.round(idadeMs / 60000);
  add({
    chave: 'liveness',
    titulo: 'Chega leitura',
    status: idadeMs < LIVENESS_OK_MS ? 'ok' : idadeMs < LIVENESS_ALERTA_MS ? 'alerta' : 'falha',
    detalhe: `Última leitura há ${idadeMin} min.`,
    valores: { idade_min: idadeMin },
  });

  const ultima = leituras[0]?.dados ?? {};
  const flat = ehMedidorFlat(ultima);

  // -- 2. Não-congelado (precisa de ≥3 leituras) ------------------------------
  if (leituras.length >= 3) {
    const chaveMonitor = flat ? (ultima.Pt !== undefined ? 'Pt' : 'Va') : null;
    if (chaveMonitor) {
      const serie = leituras.slice(0, Math.min(leituras.length, 10)).map((l) => num(l?.dados?.[chaveMonitor]));
      const validos = serie.filter((v) => v !== null) as number[];
      const todosIguais = validos.length >= 3 && validos.every((v) => v === validos[0]);
      add({
        chave: 'congelado',
        titulo: 'Valor não-congelado',
        status: todosIguais ? 'alerta' : 'ok',
        detalhe: todosIguais
          ? `${chaveMonitor} idêntico (${validos[0]}) nas últimas ${validos.length} leituras — possível sensor travado.`
          : `${chaveMonitor} varia entre leituras.`,
        valores: { campo: chaveMonitor, amostras: validos.slice(0, 5) },
      });
    }
  }

  // -- 3. Qualidade da ingestão -----------------------------------------------
  const temSuspeito = leituras.some((l) => String(l.qualidade || '').toUpperCase() === 'SUSPEITO');
  add({
    chave: 'qualidade',
    titulo: 'Qualidade da ingestão',
    status: temSuspeito ? 'alerta' : 'ok',
    detalhe: temSuspeito ? 'Alguma leitura marcada como SUSPEITO na ingestão.' : 'Sem leituras suspeitas na janela.',
  });

  // -- Saúde Modbus da TON (diagnóstico <base>/diagnostics) --------------------
  // Pega o caso "TON viva mas não lê device" (RS485/conversor/endereço). Sem os
  // contadores (firmware antigo / TON não publicou ainda) → 'na'.
  const d = ctx.tonDiag;
  if (!d) {
    add({ chave: 'ton_modbus', titulo: 'Saúde Modbus da TON', status: 'na', detalhe: 'Sem diagnóstico da TON (não publicou /diagnostics ainda).' });
  } else {
    const mbOk = num(d.modbus_ok) ?? 0;
    const mbErr = num(d.modbus_err) ?? 0;
    const total = mbOk + mbErr;
    const rssi = num(d.wifi_rssi);
    let status: CheckStatus = 'ok';
    let detalhe = `Modbus ${mbOk} OK / ${mbErr} erro.`;
    if (total === 0) {
      status = 'na'; detalhe = 'TON sem contadores Modbus (firmware antigo?).';
    } else if (mbOk === 0) {
      status = 'falha'; detalhe = `Modbus 100% falha (${mbErr} erros, 0 leitura OK) — RS485/conversor/device.`;
    } else if (mbErr / total > 0.2) {
      status = 'alerta'; detalhe = `Taxa de erro Modbus ${Math.round((mbErr / total) * 100)}% (${mbErr}/${total}).`;
    }
    if (rssi !== null && rssi < -80 && status === 'ok') {
      status = 'alerta'; detalhe += ` WiFi fraco (${rssi} dBm).`;
    }
    add({ chave: 'ton_modbus', titulo: 'Saúde Modbus da TON', status, detalhe, valores: { modbus_ok: mbOk, modbus_err: mbErr, rssi } });
  }

  // -- 4/5/6. Checks de medidor (só shape flat) -------------------------------
  if (!flat) {
    for (const [chave, titulo] of [['tensao', 'Tensão plausível'], ['corrente', 'Corrente plausível'], ['fp', 'Fator de potência']]) {
      add({ chave, titulo, status: 'na', detalhe: 'Checks completos de medidor não se aplicam a este tipo nesta fase (shape não-flat).' });
    }
  } else {
    // Tensão
    const vs = fasesFlat(ultima, 'V');
    const vArr = Object.values(vs);
    if (!vArr.length) {
      add({ chave: 'tensao', titulo: 'Tensão plausível', status: 'na', detalhe: 'Sem campos Va/Vb/Vc nesta leitura.' });
    } else {
      const foraFaixa = Object.entries(vs).filter(([, v]) => v < V_MIN || v > V_MAX);
      const vmax = Math.max(...vArr), vmin = Math.min(...vArr);
      const desbal = vmin > 0 && vmax / vmin > V_DESBAL;
      let status: CheckStatus = 'ok';
      let detalhe = `Fases dentro de [${V_MIN}, ${V_MAX}] V.`;
      if (foraFaixa.length) {
        status = 'falha';
        detalhe = `Fora de faixa (provável casa decimal/TP): ${foraFaixa.map(([k, v]) => `${k}=${v}`).join(', ')}.`;
      } else if (desbal) {
        status = 'alerta';
        detalhe = `Desbalanceamento entre fases (${vmin} … ${vmax} V) — verificar TP/ligação da fase.`;
      }
      add({ chave: 'tensao', titulo: 'Tensão plausível', status, detalhe, valores: vs });
    }

    // Corrente
    const is = fasesFlat(ultima, 'I');
    const iArr = Object.entries(is);
    if (!iArr.length) {
      add({ chave: 'corrente', titulo: 'Corrente plausível', status: 'na', detalhe: 'Sem campos Ia/Ib/Ic nesta leitura.' });
    } else {
      const ruins = iArr.filter(([, v]) => v < 0 || v > I_MAX);
      add({
        chave: 'corrente',
        titulo: 'Corrente plausível',
        status: ruins.length ? 'falha' : 'ok',
        detalhe: ruins.length ? `Corrente inválida (negativa/absurda): ${ruins.map(([k, v]) => `${k}=${v}`).join(', ')}.` : 'Correntes ≥ 0 e dentro do esperado.',
        valores: is,
      });
    }

    // Fator de potência
    const fps = fasesFlat(ultima, 'FP');
    const fpArr = Object.entries(fps);
    if (!fpArr.length) {
      add({ chave: 'fp', titulo: 'Fator de potência', status: 'na', detalhe: 'Sem campos FPa/FPb/FPc nesta leitura.' });
    } else {
      const foraUm = fpArr.filter(([, v]) => Math.abs(v) > 1.001);
      const baixos = fpArr.filter(([, v]) => Math.abs(v) < FP_BAIXO);
      let status: CheckStatus = 'ok';
      let detalhe = 'FP dentro de [-1, 1].';
      if (foraUm.length) { status = 'falha'; detalhe = `|FP| > 1 (erro de escala): ${foraUm.map(([k, v]) => `${k}=${v}`).join(', ')}.`; }
      else if (baixos.length) { status = 'alerta'; detalhe = `FP muito baixo: ${baixos.map(([k, v]) => `${k}=${v}`).join(', ')} — carga reativa ou fase invertida.`; }
      add({ chave: 'fp', titulo: 'Fator de potência', status, detalhe, valores: fps });
    }

    // Frequência (se presente)
    const freq = num(ultima.freq ?? ultima.Freq ?? ultima.frequencia ?? ultima.Hz);
    if (freq === null) {
      add({ chave: 'frequencia', titulo: 'Frequência', status: 'na', detalhe: 'Sem campo de frequência nesta leitura.' });
    } else {
      add({
        chave: 'frequencia',
        titulo: 'Frequência',
        status: freq >= FREQ_MIN && freq <= FREQ_MAX ? 'ok' : 'falha',
        detalhe: `${freq} Hz (esperado ${FREQ_MIN}–${FREQ_MAX}).`,
        valores: { freq },
      });
    }
  }

  const resumo = itens.reduce<CheckStatus>((acc, i) => piorStatus(acc, i.status), 'ok');
  return { resumo: resumo === 'na' ? 'ok' : resumo, n_leituras: leituras.length, itens };
}
