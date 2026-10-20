import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaService, PermissionScopeService, ScopedUser } from '@/core';
import { MedidorResumoService } from '../equipamentos-dados/services/medidor-resumo.service';
import { ClassificacaoHorariosService } from '../equipamentos-dados/services/classificacao-horarios.service';
import { FeriadosNacionaisService } from '../equipamentos-dados/services/feriados-nacionais.service';
import { TipoHorario } from '../equipamentos-dados/interfaces/calculo-custos.interface';
import { Bloco, Posto } from './calc/consumo';
import { Intervalo } from './calc/disponibilidade';
import { LinhaChamado, LinhaEncaminhamento, montarChamados } from './calc/chamados';
import { diaSemanaIso, isoBrt, periodoDoMes, PeriodoRelatorio } from './calc/periodo';
import type { CabecalhoRelatorio, ChamadoRelatorio, EscopoRelatorio, TipoRelatorioOperacao } from './relatorios-operacao.tipos';

export const TIPOS_RELATORIO: readonly TipoRelatorioOperacao[] = ['irrigacao', 'geracao', 'consumo', 'recargas'];

const ROTULO_EQUIPAMENTO: Record<TipoRelatorioOperacao, string> = {
  irrigacao: 'pivô',
  geracao: 'inversor',
  consumo: 'medidor',
  recargas: 'carregador',
};

/**
 * Equipamento do tipo do relatório. Aliases: e = equipamentos, t = tipos_equipamentos,
 * c = categorias_equipamentos. Inversor = mesma detecção da análise de geração.
 */
export function filtroTipo(tipo: TipoRelatorioOperacao): Prisma.Sql {
  switch (tipo) {
    case 'irrigacao':
      return Prisma.sql`(t.codigo = 'PIVO' OR (t.codigo IS NULL AND COALESCE(e.tipo_equipamento, '') ~* 'piv[oô]'))`;
    case 'geracao':
      return Prisma.sql`(COALESCE(e.tipo_equipamento, '') NOT ILIKE 'TON%'
        AND CONCAT_WS(' ', t.codigo, t.nome, e.tipo_equipamento, e.topico_mqtt, c.nome) ~* 'INVERSOR')`;
    case 'consumo':
      return Prisma.sql`(t.codigo IN ('METER_M160', 'EQTL001')
        OR (t.codigo IS NULL AND COALESCE(e.tipo_equipamento, '') ~* '(METER|M-?160|medidor)'))`;
    case 'recargas':
      return Prisma.sql`(t.codigo ILIKE '%CARREGADOR%' OR COALESCE(e.tipo_equipamento, '') ILIKE '%carregador%')`;
  }
}

export interface UnidadeRelatorio {
  id: string;
  nome: string;
  planta_id: string;
  planta_nome: string;
  grupo: string | null;
  subgrupo: string | null;
  irrigante: boolean;
  concessionaria_id: string | null;
}

export interface EquipamentoRelatorio {
  id: string;
  nome: string;
  codigo: string | null;
  pai_nome: string | null;
}

export interface ContextoRelatorio {
  tipo: TipoRelatorioOperacao;
  periodo: PeriodoRelatorio;
  unidade: UnidadeRelatorio;
  /** Equipamentos do tipo do relatório que o usuário enxerga. */
  equipamentos: EquipamentoRelatorio[];
  /** Recorte por equipamento do operador (null = sem recorte). */
  eqScope: string[] | null;
  user?: ScopedUser;
  agora: Date;
}

/** Fonte da medição de um disjuntor (Power Meter / medidor ligado pelo IoT) e a carga abaixo dele. */
export interface FonteMedicao {
  fonte_id: string;
  fonte_nome: string | null;
  dj_id: string;
  dj_nome: string;
  carga_id: string | null;
  carga_nome: string | null;
  carga_codigo: string | null;
}

export interface AlertaEquipamento {
  equipamento_id: string;
  created_at: Date;
  resolvido_em: Date | null;
  mensagem: string | null;
  regra: string | null;
  severidade: string | null;
  origem: string | null;
  desde: string | null;
  volta_em: string | null;
  afetados: unknown;
}

/**
 * Partes comuns dos relatórios de operação (NEXON-33): período, escopo, cabeçalho,
 * chamados, alarmes de comunicação e leitura do medidor.
 *
 * Armadilha (equipamentos_dados e afins): `equipamento_id` é char(26); filtro com
 * `= ANY(ids::bpchar[])` (usa o índice) e TRIM só no que sai — nunca TRIM na coluna do WHERE.
 */
@Injectable()
export class RelatorioBaseService {
  private readonly logger = new Logger(RelatorioBaseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: PermissionScopeService,
    private readonly medidor: MedidorResumoService,
    private readonly classificacao: ClassificacaoHorariosService,
    private readonly feriados: FeriadosNacionaisService,
  ) {}

  tipoValido(tipo: string | null | undefined): TipoRelatorioOperacao {
    const t = String(tipo ?? '').trim().toLowerCase() as TipoRelatorioOperacao;
    if (!TIPOS_RELATORIO.includes(t)) {
      throw new BadRequestException(`Tipo de relatório inválido (use ${TIPOS_RELATORIO.join(', ')}).`);
    }
    return t;
  }

  // ───────────────────────── Escopo ─────────────────────────

  /** Instalações com equipamento do tipo, no escopo do usuário (operador: só o que foi liberado). */
  async escopos(tipo: TipoRelatorioOperacao, user?: ScopedUser): Promise<EscopoRelatorio[]> {
    const rows = await this.prisma.$queryRaw<Array<{ unidade_id: string; unidade_nome: string; planta_id: string; planta_nome: string; ids: string[] }>>`
      SELECT TRIM(u.id) AS unidade_id, TRIM(u.nome) AS unidade_nome, TRIM(p.id) AS planta_id, TRIM(p.nome) AS planta_nome,
             array_agg(TRIM(e.id)) AS ids
      FROM equipamentos e
      JOIN unidades u ON u.id = e.unidade_id AND u.deleted_at IS NULL
      JOIN plantas p ON p.id = u.planta_id AND p.deleted_at IS NULL
      LEFT JOIN tipos_equipamentos t ON t.id = e.tipo_equipamento_id
      LEFT JOIN categorias_equipamentos c ON c.id = t.categoria_id
      WHERE e.deleted_at IS NULL AND ${filtroTipo(tipo)}
      GROUP BY u.id, u.nome, p.id, p.nome
      ORDER BY TRIM(p.nome), TRIM(u.nome)`;
    const plantas = await this.scope.getScope(user);
    const eqScope = await this.scope.getEquipamentosScope(user);
    const lib = eqScope ? new Set(eqScope) : null;
    const out: EscopoRelatorio[] = [];
    for (const r of rows) {
      if (this.scope.isScoped(plantas) && !plantas.includes(r.planta_id)) continue;
      const ids = lib ? r.ids.filter((id) => lib.has(id)) : r.ids;
      if (!ids.length) continue;
      out.push({ unidadeId: r.unidade_id, unidadeNome: r.unidade_nome, plantaId: r.planta_id, plantaNome: r.planta_nome, equipamentos: ids.length });
    }
    return out;
  }

  /**
   * Valida mês e acesso e carrega a instalação e os equipamentos do tipo. Fora do escopo →
   * 403 (ForbiddenException, auditada como exportação negada); mês inválido → 400.
   */
  async contexto(tipo: TipoRelatorioOperacao, unidadeId: string, mes: string, user?: ScopedUser, agora = new Date()): Promise<ContextoRelatorio> {
    const periodo = periodoDoMes(mes, agora);
    if (!periodo) throw new BadRequestException("Mês inválido: use 'YYYY-MM' de 2020 até o mês corrente.");
    const uid = String(unidadeId ?? '').trim();
    if (!uid) throw new BadRequestException('unidadeId obrigatório');

    const [u] = await this.prisma.$queryRaw<UnidadeRelatorio[]>`
      SELECT TRIM(u.id) AS id, TRIM(u.nome) AS nome, TRIM(u.planta_id) AS planta_id, TRIM(p.nome) AS planta_nome,
             u.grupo, u.subgrupo, u.irrigante, TRIM(u.concessionaria_id) AS concessionaria_id
      FROM unidades u JOIN plantas p ON p.id = u.planta_id
      WHERE u.id = ${uid}::bpchar AND u.deleted_at IS NULL LIMIT 1`;
    if (!u) throw new NotFoundException('Instalação não encontrada.');

    const plantas = await this.scope.getScope(user);
    if (this.scope.isScoped(plantas) && !plantas.includes(u.planta_id)) throw new ForbiddenException('Unidade fora do escopo');
    const unidades = await this.scope.getUnidadesScope(user);
    if (unidades && !unidades.includes(u.id)) throw new ForbiddenException('Unidade fora do escopo');

    const todos = await this.listar(uid, tipo);
    if (!todos.length) throw new NotFoundException(`Instalação sem ${ROTULO_EQUIPAMENTO[tipo]} — relatório não se aplica.`);

    const eqScope = await this.scope.getEquipamentosScope(user);
    const equipamentos = eqScope ? todos.filter((e) => eqScope.includes(e.id)) : todos;
    if (!equipamentos.length) throw new ForbiddenException('Recurso fora do escopo do usuario');

    return { tipo, periodo, unidade: { ...u, irrigante: u.irrigante === true }, equipamentos, eqScope, user, agora };
  }

  /** Equipamentos do tipo na instalação (sem recorte de escopo), em ordem natural de nome. */
  async listar(unidadeId: string, tipo: TipoRelatorioOperacao): Promise<EquipamentoRelatorio[]> {
    const todos = await this.prisma.$queryRaw<EquipamentoRelatorio[]>`
      SELECT TRIM(e.id) AS id, TRIM(e.nome) AS nome, t.codigo, TRIM(pai.nome) AS pai_nome
      FROM equipamentos e
      LEFT JOIN tipos_equipamentos t ON t.id = e.tipo_equipamento_id
      LEFT JOIN categorias_equipamentos c ON c.id = t.categoria_id
      LEFT JOIN equipamentos pai ON pai.id = e.equipamento_pai_id
      WHERE e.unidade_id = ${unidadeId}::bpchar AND e.deleted_at IS NULL AND ${filtroTipo(tipo)}`;
    const cmp = (a: string, b: string) => a.localeCompare(b, 'pt-BR', { numeric: true, sensitivity: 'base' });
    return todos.sort((a, b) => cmp(a.nome, b.nome));
  }

  cabecalho(ctx: ContextoRelatorio): CabecalhoRelatorio {
    return {
      tipo: ctx.tipo,
      plantaNome: ctx.unidade.planta_nome,
      unidadeNome: ctx.unidade.nome,
      mes: ctx.periodo.mes,
      inicio: isoBrt(ctx.periodo.inicio) as string,
      fim: isoBrt(ctx.periodo.fim.getTime() - 1000) as string,
      geradoEm: isoBrt(ctx.agora) as string,
    };
  }

  /** "Ver valores em R$" em TODOS os equipamentos pedidos (operador); demais papéis veem. */
  async podeVerValores(ids: string[], user?: ScopedUser): Promise<boolean> {
    if (!user) return true;
    if (!ids.length) return false;
    for (const id of ids) if (!(await this.scope.podeVerValores(id, user))) return false;
    return true;
  }

  async podeVerGeracao(unidadeId: string, user?: ScopedUser): Promise<boolean> {
    return this.scope.podeVerGeracao(unidadeId, user);
  }

  // ───────────────────────── Chamados ─────────────────────────

  /**
   * Chamados da instalação abertos no período OU ainda abertos no fim dele. Operador: só dos
   * equipamentos liberados. `soEquipamentos` restringe aos equipamentos do relatório.
   */
  async chamados(ctx: ContextoRelatorio, soEquipamentos?: string[]): Promise<{ linhas: LinhaChamado[]; bloco: ChamadoRelatorio[] }> {
    const { inicio, fim } = ctx.periodo;
    let linhas: LinhaChamado[];
    try {
      linhas = await this.prisma.$queryRaw<LinhaChamado[]>`
        SELECT TRIM(ch.id) AS id, ch.numero, TRIM(ch.equipamento_id) AS equipamento_id, TRIM(e.nome) AS equipamento_nome,
               ch.titulo, ch.status, ch.created_at, ch.autor_nome, ch.fechado_em,
               (SELECT r.name FROM model_has_roles mr JOIN roles r ON r.id = mr.role_id
                WHERE ch.autor_id IS NOT NULL AND mr.model_id = ch.autor_id::bpchar LIMIT 1) AS autor_role
        FROM chamados ch
        LEFT JOIN equipamentos e ON e.id = ch.equipamento_id::bpchar
        WHERE ch.deleted_at IS NULL
          AND (ch.unidade_id = ${ctx.unidade.id} OR e.unidade_id = ${ctx.unidade.id}::bpchar)
          AND ch.created_at < ${fim}
          AND (ch.created_at >= ${inicio} OR ch.fechado_em IS NULL OR ch.fechado_em >= ${fim})
        ORDER BY ch.created_at`;
    } catch (e) {
      // Tabela de chamados ainda não criada (SQL 2026-10-20c): relatório sai sem o bloco.
      this.logger.warn(`[relatorio-operacao] chamados indisponíveis: ${(e as Error)?.message}`);
      return { linhas: [], bloco: [] };
    }
    const lib = ctx.eqScope ? new Set(ctx.eqScope) : null;
    const so = soEquipamentos ? new Set(soEquipamentos) : null;
    linhas = linhas.filter((c) => {
      const eq = c.equipamento_id?.trim() ?? '';
      if (lib && !lib.has(eq)) return false;
      if (so && !so.has(eq)) return false;
      return true;
    });
    if (!linhas.length) return { linhas, bloco: [] };
    const encs = await this.prisma.$queryRaw<LinhaEncaminhamento[]>`
      SELECT TRIM(chamado_id) AS chamado_id, destino, contato, status, referencia_externa
      FROM chamados_encaminhamentos WHERE chamado_id = ANY(${linhas.map((l) => l.id)}::text[]) ORDER BY created_at`;
    return { linhas, bloco: montarChamados(linhas, encs) };
  }

  // ───────────────────────── Alarmes ─────────────────────────

  /** Alarmes (logs_mqtt tipo 'alerta') dos equipamentos que se sobrepõem ao período. */
  async alertas(ids: string[], ini: Date, fim: Date): Promise<AlertaEquipamento[]> {
    if (!ids.length) return [];
    return this.prisma.$queryRaw<AlertaEquipamento[]>`
      SELECT TRIM(l.equipamento_id) AS equipamento_id, l.created_at, l.resolvido_em, l.mensagem,
             TRIM(r.nome) AS regra, l.severidade, l.dados_snapshot->>'origem' AS origem,
             l.dados_snapshot->>'desde' AS desde, l.dados_snapshot->>'volta_em' AS volta_em,
             l.dados_snapshot->'afetados' AS afetados
      FROM logs_mqtt l
      LEFT JOIN regras_logs_mqtt r ON r.id = l.regra_id
      WHERE l.tipo = 'alerta' AND l.equipamento_id = ANY(${ids}::bpchar[])
        AND l.created_at < ${fim} AND (l.resolvido_em IS NULL OR l.resolvido_em >= ${ini})
      ORDER BY l.created_at`;
  }

  /**
   * Intervalos sem comunicação de cada equipamento: alarme de comunicação dele, ou da TON/
   * gateway da mesma instalação que o cita em `afetados` (causa-raiz). Início = última
   * leitura (`desde`); fim = volta da leitura (`volta_em`), resolução, ou fim do período.
   */
  async semComunicacao(ctx: ContextoRelatorio, alvos: Array<{ id: string; nome: string }>): Promise<Map<string, Intervalo[]>> {
    const out = new Map<string, Intervalo[]>(alvos.map((a) => [a.id, []]));
    if (!alvos.length) return out;
    const { inicio, fim } = ctx.periodo;
    let rows: AlertaEquipamento[] = [];
    try {
      rows = await this.prisma.$queryRaw<AlertaEquipamento[]>`
        SELECT TRIM(l.equipamento_id) AS equipamento_id, l.created_at, l.resolvido_em, l.mensagem, NULL AS regra,
               l.severidade, 'comunicacao' AS origem, l.dados_snapshot->>'desde' AS desde,
               l.dados_snapshot->>'volta_em' AS volta_em, l.dados_snapshot->'afetados' AS afetados
        FROM logs_mqtt l
        JOIN equipamentos e ON e.id = l.equipamento_id
        WHERE l.tipo = 'alerta' AND (l.dados_snapshot->>'origem') = 'comunicacao'
          AND e.unidade_id = ${ctx.unidade.id}::bpchar
          AND l.created_at < ${fim} AND (l.resolvido_em IS NULL OR l.resolvido_em >= ${inicio})`;
    } catch (e) {
      this.logger.warn(`[relatorio-operacao] alarmes de comunicação indisponíveis: ${(e as Error)?.message}`);
      return out;
    }
    const porNome = new Map<string, string[]>();
    for (const a of alvos) porNome.set(a.nome.trim().toLowerCase(), [...(porNome.get(a.nome.trim().toLowerCase()) ?? []), a.id]);
    for (const r of rows) {
      const ini = r.desde ? Date.parse(r.desde) : new Date(r.created_at).getTime();
      const volta = r.volta_em ? Date.parse(r.volta_em) : null;
      const f = volta ?? (r.resolvido_em ? new Date(r.resolvido_em).getTime() : fim.getTime());
      const intervalo = { ini: Number.isFinite(ini) ? ini : new Date(r.created_at).getTime(), fim: f };
      const destinos = new Set<string>();
      if (out.has(r.equipamento_id)) destinos.add(r.equipamento_id);
      if (Array.isArray(r.afetados)) {
        for (const n of r.afetados) for (const id of porNome.get(String(n).trim().toLowerCase()) ?? []) destinos.add(id);
      }
      for (const id of destinos) out.get(id)!.push(intervalo);
    }
    return out;
  }

  // ───────────────────────── Medição ─────────────────────────

  /**
   * Fontes de medição da instalação: device (PM/medidor) ligado pelo IoT a um disjuntor ou ao
   * medidor da concessionária (`iot_componentes.props.disjuntor_equipamento_id`) e a carga
   * (pivô, motor, carga, carregador) ligada a esse disjuntor no unifilar.
   */
  async fontesDeMedicao(unidadeId: string): Promise<FonteMedicao[]> {
    try {
      return await this.prisma.$queryRaw<FonteMedicao[]>`
        SELECT DISTINCT ON (TRIM(ic.props->>'equipamento_id'), dj.id)
               TRIM(ic.props->>'equipamento_id') AS fonte_id, TRIM(fe.nome) AS fonte_nome, TRIM(dj.id) AS dj_id, TRIM(dj.nome) AS dj_nome,
               carga.id AS carga_id, carga.nome AS carga_nome, carga.codigo AS carga_codigo
        FROM equipamentos dj
        JOIN iot_componentes ic ON ic.props->>'disjuntor_equipamento_id' = TRIM(dj.id)
          AND COALESCE(ic.props->>'equipamento_id', '') <> ''
        LEFT JOIN equipamentos fe ON fe.id = TRIM(ic.props->>'equipamento_id')::bpchar
        LEFT JOIN LATERAL (
          SELECT TRIM(o.id) AS id, TRIM(o.nome) AS nome, t2.codigo
          FROM equipamentos_conexoes cx
          JOIN equipamentos o ON o.id = CASE WHEN cx.equipamento_origem_id = dj.id THEN cx.equipamento_destino_id ELSE cx.equipamento_origem_id END
          LEFT JOIN tipos_equipamentos t2 ON t2.id = o.tipo_equipamento_id
          WHERE cx.deleted_at IS NULL AND (cx.equipamento_origem_id = dj.id OR cx.equipamento_destino_id = dj.id)
            AND o.deleted_at IS NULL AND t2.codigo IN ('PIVO', 'MOTOR', 'CARGA', 'CARREGADOR_ELETRICO')
          ORDER BY (t2.codigo = 'PIVO') DESC, TRIM(o.nome) LIMIT 1
        ) carga ON TRUE
        WHERE dj.unidade_id = ${unidadeId}::bpchar AND dj.deleted_at IS NULL
        ORDER BY TRIM(ic.props->>'equipamento_id'), dj.id`;
    } catch (e) {
      this.logger.warn(`[relatorio-operacao] fontes de medição: ${(e as Error)?.message}`);
      return [];
    }
  }

  /**
   * Medidor da instalação (quem publica a leitura): 1) o primeiro de
   * configuracao_demanda.equipamentos_ids; 2) o medidor da concessionária; 3) Power Meter que
   * não mede um pivô/carga. Medidor desenhado no unifilar que não publica (DJ/EQTL) vira o
   * device ligado a ele no IoT. Fica o que tem leitura mais recente; nenhum com leitura → null.
   * Operador: só entre os medidores liberados para ele.
   */
  async medidorDaInstalacao(ctx: ContextoRelatorio, candidatosVisiveis: Array<{ id: string; nome: string; codigo: string | null }>): Promise<{ id: string; nome: string } | null> {
    const fontes = await this.fontesDeMedicao(ctx.unidade.id);
    const fonteDe = (id: string) => fontes.find((f) => f.dj_id === id)?.fonte_id ?? id;
    const deCarga = new Set(fontes.filter((f) => f.carga_id).map((f) => f.fonte_id));

    let configurado: string | null = null;
    try {
      const [cfg] = await this.prisma.$queryRaw<Array<{ ids: unknown }>>`
        SELECT equipamentos_ids AS ids FROM configuracao_demanda WHERE unidade_id = ${ctx.unidade.id}::bpchar LIMIT 1`;
      const arr: unknown[] = Array.isArray(cfg?.ids) ? (cfg?.ids as unknown[]) : typeof cfg?.ids === 'string' ? JSON.parse(cfg.ids || '[]') : [];
      configurado = arr.length ? String(arr[0]).trim() : null;
    } catch {
      configurado = null;
    }
    const lib = ctx.eqScope ? new Set(ctx.eqScope) : null;

    const ordem: Array<{ id: string; nome: string }> = [];
    if (configurado && (!lib || lib.has(configurado))) {
      const nome = candidatosVisiveis.find((c) => c.id === configurado)?.nome ?? 'Medidor';
      ordem.push({ id: fonteDe(configurado), nome });
    }
    const peso = (c: { codigo: string | null }) => (c.codigo === 'EQTL001' ? 0 : 1);
    for (const c of [...candidatosVisiveis].sort((a, b) => peso(a) - peso(b))) {
      const fid = fonteDe(c.id);
      if (deCarga.has(fid)) continue;
      if (!ordem.some((o) => o.id === fid)) ordem.push({ id: fid, nome: c.nome });
    }
    if (!ordem.length) return null;
    const ultimas = await this.ultimaLeitura(ordem.map((o) => o.id));
    // Configurado com leitura ganha; depois concessionária; depois o de leitura mais recente.
    if (configurado && ordem[0].id === fonteDe(configurado) && ultimas.has(ordem[0].id)) return ordem[0];
    const comLeitura = ordem.filter((o) => ultimas.has(o.id));
    const eqtl = comLeitura.find((o) => candidatosVisiveis.some((c) => c.codigo === 'EQTL001' && fonteDe(c.id) === o.id));
    if (eqtl) return eqtl;
    comLeitura.sort((a, b) => (ultimas.get(b.id)?.getTime() ?? 0) - (ultimas.get(a.id)?.getTime() ?? 0));
    return comLeitura[0] ?? null;
  }

  /** Blocos de 15 min do medidor no período (mesma leitura do resumo do medidor: SSU ou PM). */
  async blocos(medidorId: string, ini: Date, fim: Date): Promise<Bloco[]> {
    const b = await this.medidor.blocos(medidorId, ini, fim);
    return b.map(({ t, kWc, kWi, kvarInd, kvarCap }) => ({ t, kWc, kWi, kvarInd, kvarCap }));
  }

  /** Último instante com leitura de cada equipamento (só para escolher o medidor). */
  async ultimaLeitura(ids: string[]): Promise<Map<string, Date>> {
    if (!ids.length) return new Map();
    const rows = await this.prisma.$queryRaw<Array<{ id: string; ultima: Date | null }>>`
      SELECT TRIM(i.id) AS id, x.ultima
      FROM unnest(${ids}::bpchar[]) AS i(id)
      CROSS JOIN LATERAL (
        SELECT d.timestamp_dados AS ultima FROM equipamentos_dados d
        WHERE d.equipamento_id = i.id ORDER BY d.timestamp_dados DESC LIMIT 1
      ) x`;
    return new Map(rows.filter((r) => r.ultima).map((r) => [r.id, new Date(r.ultima as Date)]));
  }

  // ───────────────────────── Posto e calendário ─────────────────────────

  /**
   * Posto tarifário do bloco (t = fim da janela de 15 min), pelas mesmas regras do
   * ClassificacaoHorariosService (ponta 18–21, reservado 21:30–06:00, irrigante HR no fim de
   * semana/feriado). Ele lê a hora de Brasília nos campos UTC; aqui o instante é UTC de
   * verdade, então desloca −3 h antes de classificar.
   */
  classificadorDePosto(unidade: UnidadeRelatorio): (t: number) => Posto {
    const dados = {
      id: unidade.id,
      nome: unidade.nome,
      grupo: String(unidade.grupo ?? 'A'),
      subgrupo: String(unidade.subgrupo ?? ''),
      irrigante: unidade.irrigante,
      concessionaria_id: unidade.concessionaria_id ?? '',
    };
    return (t: number) => {
      const local = new Date(t - 60_000 - 3 * 3_600_000);
      const c = this.classificacao.classificar(local, dados, {});
      if (c.tipo === TipoHorario.PONTA) return 'ponta';
      if (c.tipo === TipoHorario.RESERVADO || c.tipo === TipoHorario.IRRIGANTE) return 'reservado';
      return 'foraPonta';
    };
  }

  /** Dia útil = segunda a sexta sem feriado nacional. */
  ehDiaUtil(dia: string): boolean {
    if (diaSemanaIso(dia) > 5) return false;
    const [a, m, d] = dia.split('-').map(Number);
    return !this.feriados.isFeriadoNacional(new Date(Date.UTC(a, m - 1, d, 12)));
  }
}
