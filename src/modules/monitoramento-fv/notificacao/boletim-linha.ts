/**
 * Linha do boletim diário (WhatsApp) a partir da fonte escolhida (NEXON-37). Pura, testada em
 * boletim-linha.spec.ts. O kWh é o do FonteGeracaoService (manual vence; TON × nuvem pela
 * regra); a confiança diz o quanto as duas fontes batem e se a TON veio completa.
 */
import type { DiaFonte } from '../../geracao-analise/geracao-fonte';

export type Confianca = 'alta' | 'media' | 'baixa';
export interface LinhaGeracao {
  unidade_id: string;
  nome: string;
  kwh_realizado: number;
  kwh_previsto: number;
  fonte: 'api' | 'ton' | 'manual' | 'bdo';
  confianca: Confianca;
  motivo: string;
}

export interface EntradaLinha {
  unidadeId: string;
  nome: string;
  previsto: number;
  escolha: Pick<DiaFonte, 'fonte' | 'motivo' | 'kwh' | 'kwhTon' | 'kwhNuvem' | 'divergenciaPct'> | undefined;
  /** origem da linha manual em geracao_diaria_plantas. */
  origemManual: 'manual' | 'bdo' | null;
  /** Existe linha da API (nuvem) no diário. */
  temApi: boolean;
  /** Por que a TON está parcial ('' = completa): inversor faltando, leitura parada antes das 17h. */
  parcial: string;
  /** Sufixo de aviso (ex.: inversor cadastrado 2×). */
  aviso?: string;
  fmtKwh: (v: number) => string;
}

export function linhaBoletim(e: EntradaLinha): LinhaGeracao | null {
  const esc = e.escolha;
  if (!esc || esc.kwh == null || esc.fonte == null) return null;
  const fmt = e.fmtKwh;
  const ton = esc.kwhTon;
  const nuvem = esc.kwhNuvem;
  const tonCompleto = ton != null && ton > 0 && !e.parcial;
  const pct = esc.divergenciaPct != null ? `${Math.round(esc.divergenciaPct)}%` : '';
  const porDiferenca = (): Confianca => {
    const d = (esc.divergenciaPct ?? 0) / 100;
    return d <= 0.1 ? 'alta' : d <= 0.3 ? 'media' : 'baixa';
  };
  const comparacao = ton != null && nuvem != null ? ` · API ${fmt(nuvem)} × TON ${fmt(ton)} kWh (${pct})` : '';
  const semApi = e.temApi ? 'API sem dado' : 'sem API';
  const parcial = e.parcial ? `TON parcial: ${e.parcial}` : 'TON parcial';

  let fonte: LinhaGeracao['fonte'];
  let confianca: Confianca;
  let motivo: string;
  if (esc.fonte === 'manual') {
    fonte = e.origemManual ?? 'manual';
    confianca = 'alta';
    motivo = fonte === 'bdo' ? 'conferido no BDO' : 'conferido manualmente';
  } else if (esc.fonte === 'nuvem') {
    fonte = 'api';
    switch (esc.motivo) {
      case 'ton_incompleta':
        confianca = 'media';
        motivo = `via API (${parcial}${ton != null ? `, TON ${fmt(ton)} kWh` : ''})`;
        break;
      case 'fixada':
        confianca = ton != null && tonCompleto ? porDiferenca() : 'media';
        motivo = `fonte fixada: API${comparacao}`;
        break;
      case 'fixada_sem_dado':
        confianca = 'media';
        motivo = 'fonte fixada na TON sem dado — via API';
        break;
      default: // so_nuvem
        confianca = 'media';
        motivo = ton != null ? `só API (${parcial})` : 'só API';
    }
  } else {
    fonte = 'ton';
    switch (esc.motivo) {
      case 'concordam':
        confianca = tonCompleto ? 'alta' : 'media';
        motivo = 'API e TON batem';
        break;
      case 'divergem':
        confianca = tonCompleto ? porDiferenca() : 'baixa';
        motivo = `API ${fmt(nuvem ?? 0)} × TON ${fmt(ton ?? 0)} kWh (${pct}) — usando TON${e.parcial ? ` (${parcial})` : ''}`;
        break;
      case 'nuvem_zerada':
        confianca = tonCompleto ? 'media' : 'baixa';
        motivo = tonCompleto ? 'via TON (API zerada)' : `via TON, parcial: ${e.parcial} (API zerada)`;
        break;
      case 'fixada':
        confianca = !tonCompleto ? 'baixa' : nuvem != null ? porDiferenca() : 'media';
        motivo = `fonte fixada: TON${comparacao}`;
        break;
      case 'fixada_sem_dado':
        confianca = tonCompleto ? 'media' : 'baixa';
        motivo = 'fonte fixada na API sem dado — via TON';
        break;
      default: // so_ton
        confianca = tonCompleto ? 'media' : 'baixa';
        motivo = tonCompleto ? `via TON (${semApi})` : `via TON, parcial: ${e.parcial || 'cobertura baixa'} (${semApi})`;
    }
  }
  return {
    unidade_id: e.unidadeId, nome: e.nome, kwh_realizado: esc.kwh, kwh_previsto: e.previsto, fonte, confianca,
    motivo: motivo + (e.aviso ?? ''),
  };
}
