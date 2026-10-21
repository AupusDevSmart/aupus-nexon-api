import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService, Prisma, ScopedUser } from '@/core';
import { capacidades, papelCanonico } from '@/core/modules/auth/papeis';
import { AuditoriaAcessosService } from '@/core/modules/usuarios/auditoria-acessos.service';
import type { ClienteInfo } from '@/core/common/cliente-info';
import { FONTES_GERACAO, FonteGeracaoConfig, normalizarFonteGeracao } from './geracao-fonte';
import { ColunaOpcional } from './geracao-sql';

/**
 * Grupo "Usina" da configuração da instalação (NEXON-16, seção 7). Tabela `unidade_usina_config`.
 * Ver e editar: só a equipe Aupus (admin e analistas, PER-41); proprietário e operador nem
 * recebem o grupo (403 no controller). Fixar a fonte da geração (NEXON-37): só admin.
 * Toda gravação deixa trilha campo a campo em `unidade_usina_config_historico`, um evento
 * no Registro (`logs_mqtt`, comando_semantico = 'usina.config') e uma linha no audit log
 * (`auditoria_acessos`, acao 'usina_config').
 */

export const FONTES = ['satelite', 'solarimetro', 'nenhuma'] as const;
export type FonteIrradiancia = (typeof FONTES)[number];

export const FAIXAS = {
  kwp_dc: [1, 100_000],
  potencia_ac_kw: [1, 100_000],
  inclinacao_graus: [0, 90],
  azimute_graus: [0, 359],
  fator_desempenho: [0.5, 1],
} as const;

export interface Inversor {
  id: string;
  nome: string;
  potenciaKw: number | null;
}

export interface UnidadeUsina {
  id: string;
  nome: string;
  latitude: number;
  longitude: number;
  potencia: number | null;
  concessionariaId: string | null;
  grupo: string | null;
  subgrupo: string | null;
}

/** Config efetiva (com padrões aplicados) — o que o cálculo usa. */
export interface ConfigUsina {
  fonte: FonteIrradiancia;
  solarimetroEquipamentoId: string | null;
  solarimetroMedicao: 'GHI' | 'POA' | null;
  kwpDc: number | null;
  /** Valor gravado; null = soma dos inversores. */
  potenciaAcKwConfig: number | null;
  inclinacaoGraus: number;
  azimuteGraus: number;
  fatorDesempenho: number;
  exibirRs: boolean;
  tarifaConcessionariaId: string | null;
  /** Fonte da geração (NEXON-37): automatico | ton | nuvem. */
  fonteGeracao: FonteGeracaoConfig;
  atualizadoEm: string | null;
  atualizadoPor: string | null;
  /** true = existe linha gravada para a unidade. */
  gravada: boolean;
}

export interface ContextoUsina {
  unidade: UnidadeUsina;
  inversores: Inversor[];
  config: ConfigUsina;
  /** Potência AC efetiva: config ou soma dos inversores. */
  potenciaAcKw: number | null;
  /** Tarifa com impostos (R$/kWh) quando exibir_rs estiver ligado. */
  tarifaRsKwh: number | null;
}

export interface ConfigUsinaInput {
  fonte?: string;
  solarimetro_equipamento_id?: string | null;
  solarimetro_medicao?: string | null;
  kwp_dc?: number | null;
  potencia_ac_kw?: number | null;
  inclinacao_graus?: number | null;
  azimute_graus?: number | null;
  fator_desempenho?: number | null;
  exibir_rs?: boolean;
  tarifa_concessionaria_id?: string | null;
  /** automatico | ton | nuvem. Ausente = mantém a gravada. Só admin muda. */
  fonte_geracao?: string | null;
}

const ROTULOS: Record<string, string> = {
  fonte: 'Fonte de irradiância',
  solarimetro_equipamento_id: 'Solarímetro vinculado',
  solarimetro_medicao: 'Medição do solarímetro',
  kwp_dc: 'Potência de módulos (kWp DC)',
  potencia_ac_kw: 'Potência AC nominal (kW)',
  inclinacao_graus: 'Inclinação dos módulos (°)',
  azimute_graus: 'Azimute (°)',
  fator_desempenho: 'Fator de desempenho',
  exibir_rs: 'Exibir valores em R$',
  tarifa_concessionaria_id: 'Tarifa de referência',
  fonte_geracao: 'Fonte da geração',
};

export const MSG_SO_ADMIN_FONTE = 'Só admin pode fixar a fonte da geração';

const num = (v: any): number | null => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/** Normaliza a potência técnica cadastrada (kW; W se a unidade disser ou o número for absurdo). */
export function potenciaTecnicaKw(valor: string | null, unidade: string | null): number | null {
  const n = num(valor);
  if (n == null || n <= 0) return null;
  if (unidade && /^w$/i.test(unidade.trim())) return n / 1000;
  if (unidade && /mw/i.test(unidade)) return n * 1000;
  return n;
}

/** Valida e normaliza o corpo do PUT. Pura (testada). */
export function validarConfig(
  input: ConfigUsinaInput,
  solarimetrosDaUnidade: string[],
  fonteGeracaoAtual: FonteGeracaoConfig = 'automatico',
): {
  fonte: FonteIrradiancia; solarimetro_equipamento_id: string | null; solarimetro_medicao: 'GHI' | 'POA' | null;
  kwp_dc: number; potencia_ac_kw: number | null; inclinacao_graus: number | null; azimute_graus: number | null;
  fator_desempenho: number; exibir_rs: boolean; tarifa_concessionaria_id: string | null;
  fonte_geracao: FonteGeracaoConfig;
} {
  const fonte = String(input.fonte ?? 'nenhuma').trim().toLowerCase() as FonteIrradiancia;
  if (!FONTES.includes(fonte)) throw new BadRequestException('Fonte de irradiância inválida (satelite, solarimetro ou nenhuma).');

  const faixa = (campo: keyof typeof FAIXAS, v: number | null, obrigatorio = false): number | null => {
    if (v == null) {
      if (obrigatorio) throw new BadRequestException(`${ROTULOS[campo]} é obrigatório.`);
      return null;
    }
    const [min, max] = FAIXAS[campo];
    if (v < min || v > max) throw new BadRequestException(`${ROTULOS[campo]} fora da faixa (${min} a ${max}).`);
    return v;
  };

  const kwp = faixa('kwp_dc', num(input.kwp_dc), true) as number;
  const ac = faixa('potencia_ac_kw', num(input.potencia_ac_kw));
  const inclinacao = faixa('inclinacao_graus', num(input.inclinacao_graus));
  const azimute = faixa('azimute_graus', num(input.azimute_graus));
  const fator = faixa('fator_desempenho', num(input.fator_desempenho)) ?? 0.8;

  let solarimetro: string | null = null;
  let medicao: 'GHI' | 'POA' | null = null;
  if (fonte === 'solarimetro') {
    solarimetro = input.solarimetro_equipamento_id?.trim() || null;
    if (!solarimetro) throw new BadRequestException('Escolha o solarímetro vinculado.');
    if (!solarimetrosDaUnidade.includes(solarimetro)) throw new BadRequestException('O solarímetro precisa ser um equipamento desta instalação.');
    const m = String(input.solarimetro_medicao ?? '').trim().toUpperCase();
    if (m !== 'GHI' && m !== 'POA') throw new BadRequestException('Informe se o solarímetro mede GHI (horizontal) ou POA (plano dos módulos).');
    medicao = m;
  }
  if (fonte !== 'nenhuma' && (inclinacao == null || azimute == null)) {
    throw new BadRequestException('Inclinação e azimute são obrigatórios com fonte de irradiância.');
  }
  const exibirRs = input.exibir_rs === true;
  let fonteGeracao = fonteGeracaoAtual;
  if (input.fonte_geracao != null && input.fonte_geracao !== '') {
    const f = String(input.fonte_geracao).trim().toLowerCase();
    if (!(FONTES_GERACAO as readonly string[]).includes(f)) {
      throw new BadRequestException('Fonte da geração inválida (automatico, ton ou nuvem).');
    }
    fonteGeracao = f as FonteGeracaoConfig;
  }
  return {
    fonte, solarimetro_equipamento_id: solarimetro, solarimetro_medicao: medicao,
    kwp_dc: kwp, potencia_ac_kw: ac, inclinacao_graus: inclinacao, azimute_graus: azimute,
    fator_desempenho: Math.round(fator * 1000) / 1000, exibir_rs: exibirRs,
    tarifa_concessionaria_id: exibirRs ? input.tarifa_concessionaria_id?.trim() || null : null,
    fonte_geracao: fonteGeracao,
  };
}

/** Diferença campo a campo (antigo → novo). Pura (testada). */
export function diffConfig(antes: Record<string, any>, depois: Record<string, any>): Record<string, { de: any; para: any }> {
  const out: Record<string, { de: any; para: any }> = {};
  for (const k of Object.keys(ROTULOS)) {
    const a = antes[k] ?? null;
    const b = depois[k] ?? null;
    const igual = typeof a === 'number' || typeof b === 'number' ? num(a) === num(b) : a === b;
    if (!igual) out[k] = { de: a, para: b };
  }
  return out;
}

@Injectable()
export class GeracaoConfigService {
  private readonly logger = new Logger(GeracaoConfigService.name);
  /** unidade_usina_config.fonte_geracao (SQL 2026-10-21): sem ela, 'automatico'. */
  private readonly colunaFonte = new ColunaOpcional(/fonte_geracao/);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaAcessosService,
  ) {}

  podeEditar(user?: ScopedUser): boolean {
    return capacidades(papelCanonico(user?.role)).configUsina;
  }

  /** Fixar a fonte da geração: só papel canônico admin (super_admin/admin). */
  podeFixarFonte(user?: ScopedUser): boolean {
    return papelCanonico(user?.role) === 'admin';
  }

  async unidade(unidadeId: string): Promise<UnidadeUsina> {
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT TRIM(id) AS id, TRIM(nome) AS nome, latitude::float8 AS latitude, longitude::float8 AS longitude,
             potencia::float8 AS potencia, TRIM(concessionaria_id) AS concessionaria_id, grupo, subgrupo
      FROM unidades WHERE id = ${unidadeId}::bpchar AND deleted_at IS NULL LIMIT 1`;
    const u = rows[0];
    if (!u) throw new NotFoundException('Instalação não encontrada.');
    return {
      id: u.id, nome: u.nome, latitude: Number(u.latitude), longitude: Number(u.longitude),
      potencia: u.potencia > 0 ? Number(u.potencia) : null,
      concessionariaId: u.concessionaria_id || null, grupo: u.grupo ?? null, subgrupo: u.subgrupo ?? null,
    };
  }

  /** Inversores da instalação (mesma detecção do alarme de comunicação e do COA). */
  async inversores(unidadeId: string): Promise<Inversor[]> {
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT TRIM(e.id) AS id, TRIM(e.nome) AS nome, pot.valor, pot.unidade,
             (SELECT (d.dados->'info'->>'nominal_power') FROM equipamentos_dados d
               WHERE d.equipamento_id = e.id ORDER BY d.timestamp_dados DESC LIMIT 1) AS nominal_info
      FROM equipamentos e
      LEFT JOIN tipos_equipamentos t ON t.id = e.tipo_equipamento_id
      LEFT JOIN categorias_equipamentos c ON c.id = t.categoria_id
      LEFT JOIN LATERAL (
        SELECT dt.valor, dt.unidade FROM equipamentos_dados_tecnicos dt
        WHERE dt.equipamento_id = e.id
          AND lower(dt.campo) IN ('potencia_nominal', 'potencia', 'potencia_ac', 'potencia_nominal_kw')
        ORDER BY (lower(dt.campo) = 'potencia_nominal') DESC, dt.updated_at DESC LIMIT 1
      ) pot ON true
      WHERE e.unidade_id = ${unidadeId}::bpchar AND e.deleted_at IS NULL
        AND COALESCE(e.tipo_equipamento, '') NOT ILIKE 'TON%'
        AND CONCAT_WS(' ', t.codigo, t.nome, e.tipo_equipamento, e.topico_mqtt, c.nome) ~* 'INVERSOR'
      ORDER BY TRIM(e.nome)`;
    return rows.map((r) => ({
      id: r.id,
      nome: r.nome,
      potenciaKw: potenciaTecnicaKw(r.valor, r.unidade) ?? (num(r.nominal_info) && (num(r.nominal_info) as number) > 0 ? num(r.nominal_info) : null),
    }));
  }

  /** Equipamentos da instalação que podem ser solarímetro (nome/tipo/categoria). */
  async solarimetros(unidadeId: string): Promise<Array<{ id: string; nome: string }>> {
    return this.prisma.$queryRaw<Array<{ id: string; nome: string }>>`
      SELECT TRIM(e.id) AS id, TRIM(e.nome) AS nome
      FROM equipamentos e
      LEFT JOIN tipos_equipamentos t ON t.id = e.tipo_equipamento_id
      LEFT JOIN categorias_equipamentos c ON c.id = t.categoria_id
      WHERE e.unidade_id = ${unidadeId}::bpchar AND e.deleted_at IS NULL
        AND CONCAT_WS(' ', t.codigo, t.nome, e.tipo_equipamento, e.topico_mqtt, c.nome, e.nome)
            ~* '(SOLARIM|PIRAN|IRRADI|ESTA[CÇ][AÃ]O METEO|METEOROL|WEATHER)'
      ORDER BY TRIM(e.nome)`;
  }

  private async linha(unidadeId: string): Promise<any | null> {
    if (this.colunaFonte.disponivel()) {
      try {
        const rows = await this.prisma.$queryRaw<any[]>`
          SELECT c.fonte_geracao, c.fonte_irradiancia, c.solarimetro_equipamento_id, c.solarimetro_medicao,
                 c.kwp_dc::float8 AS kwp_dc, c.potencia_ac_kw::float8 AS potencia_ac_kw,
                 c.inclinacao_graus::float8 AS inclinacao_graus, c.azimute_graus::float8 AS azimute_graus,
                 c.fator_desempenho::float8 AS fator_desempenho, c.exibir_rs, c.tarifa_concessionaria_id,
                 to_char(c.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS atualizado_em, TRIM(u.nome) AS atualizado_por
          FROM unidade_usina_config c
          LEFT JOIN usuarios u ON TRIM(u.id) = TRIM(c.updated_by)
          WHERE c.unidade_id = ${unidadeId} LIMIT 1`;
        return rows[0] ?? null;
      } catch (e) {
        if (!this.colunaFonte.ausente(e)) throw e;
        this.logger.warn('[usina] coluna fonte_geracao ausente (SQL 2026-10-21 não aplicado): fonte = automatico');
      }
    }
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT c.fonte_irradiancia, c.solarimetro_equipamento_id, c.solarimetro_medicao,
             c.kwp_dc::float8 AS kwp_dc, c.potencia_ac_kw::float8 AS potencia_ac_kw,
             c.inclinacao_graus::float8 AS inclinacao_graus, c.azimute_graus::float8 AS azimute_graus,
             c.fator_desempenho::float8 AS fator_desempenho, c.exibir_rs, c.tarifa_concessionaria_id,
             to_char(c.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS atualizado_em, TRIM(u.nome) AS atualizado_por
      FROM unidade_usina_config c
      LEFT JOIN usuarios u ON TRIM(u.id) = TRIM(c.updated_by)
      WHERE c.unidade_id = ${unidadeId} LIMIT 1`;
    return rows[0] ?? null;
  }

  sugestoes(unidade: UnidadeUsina, inversores: Inversor[]) {
    const somaAc = inversores.reduce((s, i) => s + (i.potenciaKw ?? 0), 0);
    return {
      kwp_dc: unidade.potencia,
      potencia_ac_kw: somaAc > 0 ? Math.round(somaAc * 1000) / 1000 : null,
      // Padrão de projeto fixo: inclinação ≈ latitude, voltado para o equador.
      inclinacao_graus: Math.min(90, Math.round(Math.abs(unidade.latitude))),
      azimute_graus: unidade.latitude < 0 ? 0 : 180,
    };
  }

  async contexto(unidadeId: string): Promise<ContextoUsina> {
    const uid = unidadeId.trim();
    const [unidade, inversores, row] = await Promise.all([this.unidade(uid), this.inversores(uid), this.linha(uid)]);
    const sug = this.sugestoes(unidade, inversores);
    const config: ConfigUsina = {
      fonte: (row?.fonte_irradiancia as FonteIrradiancia) ?? 'nenhuma',
      solarimetroEquipamentoId: row?.solarimetro_equipamento_id?.trim() || null,
      solarimetroMedicao: row?.solarimetro_medicao ?? null,
      kwpDc: row?.kwp_dc ?? sug.kwp_dc ?? null,
      potenciaAcKwConfig: row?.potencia_ac_kw ?? null,
      inclinacaoGraus: row?.inclinacao_graus ?? sug.inclinacao_graus,
      azimuteGraus: row?.azimute_graus ?? sug.azimute_graus,
      fatorDesempenho: row?.fator_desempenho ?? 0.8,
      exibirRs: row?.exibir_rs === true,
      tarifaConcessionariaId: row?.tarifa_concessionaria_id?.trim() || null,
      fonteGeracao: normalizarFonteGeracao(row?.fonte_geracao),
      atualizadoEm: row?.atualizado_em ?? null,
      atualizadoPor: row?.atualizado_por ?? null,
      gravada: !!row,
    };
    const potenciaAcKw = config.potenciaAcKwConfig ?? sug.potencia_ac_kw;
    const tarifaRsKwh = config.exibirRs ? await this.tarifa(unidade, inversores, config.tarifaConcessionariaId) : null;
    return { unidade, inversores, config, potenciaAcKw, tarifaRsKwh };
  }

  /**
   * Tarifa de referência com impostos (GER-37), mesma regra do "Valor gerado" do inversor nos
   * apps: TUSD + TE da concessionária (grupo A = fora ponta do A4/A3a verde; B = convencional)
   * × 1/((1−ICMS)(1−PIS−COFINS)) da config de custo do inversor. Tarifa personalizada do
   * inversor tem prioridade.
   */
  async tarifa(unidade: UnidadeUsina, inversores: Inversor[], concessionariaId: string | null): Promise<number | null> {
    const concId = concessionariaId || unidade.concessionariaId;
    const ids = inversores.map((i) => i.id);
    const [conc] = concId
      ? await this.prisma.$queryRaw<any[]>`SELECT * FROM concessionarias_energia WHERE id = ${concId}::bpchar LIMIT 1`
      : [null];
    const [custo] = ids.length
      ? await this.prisma.$queryRaw<any[]>`
          SELECT icms::float8 AS icms, pis::float8 AS pis, cofins::float8 AS cofins, usa_tarifa_personalizada,
                 tusd_fp::float8 AS tusd_fp, te_fp::float8 AS te_fp, tusd_b::float8 AS tusd_b, te_b::float8 AS te_b
          FROM configuracoes_custo_equipamento WHERE equipamento_id = ANY(${ids}::bpchar[])
          ORDER BY usa_tarifa_personalizada DESC, (COALESCE(icms, 0) > 0) DESC LIMIT 1`
      : [null];

    const grupoA = String(unidade.grupo ?? '').toUpperCase() === 'A';
    const sub = String(unidade.subgrupo ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const n = (v: any) => (v == null ? 0 : Number(v) || 0);
    let base = 0;
    if (custo?.usa_tarifa_personalizada) {
      base = grupoA ? n(custo.tusd_fp) + n(custo.te_fp) : n(custo.tusd_b) + n(custo.te_b);
    }
    if (!(base > 0) && conc) {
      if (grupoA && sub.includes('a3a')) base = n(conc.a3a_verde_tusd_fp) + n(conc.a3a_verde_te_fp);
      else if (grupoA) base = n(conc.a4_verde_tusd_fp) + n(conc.a4_verde_te_fp);
      else base = n(conc.b_tusd_valor) + n(conc.b_te_valor);
    }
    if (!(base > 0)) return null;
    const icms = n(custo?.icms);
    const pisCofins = n(custo?.pis) + n(custo?.cofins);
    const den = (1 - icms) * (1 - pisCofins);
    return den > 0 ? base / den : base;
  }

  async concessionarias(): Promise<Array<{ id: string; nome: string }>> {
    return this.prisma.$queryRaw`
      SELECT TRIM(id) AS id, TRIM(nome) AS nome FROM concessionarias_energia
      WHERE deleted_at IS NULL ORDER BY nome`.catch(() =>
      this.prisma.$queryRaw`SELECT TRIM(id) AS id, TRIM(nome) AS nome FROM concessionarias_energia ORDER BY nome`,
    ) as Promise<Array<{ id: string; nome: string }>>;
  }

  /** Resposta do GET /config. */
  async obter(unidadeId: string, user?: ScopedUser) {
    const ctx = await this.contexto(unidadeId);
    const [solarimetros, concessionarias, tarifaPreview] = await Promise.all([
      this.solarimetros(ctx.unidade.id),
      this.concessionarias(),
      this.tarifa(ctx.unidade, ctx.inversores, ctx.config.tarifaConcessionariaId),
    ]);
    const c = ctx.config;
    return {
      unidade_id: ctx.unidade.id,
      unidade_nome: ctx.unidade.nome,
      pode_editar: this.podeEditar(user),
      pode_fixar_fonte: this.podeFixarFonte(user),
      config: {
        fonte: c.fonte,
        solarimetro_equipamento_id: c.solarimetroEquipamentoId,
        solarimetro_medicao: c.solarimetroMedicao,
        kwp_dc: c.kwpDc,
        potencia_ac_kw: c.potenciaAcKwConfig,
        inclinacao_graus: c.inclinacaoGraus,
        azimute_graus: c.azimuteGraus,
        fator_desempenho: c.fatorDesempenho,
        exibir_rs: c.exibirRs,
        tarifa_concessionaria_id: c.tarifaConcessionariaId, // null = concessionária da instalação
        fonte_geracao: c.fonteGeracao,
        atualizado_em: c.atualizadoEm,
        atualizado_por: c.atualizadoPor,
      },
      sugestoes: this.sugestoes(ctx.unidade, ctx.inversores),
      faixas: FAIXAS,
      solarimetros,
      inversores: ctx.inversores.map((i) => ({ id: i.id, nome: i.nome, potencia_kw: i.potenciaKw })),
      concessionarias,
      tarifa_preview_rs_kwh: tarifaPreview != null ? Math.round(tarifaPreview * 10000) / 10000 : null,
    };
  }

  /**
   * Grava a config (PUT). Devolve as alterações para o chamador limpar o cache da análise.
   * Trilha: histórico campo a campo + evento no Registro. A trilha nunca derruba a gravação.
   */
  async salvar(
    unidadeId: string, input: ConfigUsinaInput, user?: ScopedUser, cliente?: ClienteInfo,
  ): Promise<Record<string, { de: any; para: any }>> {
    if (!this.podeEditar(user)) {
      throw new ForbiddenException('Recurso fora do escopo do usuario');
    }
    const ctx = await this.contexto(unidadeId);
    const uid = ctx.unidade.id;
    const solarimetros = await this.solarimetros(uid);
    const c = ctx.config;
    const v = validarConfig(input, solarimetros.map((s) => s.id), c.fonteGeracao);

    // Sem linha gravada a fonte já é 'automatico': gravar a primeira config não "muda" a fonte.
    const antes: Record<string, any> = c.gravada
      ? {
          fonte: c.fonte, solarimetro_equipamento_id: c.solarimetroEquipamentoId, solarimetro_medicao: c.solarimetroMedicao,
          kwp_dc: c.kwpDc, potencia_ac_kw: c.potenciaAcKwConfig, inclinacao_graus: c.inclinacaoGraus,
          azimute_graus: c.azimuteGraus, fator_desempenho: c.fatorDesempenho, exibir_rs: c.exibirRs,
          tarifa_concessionaria_id: c.tarifaConcessionariaId, fonte_geracao: c.fonteGeracao,
        }
      : { fonte_geracao: c.fonteGeracao };
    const alteracoes = diffConfig(antes, v);
    if (!Object.keys(alteracoes).length) return alteracoes;
    const mudouFonte = 'fonte_geracao' in alteracoes;
    if (mudouFonte && !this.podeFixarFonte(user)) throw new ForbiddenException(MSG_SO_ADMIN_FONTE);

    const userId = user?.id?.trim() || null;
    const comColuna = this.colunaFonte.disponivel();
    if (mudouFonte && !comColuna) {
      throw new BadRequestException('Fixar a fonte da geração depende do SQL 2026-10-21_fonte_geracao.sql, ainda não aplicado.');
    }
    const gravar = (comFonte: boolean) => this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO unidade_usina_config
        (unidade_id, fonte_irradiancia, solarimetro_equipamento_id, solarimetro_medicao, kwp_dc, potencia_ac_kw,
         inclinacao_graus, azimute_graus, fator_desempenho, exibir_rs, tarifa_concessionaria_id,
         ${comFonte ? Prisma.sql`fonte_geracao,` : Prisma.empty} updated_by, updated_at)
      VALUES (${uid}, ${v.fonte}, ${v.solarimetro_equipamento_id}, ${v.solarimetro_medicao}, ${v.kwp_dc}, ${v.potencia_ac_kw},
              ${v.inclinacao_graus}, ${v.azimute_graus}, ${v.fator_desempenho}, ${v.exibir_rs}, ${v.tarifa_concessionaria_id},
              ${comFonte ? Prisma.sql`${v.fonte_geracao},` : Prisma.empty} ${userId}, now())
      ON CONFLICT (unidade_id) DO UPDATE SET
        fonte_irradiancia = EXCLUDED.fonte_irradiancia,
        solarimetro_equipamento_id = EXCLUDED.solarimetro_equipamento_id,
        solarimetro_medicao = EXCLUDED.solarimetro_medicao,
        kwp_dc = EXCLUDED.kwp_dc, potencia_ac_kw = EXCLUDED.potencia_ac_kw,
        inclinacao_graus = EXCLUDED.inclinacao_graus, azimute_graus = EXCLUDED.azimute_graus,
        fator_desempenho = EXCLUDED.fator_desempenho, exibir_rs = EXCLUDED.exibir_rs,
        tarifa_concessionaria_id = EXCLUDED.tarifa_concessionaria_id,
        ${comFonte ? Prisma.sql`fonte_geracao = EXCLUDED.fonte_geracao,` : Prisma.empty}
        updated_by = EXCLUDED.updated_by, updated_at = now()`);
    try {
      await gravar(comColuna);
    } catch (e) {
      if (!comColuna || !this.colunaFonte.ausente(e)) throw e;
      if (mudouFonte) {
        throw new BadRequestException('Fixar a fonte da geração depende do SQL 2026-10-21_fonte_geracao.sql, ainda não aplicado.');
      }
      await gravar(false);
    }

    const nome = await this.nomeUsuario(userId).catch(() => null);
    await this.registrarTrilha(ctx, alteracoes, user, nome).catch((e) =>
      this.logger.warn(`Trilha da config da usina ${uid} falhou: ${e?.message ?? e}`),
    );
    await this.registrarAuditoria(ctx, alteracoes, user, nome, cliente);
    return alteracoes;
  }

  private async nomeUsuario(userId: string | null): Promise<string | null> {
    if (!userId) return null;
    const r = await this.prisma.$queryRaw<Array<{ nome: string }>>`SELECT TRIM(nome) AS nome FROM usuarios WHERE id = ${userId}::bpchar LIMIT 1`;
    return r[0]?.nome ?? null;
  }

  private resumoAlteracoes(alteracoes: Record<string, { de: any; para: any }>): string {
    const fmt = (v: any) => (v == null || v === '' ? '—' : typeof v === 'boolean' ? (v ? 'sim' : 'não') : String(v));
    return Object.entries(alteracoes).map(([k, d]) => `${ROTULOS[k] ?? k}: ${fmt(d.de)} → ${fmt(d.para)}`).join('; ');
  }

  private async registrarTrilha(
    ctx: ContextoUsina, alteracoes: Record<string, { de: any; para: any }>, user: ScopedUser | undefined, nome: string | null,
  ) {
    const resumo = `Configuração da usina alterada: ${this.resumoAlteracoes(alteracoes)}`.slice(0, 500);
    const userId = user?.id?.trim() || null;
    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO unidade_usina_config_historico (unidade_id, usuario_id, usuario_nome, usuario_papel, campos, alteracoes, resumo)
      VALUES (${ctx.unidade.id}, ${userId}, ${nome}, ${user?.role ?? null}, ${Object.keys(alteracoes)}::text[],
              ${JSON.stringify(alteracoes)}::jsonb, ${resumo})`);

    // Registro da instalação: logs_mqtt exige equipamento — usa o primeiro inversor.
    const eq = ctx.inversores[0];
    if (eq) {
      await this.prisma.logs_mqtt.create({
        data: {
          tipo: 'comando', equipamento_id: eq.id, severidade: 'INFO', status: 'gravado',
          mensagem: resumo, usuario_id: userId, comando_semantico: 'usina.config',
        },
      });
    }
  }

  /**
   * Audit log (auditoria_acessos, acao 'usina_config'): toda alteração do grupo Usina, com a
   * unidade (id e nome), quem (id, nome, papel), os campos e o de/para. Busca por unidade:
   * unidade_ids / objeto_id; por campo: detalhes->'campos_alterados'. Nunca derruba a gravação.
   */
  private async registrarAuditoria(
    ctx: ContextoUsina, alteracoes: Record<string, { de: any; para: any }>, user: ScopedUser | undefined,
    nome: string | null, cliente?: ClienteInfo,
  ): Promise<void> {
    try {
      const uid = ctx.unidade.id;
      const p = await this.prisma.$queryRaw<Array<{ planta_id: string | null }>>`
        SELECT TRIM(planta_id) AS planta_id FROM unidades WHERE id = ${uid}::bpchar LIMIT 1`;
      const plantaId = p[0]?.planta_id || null;
      const campos = Object.keys(alteracoes);
      await this.auditoria.registrar({
        autorId: user?.id ?? null,
        alvoUsuarioId: null,
        acao: 'usina_config',
        mensagem: `Configuração da usina alterada — ${ctx.unidade.nome}: ${this.resumoAlteracoes(alteracoes)}`,
        plantaIds: plantaId ? [plantaId] : [],
        unidadeIds: [uid],
        dispositivo: cliente?.dispositivo ?? null,
        objetoTipo: 'unidade',
        objetoId: uid,
        resultado: 'ok',
        autorNome: nome,
        rota: `/geracao-analise/unidades/${uid}/config`,
        detalhes: {
          usuario: user ? { id: user.id?.trim() ?? null, nome, papel: papelCanonico(user.role) } : null,
          unidade: { id: uid, nome: ctx.unidade.nome },
          planta_id: plantaId,
          campos_alterados: campos,
          alteracoes: campos.map((k) => ({ campo: k, rotulo: ROTULOS[k] ?? k, de: alteracoes[k].de, para: alteracoes[k].para })),
          ip: cliente?.ip ?? null,
          user_agent: cliente?.userAgent ?? null,
        },
      });
    } catch (e) {
      this.logger.warn(`[auditoria] config da usina ${ctx.unidade.id} não registrada: ${(e as Error)?.message ?? e}`);
    }
  }

  /** Histórico da config (mais recente primeiro). */
  async historico(unidadeId: string, limite = 50) {
    return this.prisma.$queryRaw<any[]>`
      SELECT id::text AS id, usuario_id, usuario_nome, usuario_papel, campos, alteracoes, resumo,
             to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS criado_em
      FROM unidade_usina_config_historico WHERE unidade_id = ${unidadeId.trim()}
      ORDER BY created_at DESC LIMIT ${Math.min(Math.max(limite, 1), 200)}`;
  }

  /** Unidades com inversor (com ou sem config) — o job das 06h aquece o cache de todas. */
  async unidadesComInversor(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT TRIM(u.id) AS id
      FROM equipamentos e
      JOIN unidades u ON u.id = e.unidade_id AND u.deleted_at IS NULL AND COALESCE(u.status, 'ativo') <> 'inativo'
      LEFT JOIN tipos_equipamentos t ON t.id = e.tipo_equipamento_id
      LEFT JOIN categorias_equipamentos c ON c.id = t.categoria_id
      WHERE e.deleted_at IS NULL AND COALESCE(e.tipo_equipamento, '') NOT ILIKE 'TON%'
        AND CONCAT_WS(' ', t.codigo, t.nome, e.tipo_equipamento, e.topico_mqtt, c.nome) ~* 'INVERSOR'`;
    return rows.map((r) => r.id);
  }

  /** Unidades com config gravada e a fonte de cada uma (para os jobs). */
  async unidadesConfiguradas(): Promise<Array<{ unidade_id: string; fonte: FonteIrradiancia }>> {
    return this.prisma.$queryRaw`
      SELECT c.unidade_id, c.fonte_irradiancia AS fonte FROM unidade_usina_config c
      JOIN unidades u ON TRIM(u.id) = c.unidade_id AND u.deleted_at IS NULL
      WHERE c.kwp_dc IS NOT NULL`;
  }
}
