import { PrismaService } from '../../prisma/prisma.service';

/**
 * Capacidades da instalação (NEXON-110): o que existe de verdade nela — Geração, medição de
 * entrada (Carga), Rede, Grandezas elétricas, demanda contratada. Web e apps só leem isto; nada de
 * recalcular "tem medidor" na tela.
 *
 * Regras:
 * - "Existe" = há fonte de dados configurada (tópico MQTT ou vínculo no projeto IoT da TON), não
 *   um símbolo no unifilar. Medidor desenhado sem vínculo IoT não existe.
 * - Existe mas sem leitura recente continua existindo, com `comunicando: false`.
 * - Quem fala de quê segue a categoria do equipamento (a mesma do gráfico de demanda):
 *   Inversores → Geração; Power Meter → Carga; medidor da concessionária (Padrão de Energia,
 *   Gateway, SSU) → Rede. Sem Power Meter a carga é desconhecida, não zero.
 * - Grandezas elétricas só de medidor (PM ou concessionária) com tensão/corrente (gateway
 *   A966/SSU não tem). Tensão/corrente de inversor nunca entra: não é o ponto de conexão.
 */

export type FonteCapacidade = 'ton' | 'nuvem' | 'manual' | null;

export interface Capacidade {
  existe: boolean;
  fonte: FonteCapacidade;
  comunicando: boolean | null;
  ultima_leitura: string | null;
}

export interface CapacidadesUnidade {
  geracao: Capacidade;
  medicao_entrada: Capacidade;
  carga: Capacidade;
  rede: Capacidade;
  grandezas_eletricas: Capacidade;
  demanda_contratada: Capacidade;
}

/** Equipamento da unidade como a consulta devolve. */
export interface EquipamentoCapacidade {
  id: string;
  codigo: string | null;
  tipo_nome: string | null;
  categoria: string | null;
  tipo_equipamento: string | null;
  topico_mqtt: string | null;
  /** Ligado ao projeto IoT de uma TON (iot_componentes). */
  vinculado_iot: boolean;
  ultima_leitura: Date | string | null;
}

export interface EntradaCapacidades {
  equipamentos: EquipamentoCapacidade[];
  demandaCarga: number | null;
  demandaGeracao: number | null;
  nuvem: { ativo: boolean; ultima_sync_em: Date | string | null; frequencia_min: number | null } | null;
  agora?: Date;
}

/** Mesma janela do status do COA (coa.service: leitura < 30 min = comunicando). */
export const JANELA_COMUNICACAO_MS = 30 * 60 * 1000;

const RE_TON = /^TON/i;
const RE_INVERSOR = /INVERSOR/i;
const RE_GATEWAY = /(A-?966|SSU|GATEWAY)/i;
/** Medidor da concessionária: ponto de conexão com a rede (categoria BIDIRECIONAL + SSU). */
const CATEGORIAS_REDE = new Set(['gateway', 'padrão de energia - ramal de entrada', 'medidor ssu']);
const CATEGORIAS_CARGA = new Set(['power meter']);

const NAO_EXISTE: Capacidade = { existe: false, fonte: null, comunicando: null, ultima_leitura: null };

function texto(e: EquipamentoCapacidade): string {
  return [e.codigo, e.tipo_nome, e.categoria, e.tipo_equipamento, e.topico_mqtt].filter(Boolean).join(' ');
}

function ehTon(e: EquipamentoCapacidade): boolean {
  return RE_TON.test(e.codigo ?? '') || RE_TON.test(e.tipo_equipamento ?? '') || (e.categoria ?? '').trim().toUpperCase() === 'TON';
}

function temFonteDeDados(e: EquipamentoCapacidade): boolean {
  return !!(e.topico_mqtt && e.topico_mqtt.trim()) || e.vinculado_iot;
}

export function ehInversor(e: EquipamentoCapacidade): boolean {
  return !ehTon(e) && RE_INVERSOR.test(texto(e));
}

const cat = (e: EquipamentoCapacidade) => (e.categoria ?? '').trim().toLowerCase();

/** Power Meter → Carga. */
export function ehPowerMeter(e: EquipamentoCapacidade): boolean {
  return !ehTon(e) && CATEGORIAS_CARGA.has(cat(e));
}

/** Medidor da concessionária → Rede. */
export function ehMedidorConcessionaria(e: EquipamentoCapacidade): boolean {
  if (ehTon(e) || ehInversor(e)) return false;
  return (e.codigo ?? '').toUpperCase() === 'EQTL001' || CATEGORIAS_REDE.has(cat(e));
}

function temGrandezas(e: EquipamentoCapacidade): boolean {
  return !RE_GATEWAY.test([e.codigo, e.tipo_nome, e.tipo_equipamento, e.categoria].filter(Boolean).join(' '));
}

function data(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

function porLeitura(eqs: EquipamentoCapacidade[], fonte: FonteCapacidade, agora: Date): Capacidade {
  if (!eqs.length) return { ...NAO_EXISTE };
  let ultima: Date | null = null;
  for (const e of eqs) {
    const d = data(e.ultima_leitura);
    if (d && (!ultima || d > ultima)) ultima = d;
  }
  return {
    existe: true,
    fonte,
    comunicando: !!ultima && agora.getTime() - ultima.getTime() < JANELA_COMUNICACAO_MS,
    ultima_leitura: ultima ? ultima.toISOString() : null,
  };
}

/** Regra pura (testável): equipamentos + configuração → capacidades. */
export function calcularCapacidades(entrada: EntradaCapacidades): CapacidadesUnidade {
  const agora = entrada.agora ?? new Date();
  const comFonte = entrada.equipamentos.filter(temFonteDeDados);

  const inversores = comFonte.filter(ehInversor);
  const powerMeters = comFonte.filter(ehPowerMeter);
  const medidoresRede = comFonte.filter(ehMedidorConcessionaria);
  const medidores = [...powerMeters, ...medidoresRede];

  let geracao: Capacidade;
  if (inversores.length) {
    geracao = porLeitura(inversores, 'ton', agora);
  } else if (entrada.nuvem?.ativo) {
    const sync = data(entrada.nuvem.ultima_sync_em);
    const janela = Math.max(60, 3 * (entrada.nuvem.frequencia_min ?? 0)) * 60 * 1000;
    geracao = {
      existe: true,
      fonte: 'nuvem',
      comunicando: !!sync && agora.getTime() - sync.getTime() < janela,
      ultima_leitura: sync ? sync.toISOString() : null,
    };
  } else {
    geracao = { ...NAO_EXISTE };
  }

  const medicao = porLeitura(medidores, 'ton', agora);
  const demanda = (entrada.demandaCarga ?? 0) > 0 || (entrada.demandaGeracao ?? 0) > 0;

  return {
    geracao,
    medicao_entrada: medicao,
    carga: porLeitura(powerMeters, 'ton', agora),
    rede: porLeitura(medidoresRede, 'ton', agora),
    grandezas_eletricas: porLeitura(medidores.filter(temGrandezas), 'ton', agora),
    demanda_contratada: demanda ? { existe: true, fonte: 'manual', comunicando: null, ultima_leitura: null } : { ...NAO_EXISTE },
  };
}

/** Busca o que a regra precisa e calcula. Leitura de nuvem/mock não conta como leitura da TON. */
export async function buscarCapacidades(
  prisma: PrismaService,
  unidadeId: string,
  demandaCarga: number | null,
  demandaGeracao: number | null,
): Promise<CapacidadesUnidade> {
  const equipamentos = await prisma.$queryRaw<EquipamentoCapacidade[]>`
    SELECT TRIM(e.id) AS id, t.codigo, t.nome AS tipo_nome, c.nome AS categoria, e.tipo_equipamento, e.topico_mqtt,
           EXISTS (
             SELECT 1 FROM iot_componentes ic
             WHERE ic.equipamento_id = e.id OR TRIM(ic.props->>'equipamento_id') = TRIM(e.id)
           ) AS vinculado_iot,
           (
             SELECT d.timestamp_dados FROM equipamentos_dados d
             WHERE d.equipamento_id = e.id
               AND d.timestamp_dados > now() - interval '7 days'
               AND COALESCE(d.fonte, 'MQTT') NOT ILIKE 'NUVEM%'
               AND COALESCE(d.qualidade, '') <> 'MOCK'
             ORDER BY d.timestamp_dados DESC LIMIT 1
           ) AS ultima_leitura
    FROM equipamentos e
    LEFT JOIN tipos_equipamentos t ON t.id = e.tipo_equipamento_id
    LEFT JOIN categorias_equipamentos c ON c.id = t.categoria_id
    WHERE e.unidade_id = ${unidadeId}::bpchar AND e.deleted_at IS NULL`;

  let nuvem: EntradaCapacidades['nuvem'] = null;
  try {
    const [fv] = await prisma.$queryRaw<Array<{ ativo: boolean; ultima_sync_em: Date | null; frequencia_min: number | null }>>`
      SELECT ativo, ultima_sync_em, frequencia_min FROM unidade_fv_config
      WHERE unidade_id = ${unidadeId}::bpchar AND COALESCE(provedor_monitoramento, '') <> '' LIMIT 1`;
    nuvem = fv ? { ativo: !!fv.ativo, ultima_sync_em: fv.ultima_sync_em, frequencia_min: fv.frequencia_min != null ? Number(fv.frequencia_min) : null } : null;
  } catch {
    nuvem = null;
  }

  return calcularCapacidades({ equipamentos, demandaCarga, demandaGeracao, nuvem });
}
