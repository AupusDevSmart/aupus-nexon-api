/**
 * NEXON-33 — Contrato API ↔ front dos Relatórios de operação dos equipamentos.
 * API: copiar para src/modules/relatorios-operacao/relatorios-operacao.tipos.ts
 * Front: copiar para src/features/relatorios/operacao/tipos.ts
 * Qualquer mudança: mudar nos DOIS lugares e neste arquivo.
 *
 * Convenções:
 * - Datas/horas em ISO 8601 com offset (-03:00, horário de Brasília). Dia = 'YYYY-MM-DD'. Mês = 'YYYY-MM'.
 * - Energia em kWh, potência em kW (o front converte para MWh quando > 10.000 kWh).
 * - null = "sem dado" (o front mostra "—" em #9AA0B4). Nunca inventar número: sem fonte, null.
 * - R$: só vem preenchido quando o usuário pode ver R$ E a instalação tem a chave/tarifa. Senão null.
 *
 * Endpoints (todos JwtAuthGuard, escopo pelo PermissionScopeService, auditados pelo
 * ExportacaoAuditoriaService com tipo 'relatorio_operacao' e extra.relatorio = TipoRelatorioOperacao):
 *   GET /relatorios/operacao/escopos?tipo=irrigacao            -> { data: EscopoRelatorio[] }   (sem auditoria de sucesso)
 *   GET /relatorios/operacao/:tipo?unidadeId=..&mes=YYYY-MM&formato=tela|pdf|xlsx
 *        -> { data: RelatorioIrrigacao | RelatorioGeracao | RelatorioConsumo | RelatorioRecargas }
 *        formato só serve para a trilha (o PDF e a planilha são gerados no front com os mesmos dados).
 */

export type TipoRelatorioOperacao = 'irrigacao' | 'geracao' | 'consumo' | 'recargas';
export type FormatoRelatorio = 'tela' | 'pdf' | 'xlsx';

/** Unidade que tem equipamento do tipo do relatório (pivô / inversor / medidor / carregador). */
export interface EscopoRelatorio {
  unidadeId: string;
  unidadeNome: string;
  plantaId: string;
  plantaNome: string;
  /** Quantos equipamentos do tipo do relatório a unidade tem. */
  equipamentos: number;
}

export interface CabecalhoRelatorio {
  tipo: TipoRelatorioOperacao;
  plantaNome: string;
  unidadeNome: string;
  mes: string; // 'YYYY-MM'
  inicio: string; // ISO, 1º dia 00:00
  fim: string; // ISO, último instante do período considerado (fim do mês, ou agora se mês corrente)
  geradoEm: string; // ISO
}

/** Bloco "Chamados" — igual em todos os relatórios (padrão §9). Chamados abertos no mês OU ainda abertos no fim do período. */
export interface ChamadoRelatorio {
  numero: number;
  equipamento: string; // nome do equipamento (ou "—")
  titulo: string;
  abertoEm: string; // ISO
  abertoPor: string | null; // nome
  abertoPorPapel: string | null; // "operador", "analista de operação", "proprietário"...
  /** Destinos já notificados, prontos para exibir: "Smart Service (OS 2318)", "WhatsApp (João)", "E-mail manutencao@x". */
  notificado: string[];
  status: 'ABERTO' | 'ENCAMINHADO' | 'FECHADO' | 'FALHOU' | string;
  /** Preenchido quando FECHADO. */
  atendidoEm: string | null;
}

export interface EnergiaPorPosto {
  pontaKwh: number;
  foraPontaKwh: number;
  reservadoKwh: number;
}

// ───────────────────────── Irrigação ─────────────────────────

export interface LinhaPivo {
  equipamentoId: string;
  nome: string;
  areaHa: number | null;
  cultura: string | null;
  voltas: number | null;
  laminaMm: number | null; // aplicada (estimada)
  programadoMm: number | null;
  horas: number; // horas irrigando no mês
  kwh: number | null;
  paradas: number; // paradas não programadas
  disponibilidadePct: number | null;
  chamados: { abertos: number; atendidos: number };
}

export interface LinhaDoTempoPivo {
  nome: string;
  /** Horas desde `LinhaDoTempo.inicio` (0..168). */
  segmentos: Array<{ inicioH: number; fimH: number }>;
  /** Paradas não programadas, em horas desde o início. */
  paradasH: number[];
}

export interface LinhaDoTempo {
  inicio: string; // 'YYYY-MM-DD' — 7 dias a partir daqui (última semana completa do período)
  dias: Array<{ data: string; temPonta: boolean }>; // 7 itens; temPonta = dia útil (seg–sex, sem feriado se souber)
  pontaInicioH: number; // ex.: 18
  pontaFimH: number; // ex.: 21
  pivos: LinhaDoTempoPivo[];
}

export interface OcorrenciaIrrigacao {
  inicio: string; // ISO
  pivo: string;
  motivo: string; // "Pressão baixa", "Bloqueio de ponta (programado)"...
  duracaoMin: number;
  mmPerdidos: number | null;
  /** true = fora do padrão (laranja); false = informativo/programado (cinza). */
  problema: boolean;
}

export interface RelatorioIrrigacao {
  cabecalho: CabecalhoRelatorio;
  safra: string | null;
  areaHa: number | null;
  /** R$/kWh com impostos usada para estimar custo. null = sem R$. */
  tarifaKwh: number | null;
  linhas: LinhaPivo[];
  energiaPorPosto: EnergiaPorPosto | null;
  linhaDoTempo: LinhaDoTempo | null;
  /** Pivô em destaque no bloco "Lâmina por setor" (o de pior aplicado/programado). 12 setores de 30°, a partir do norte, sentido horário. */
  setores: { pivo: string; programadoMm: number | null; mm: Array<number | null> } | null;
  ocorrencias: OcorrenciaIrrigacao[];
  chamados: ChamadoRelatorio[];
}

// ───────────────────────── Geração ─────────────────────────

export interface InversorRelatorio {
  equipamentoId: string;
  nome: string; // "Inversor 2 · UFV 1" quando houver mais de uma unidade/grupo
  potenciaKwp: number | null;
  energiaKwh: number;
  kwhPorKwp: number | null;
  diasParado: number;
  /** Causa provável já em texto curto, ou null. */
  causa: string | null;
}

export interface RelatorioGeracao {
  cabecalho: CabecalhoRelatorio;
  potenciaKwp: number | null;
  /** 'satelite' quando há geracao_analise_diaria; senão null. */
  fonteEsperado: 'satelite' | null;
  energiaKwh: number;
  energiaMesAnteriorKwh: number | null;
  esperadoKwh: number | null;
  disponibilidadePct: number | null;
  diasComInversorParado: number;
  potenciaMaxKw: number | null;
  potenciaMaxEm: string | null;
  autoconsumoKwh: number | null;
  injetadaKwh: number | null;
  injecaoMaxKw: number | null;
  injecaoMaxEm: string | null;
  /** R$/kWh de referência (só com "Exibir valores em R$" ligado e usuário que vê R$). */
  tarifaReferencia: number | null;
  diario: Array<{ dia: string; geradoKwh: number | null; esperadoKwh: number | null }>;
  perdas: {
    indisponibilidadeKwh: number;
    limitacaoExternaKwh: number;
    limitacaoProjetoKwh: number;
    outrasKwh: number;
    notaIndisponibilidade: string | null;
  } | null;
  inversores: InversorRelatorio[];
  chamados: ChamadoRelatorio[];
}

// ───────────────────────── Consumo ─────────────────────────

export interface RelatorioConsumo {
  cabecalho: CabecalhoRelatorio;
  /** Ex.: "tarifa verde A4". */
  modalidade: string | null;
  demandaContratadaKw: number | null;
  toleranciaPct: number; // 5
  consumoTotalKwh: number | null; // rede + autoconsumo
  daRedeKwh: number | null;
  daRedeMesAnteriorKwh: number | null;
  energiaPorPosto: EnergiaPorPosto | null;
  demandaMaxKw: number | null;
  demandaMaxEm: string | null;
  ultrapassagens: number | null;
  fpMedio: number | null;
  intervalosFpBaixo: number | null; // intervalos de 15 min com FP < 0,92
  reativoExcedenteKvarh: number | null;
  reativoIndutivoPct: number | null;
  cargaBaseKw: number | null;
  /** 12 meses terminando no mês do relatório. */
  demanda12m: Array<{ mes: string; maxKw: number | null }>;
  maioresConsumidores: Array<{ nome: string; kwh: number }>;
  curvaTipica: { diaUtil: Array<number | null>; fimDeSemana: Array<number | null> } | null; // 24 posições (kW médio por hora)
  balanco: {
    geracaoKwh: number | null;
    autoconsumoKwh: number | null;
    daRedeKwh: number | null;
    injetadaKwh: number | null;
  };
  chamados: ChamadoRelatorio[];
}

// ───────────────────────── Recargas (condomínio) ─────────────────────────

export interface MoradorRecarga {
  apartamento: string;
  morador: string;
  recargas: number;
  kwh: number;
  minutos: number;
}

export interface CarregadorRelatorio {
  equipamentoId: string;
  nome: string; // "Carregador Vaga 12"
  potenciaKw: number | null;
  disponibilidadePct: number | null;
  chamadosNoMes: number;
  moradores: MoradorRecarga[];
}

export interface RelatorioRecargas {
  cabecalho: CabecalhoRelatorio;
  /** R$/kWh cadastrado no carregador (carregador_config.tarifa_kwh). null = usuário não vê R$ ou sem tarifa. */
  valorKwh: number | null;
  energiaMesAnteriorKwh: number | null;
  carregadores: CarregadorRelatorio[];
  chamados: ChamadoRelatorio[];
}

export type RelatorioOperacao = RelatorioIrrigacao | RelatorioGeracao | RelatorioConsumo | RelatorioRecargas;
