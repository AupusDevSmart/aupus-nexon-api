import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { novoId26 } from '../../common/cliente-info';
import { PermissionScopeService } from '../auth/permission-scope.service';
import { capacidades, papelCanonico } from '../auth/papeis';
import { hojeSP, validadeDe } from '../../../modules/carregador-eletrico/carregador.util';
import { AuditoriaAcessosService } from './auditoria-acessos.service';
import { Requisitante, UsuariosService } from './usuarios.service';
import {
  comInversoresDaGeracao,
  diffVinculo,
  ehNovo,
  EstadoVinculo,
  ItemVinculo,
  resumoVinculo,
  TIPOS_COM_VER_RS,
  TIPOS_FORA_DA_ARVORE,
} from './vinculos-operador.util';

export interface SalvarVinculoDto {
  proprietarioId?: string;
  /** 'YYYY-MM-DD' (último dia que vale) ou null. */
  validade?: string | null;
  equipamentos?: Array<{ id: string; verRs?: boolean }>;
  unidadesGeracao?: string[];
}

interface LinhaVinculo {
  id: string;
  proprietario_id: string;
  proprietario_nome: string | null;
  validade: Date | string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Vínculos do operador (spec NEXON-20, seção 4): um por proprietário, com a
 * lista explícita de equipamentos liberados, "Ver R$" por equipamento, "Ver
 * geração" por instalação e validade opcional.
 *
 * - Quem edita: Admin, analistas (escolhem o proprietário) e o Proprietário (só
 *   o próprio vínculo, só equipamentos das próprias plantas) — PER-21b/PER-17.
 * - Remover um vínculo não mexe nos outros (PER-18). Operador sem vínculo ativo
 *   fica desativado e volta ao receber um (PER-19/20).
 * - Toda gravação vai para auditoria_acessos com o que entrou e o que saiu (PER-42).
 */
@Injectable()
export class VinculosOperadorService {
  private readonly logger = new Logger(VinculosOperadorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly usuarios: UsuariosService,
    private readonly scope: PermissionScopeService,
    private readonly auditoria: AuditoriaAcessosService,
  ) {}

  // ==========================================================================
  // Leitura
  // ==========================================================================

  async listar(operadorId: string, req: Requisitante) {
    const operador = await this.carregarOperador(operadorId, req);
    const soMeu = papelCanonico(req.role) === 'proprietario' ? req.id!.trim() : null;
    const vinculos = await this.prisma.$queryRaw<LinhaVinculo[]>`
      SELECT TRIM(v.id) AS id, TRIM(v.proprietario_id) AS proprietario_id, p.nome AS proprietario_nome,
             v.validade, v.created_at, v.updated_at
      FROM operador_vinculos v
      LEFT JOIN usuarios p ON p.id = v.proprietario_id
      WHERE v.operador_id = ${operador.id}::bpchar AND v.removido_em IS NULL
        AND (${soMeu}::text IS NULL OR TRIM(v.proprietario_id) = ${soMeu})
      ORDER BY p.nome`;
    const ids = vinculos.map((v) => v.id);
    const [itens, geracao] = ids.length
      ? await Promise.all([
          this.prisma.$queryRaw<Array<{ vinculo_id: string; equipamento_id: string; ver_rs: boolean; codigo: string | null }>>`
            SELECT TRIM(ve.vinculo_id) AS vinculo_id, TRIM(ve.equipamento_id) AS equipamento_id, ve.ver_rs, t.codigo
            FROM operador_vinculo_equipamentos ve
            JOIN equipamentos e ON e.id = ve.equipamento_id AND e.deleted_at IS NULL
            LEFT JOIN tipos_equipamentos t ON t.id = e.tipo_equipamento_id
            WHERE TRIM(ve.vinculo_id) = ANY(${ids}::text[])`,
          this.prisma.$queryRaw<Array<{ vinculo_id: string; unidade_id: string }>>`
            SELECT TRIM(vinculo_id) AS vinculo_id, TRIM(unidade_id) AS unidade_id
            FROM operador_vinculo_unidades WHERE ver_geracao AND TRIM(vinculo_id) = ANY(${ids}::text[])`,
        ])
      : [[], []];
    const hoje = hojeSP();
    return {
      operador,
      vinculos: vinculos.map((v) => {
        const meus = itens.filter((i) => i.vinculo_id === v.id);
        const ger = geracao.filter((g) => g.vinculo_id === v.id).map((g) => g.unidade_id);
        const validade = v.validade ? new Date(v.validade).toISOString().slice(0, 10) : null;
        return {
          id: v.id,
          proprietario: { id: v.proprietario_id, nome: v.proprietario_nome },
          validade,
          vencido: !!validade && validade < hoje,
          equipamentos: meus.map((i) => ({ id: i.equipamento_id, verRs: i.ver_rs })),
          unidadesGeracao: ger,
          resumo: resumoVinculo(meus.map((i) => i.codigo ?? ''), ger.length),
          criado_em: v.created_at,
          atualizado_em: v.updated_at,
        };
      }),
    };
  }

  /**
   * Árvore Planta → Instalação → Equipamentos do proprietário, marcada com o
   * que o operador já tem nesse vínculo (tela "Acesso do operador").
   */
  async arvore(operadorId: string, proprietarioIdPedido: string | undefined, req: Requisitante) {
    const operador = await this.carregarOperador(operadorId, req);
    const proprietarioId = this.proprietarioDoVinculo(proprietarioIdPedido, req);
    const prop = await this.prisma.usuarios.findFirst({
      where: { id: proprietarioId, deleted_at: null },
      select: { id: true, nome: true },
    });
    if (!prop) throw new NotFoundException('Proprietário não encontrado');

    const atual = await this.estadoAtual(operador.id, proprietarioId);
    const liberados = new Map((atual?.estado.equipamentos ?? []).map((e) => [e.equipamentoId, e.verRs]));
    const geracao = new Set(atual?.estado.unidadesGeracao ?? []);

    const linhas = await this.prisma.$queryRaw<Array<{
      planta_id: string; planta_nome: string; unidade_id: string | null; unidade_nome: string | null;
      tipo_unidade: string | null; equipamento_id: string; equipamento_nome: string; codigo: string | null;
      tipo_nome: string | null; created_at: Date | null;
    }>>`
      SELECT TRIM(p.id) AS planta_id, p.nome AS planta_nome, TRIM(u.id) AS unidade_id, u.nome AS unidade_nome,
             u.tipo_unidade, TRIM(e.id) AS equipamento_id, e.nome AS equipamento_nome, t.codigo, t.nome AS tipo_nome,
             e.created_at
      FROM equipamentos e
      LEFT JOIN unidades u ON u.id = e.unidade_id AND u.deleted_at IS NULL
      JOIN plantas p ON p.id = COALESCE(e.planta_id, u.planta_id) AND p.deleted_at IS NULL
      LEFT JOIN tipos_equipamentos t ON t.id = e.tipo_equipamento_id
      WHERE p.proprietario_id = ${proprietarioId}::bpchar
        AND e.deleted_at IS NULL AND e.equipamento_pai_id IS NULL
        AND (t.codigo IS NULL OR NOT (t.codigo = ANY(${[...TIPOS_FORA_DA_ARVORE]}::text[])))
      ORDER BY p.nome, u.nome NULLS LAST, t.codigo NULLS LAST, e.nome`;

    const plantas = new Map<string, { id: string; nome: string; unidades: Map<string, any> }>();
    for (const l of linhas) {
      let p = plantas.get(l.planta_id);
      if (!p) plantas.set(l.planta_id, (p = { id: l.planta_id, nome: l.planta_nome, unidades: new Map() }));
      const uid = l.unidade_id ?? `sem-instalacao:${l.planta_id}`;
      let u = p.unidades.get(uid);
      if (!u) {
        p.unidades.set(uid, (u = {
          id: l.unidade_id, nome: l.unidade_nome ?? 'Sem instalação', tipo_unidade: l.tipo_unidade,
          tem_usina: false, ver_geracao: !!l.unidade_id && geracao.has(l.unidade_id), equipamentos: [] as any[],
        }));
      }
      const liberado = liberados.has(l.equipamento_id);
      if (l.codigo === 'INVERSOR') u.tem_usina = true;
      u.equipamentos.push({
        id: l.equipamento_id,
        nome: l.equipamento_nome,
        tipo_codigo: l.codigo,
        tipo_nome: l.tipo_nome,
        liberado,
        ver_rs: liberados.get(l.equipamento_id) ?? false,
        aceita_ver_rs: TIPOS_COM_VER_RS.includes(l.codigo ?? ''),
        novo: ehNovo(l.created_at, liberado),
      });
    }

    return {
      operador,
      proprietario: { id: prop.id.trim(), nome: prop.nome },
      vinculo: atual ? { id: atual.id, validade: atual.estado.validade } : null,
      plantas: [...plantas.values()].map((p) => ({ id: p.id, nome: p.nome, unidades: [...p.unidades.values()] })),
    };
  }

  // ==========================================================================
  // Gravação
  // ==========================================================================

  async salvar(operadorId: string, dto: SalvarVinculoDto, req: Requisitante, dispositivo?: string | null) {
    const operador = await this.carregarOperador(operadorId, req, true);
    const proprietarioId = this.proprietarioDoVinculo(dto.proprietarioId, req);

    const validade = validadeDe(dto.validade);
    if (validade === undefined) throw new BadRequestException('Validade inválida (use AAAA-MM-DD)');
    if (validade && validade < hojeSP()) throw new BadRequestException('A validade não pode estar no passado');

    // Só equipamentos e instalações das plantas desse proprietário (PER-17).
    const pedidos = new Map<string, boolean>();
    for (const e of dto.equipamentos ?? []) if (e?.id?.trim()) pedidos.set(e.id.trim(), !!e.verRs);
    const unidadesPedidas = [...new Set((dto.unidadesGeracao ?? []).map((u) => u?.trim()).filter(Boolean))] as string[];

    const doDono = await this.prisma.$queryRaw<Array<{ id: string; unidade_id: string | null; planta_id: string; codigo: string | null }>>`
      SELECT TRIM(e.id) AS id, TRIM(e.unidade_id) AS unidade_id, TRIM(p.id) AS planta_id, t.codigo
      FROM equipamentos e
      LEFT JOIN unidades u ON u.id = e.unidade_id
      JOIN plantas p ON p.id = COALESCE(e.planta_id, u.planta_id) AND p.deleted_at IS NULL
      LEFT JOIN tipos_equipamentos t ON t.id = e.tipo_equipamento_id
      WHERE p.proprietario_id = ${proprietarioId}::bpchar AND e.deleted_at IS NULL`;
    const porId = new Map(doDono.map((e) => [e.id, e]));
    const fora = [...pedidos.keys()].filter((id) => !porId.has(id));
    if (fora.length) throw new ForbiddenException('Equipamento fora das plantas deste proprietário');

    const inversoresPorUnidade = new Map<string, string[]>();
    for (const e of doDono) {
      if (e.codigo === 'INVERSOR' && e.unidade_id) {
        inversoresPorUnidade.set(e.unidade_id, [...(inversoresPorUnidade.get(e.unidade_id) ?? []), e.id]);
      }
    }
    const semUsina = unidadesPedidas.filter((u) => !inversoresPorUnidade.has(u));
    if (semUsina.length) throw new BadRequestException('"Ver geração" só vale em instalação com usina');

    const itens: ItemVinculo[] = comInversoresDaGeracao(
      [...pedidos].map(([equipamentoId, verRs]) => ({
        equipamentoId,
        verRs: verRs && TIPOS_COM_VER_RS.includes(porId.get(equipamentoId)?.codigo ?? ''),
      })),
      unidadesPedidas,
      inversoresPorUnidade,
    );
    const novo: EstadoVinculo = { validade, equipamentos: itens, unidadesGeracao: unidadesPedidas };
    const atual = await this.estadoAtual(operador.id, proprietarioId);
    const diff = diffVinculo(atual?.estado ?? null, novo);

    if (itens.length === 0) {
      if (atual) await this.remover(operador.id, proprietarioId, req, dispositivo);
      return this.listar(operador.id, req);
    }
    if (atual && !diff.mudou) return this.listar(operador.id, req);

    const autor = req.id?.trim() ?? null;
    const vinculoId = atual?.id ?? novoId26();
    await this.prisma.$transaction(async (tx) => {
      if (atual) {
        await tx.$executeRaw`
          UPDATE operador_vinculos SET validade = ${validade}::date, atualizado_por = ${autor}, updated_at = now()
          WHERE id = ${vinculoId}::bpchar`;
        await tx.$executeRaw`DELETE FROM operador_vinculo_equipamentos WHERE vinculo_id = ${vinculoId}::bpchar`;
        await tx.$executeRaw`DELETE FROM operador_vinculo_unidades WHERE vinculo_id = ${vinculoId}::bpchar`;
      } else {
        await tx.$executeRaw`
          INSERT INTO operador_vinculos (id, operador_id, proprietario_id, validade, criado_por, atualizado_por)
          VALUES (${vinculoId}, ${operador.id}, ${proprietarioId}, ${validade}::date, ${autor}, ${autor})`;
      }
      for (const i of itens) {
        await tx.$executeRaw`
          INSERT INTO operador_vinculo_equipamentos (vinculo_id, equipamento_id, ver_rs)
          VALUES (${vinculoId}, ${i.equipamentoId}, ${i.verRs})`;
      }
      for (const u of unidadesPedidas) {
        await tx.$executeRaw`
          INSERT INTO operador_vinculo_unidades (vinculo_id, unidade_id, ver_geracao)
          VALUES (${vinculoId}, ${u}, true)`;
      }
    });
    this.scope.invalidarAcesso(operador.id);

    const plantas = [...new Set(itens.map((i) => porId.get(i.equipamentoId)?.planta_id).filter(Boolean))] as string[];
    const unidades = [...new Set(itens.map((i) => porId.get(i.equipamentoId)?.unidade_id).filter(Boolean))] as string[];
    const nomeProp = (await this.prisma.usuarios.findFirst({ where: { id: proprietarioId }, select: { nome: true } }))?.nome;
    await this.auditoria.registrar({
      autorId: autor,
      autorNome: req.nome ?? null,
      alvoUsuarioId: operador.id,
      alvoNome: operador.nome,
      acao: atual ? 'vinculo_alterado' : 'vinculo_criado',
      mensagem: `${atual ? 'Acesso alterado' : 'Acesso criado'}: ${operador.nome} × ${nomeProp ?? proprietarioId} — `
        + `${resumoVinculo(itens.map((i) => porId.get(i.equipamentoId)?.codigo ?? ''), unidadesPedidas.length)}`
        + (diff.entram.length || diff.saem.length ? ` (+${diff.entram.length} / −${diff.saem.length})` : ''),
      detalhes: { proprietario_id: proprietarioId, proprietario_nome: nomeProp ?? null, ...diff },
      plantaIds: plantas,
      unidadeIds: unidades,
      dispositivo: dispositivo ?? null,
      objetoTipo: 'vinculo',
      objetoId: vinculoId,
    });
    await this.ajustarAtivacao(operador.id, req);
    return this.listar(operador.id, req);
  }

  /** Remove o vínculo deste proprietário; os outros continuam (PER-18). */
  async remover(operadorId: string, proprietarioIdPedido: string | undefined, req: Requisitante, dispositivo?: string | null) {
    const operador = await this.carregarOperador(operadorId, req, true);
    const proprietarioId = this.proprietarioDoVinculo(proprietarioIdPedido, req);
    const atual = await this.estadoAtual(operador.id, proprietarioId);
    if (!atual) throw new NotFoundException('Vínculo não encontrado');
    await this.prisma.$executeRaw`
      UPDATE operador_vinculos SET removido_em = now(), removido_por = ${req.id?.trim() ?? null}, updated_at = now()
      WHERE id = ${atual.id}::bpchar`;
    this.scope.invalidarAcesso(operador.id);
    const nomeProp = (await this.prisma.usuarios.findFirst({ where: { id: proprietarioId }, select: { nome: true } }))?.nome;
    await this.auditoria.registrar({
      autorId: req.id ?? null,
      autorNome: req.nome ?? null,
      alvoUsuarioId: operador.id,
      alvoNome: operador.nome,
      acao: 'vinculo_removido',
      mensagem: `Acesso removido: ${operador.nome} × ${nomeProp ?? proprietarioId} (${atual.estado.equipamentos.length} equipamentos)`,
      detalhes: { proprietario_id: proprietarioId, proprietario_nome: nomeProp ?? null, antes: atual.estado },
      dispositivo: dispositivo ?? null,
      objetoTipo: 'vinculo',
      objetoId: atual.id,
    });
    await this.ajustarAtivacao(operador.id, req);
    return this.listar(operador.id, req);
  }

  /**
   * Atalho do vínculo por planta (legado `/plantas/:id/operadores`): liberar ou
   * retirar TODOS os equipamentos da planta no vínculo com o dono dela.
   */
  async planta(operadorId: string, plantaId: string, liberar: boolean, req: Requisitante) {
    const [p] = await this.prisma.$queryRaw<Array<{ id: string; proprietario_id: string | null }>>`
      SELECT TRIM(id) AS id, TRIM(proprietario_id) AS proprietario_id FROM plantas
      WHERE id = ${plantaId.trim()}::bpchar AND deleted_at IS NULL`;
    if (!p) throw new NotFoundException('Planta nao encontrada');
    if (!p.proprietario_id) throw new BadRequestException('Planta sem proprietário');
    if (papelCanonico(req.role) === 'proprietario' && p.proprietario_id !== req.id?.trim()) {
      throw new ForbiddenException('Voce so pode gerenciar operadores das suas proprias plantas');
    }
    const daPlanta = (await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT TRIM(e.id) AS id FROM equipamentos e LEFT JOIN unidades u ON u.id = e.unidade_id
      WHERE e.deleted_at IS NULL AND e.equipamento_pai_id IS NULL
        AND COALESCE(e.planta_id, u.planta_id) = ${p.id}::bpchar`).map((r) => r.id);
    const atual = await this.estadoAtual(operadorId.trim(), p.proprietario_id);
    const set = new Map((atual?.estado.equipamentos ?? []).map((e) => [e.equipamentoId, e.verRs]));
    if (liberar) daPlanta.forEach((id) => { if (!set.has(id)) set.set(id, false); });
    else daPlanta.forEach((id) => set.delete(id));
    const unidadesDaPlanta = new Set((await this.prisma.unidades.findMany({
      where: { planta_id: p.id, deleted_at: null }, select: { id: true },
    })).map((u) => u.id.trim()));
    return this.salvar(operadorId, {
      proprietarioId: p.proprietario_id,
      validade: atual?.estado.validade ?? null,
      equipamentos: [...set].map(([id, verRs]) => ({ id, verRs })),
      unidadesGeracao: (atual?.estado.unidadesGeracao ?? []).filter((u) => liberar || !unidadesDaPlanta.has(u)),
    }, req);
  }

  /**
   * Ponte do acesso por instalação dos apps (`PUT /usuarios/:id/acesso`,
   * convite): as instalações escolhidas viram vínculo com o dono de cada planta,
   * com todos os equipamentos raiz delas e "Ver geração" onde há usina. Substitui
   * o que o requisitante alcança: o proprietário, o próprio vínculo; a equipe
   * Aupus, todos (vínculo de dono sem instalação escolhida sai).
   */
  async porInstalacoes(operadorId: string, unidadeIds: string[], req: Requisitante, dispositivo?: string | null) {
    const ids = [...new Set(unidadeIds.map((u) => u.trim()).filter(Boolean))];
    const linhas = ids.length ? await this.prisma.$queryRaw<Array<{ id: string; unidade_id: string; proprietario_id: string | null; codigo: string | null }>>`
      SELECT TRIM(e.id) AS id, TRIM(u.id) AS unidade_id, TRIM(p.proprietario_id) AS proprietario_id, t.codigo
      FROM unidades u
      JOIN plantas p ON p.id = u.planta_id AND p.deleted_at IS NULL
      JOIN equipamentos e ON e.unidade_id = u.id AND e.deleted_at IS NULL AND e.equipamento_pai_id IS NULL
      LEFT JOIN tipos_equipamentos t ON t.id = e.tipo_equipamento_id
      WHERE TRIM(u.id) = ANY(${ids}::text[]) AND u.deleted_at IS NULL` : [];
    const porDono = new Map<string, { eqs: string[]; usinas: Set<string> }>();
    for (const l of linhas) {
      if (!l.proprietario_id) continue;
      const g = porDono.get(l.proprietario_id) ?? { eqs: [], usinas: new Set<string>() };
      g.eqs.push(l.id);
      if (l.codigo === 'INVERSOR') g.usinas.add(l.unidade_id);
      porDono.set(l.proprietario_id, g);
    }
    const proprietario = papelCanonico(req.role) === 'proprietario' ? req.id!.trim() : null;
    const atuais = (await this.listar(operadorId, req).catch(() => null))?.vinculos ?? [];
    const donos = proprietario ? [proprietario] : [...new Set([...porDono.keys(), ...atuais.map((v) => v.proprietario.id)])];
    for (const dono of donos) {
      const g = porDono.get(dono);
      const validade = atuais.find((v) => v.proprietario.id === dono)?.validade ?? null;
      await this.salvar(operadorId, {
        proprietarioId: dono,
        validade,
        equipamentos: (g?.eqs ?? []).map((id) => ({ id, verRs: false })),
        unidadesGeracao: [...(g?.usinas ?? [])],
      }, req, dispositivo);
    }
  }

  // ==========================================================================
  // Ciclo de vida (PER-19/20)
  // ==========================================================================

  /**
   * Operador sem vínculo ativo → desativado (preservado para histórico);
   * recebeu vínculo → ativo de novo. Só mexe em operador.
   */
  async ajustarAtivacao(operadorId: string, req?: Requisitante | null): Promise<void> {
    const id = operadorId.trim();
    const [r] = await this.prisma.$queryRaw<Array<{ ativos: number; status: string; nome: string; role: string | null }>>`
      SELECT (SELECT COUNT(*) FROM operador_vinculos v
               WHERE v.operador_id = u.id AND v.removido_em IS NULL
                 AND (v.validade IS NULL OR v.validade >= (now() AT TIME ZONE 'America/Sao_Paulo')::date))::int AS ativos,
             u.status, u.nome, u.role
      FROM usuarios u WHERE u.id = ${id}::bpchar AND u.deleted_at IS NULL`;
    if (!r || papelCanonico(r.role) !== 'operador') return;
    const deveAtivo = Number(r.ativos) > 0;
    const esta = r.status === 'Ativo';
    if (deveAtivo === esta) return;
    // Quem a equipe desativou à mão não volta sozinho com um vínculo novo: só o
    // desligamento automático (sem vínculo) é desfeito automaticamente (PER-19).
    if (deveAtivo) {
      const [ultima] = await this.prisma.$queryRaw<Array<{ acao: string }>>`
        SELECT acao FROM auditoria_acessos
        WHERE alvo_usuario_id = ${id}::bpchar AND acao IN ('usuario_desativado', 'operador_desativado')
        ORDER BY created_at DESC LIMIT 1`.catch(() => [] as Array<{ acao: string }>);
      if (ultima?.acao === 'usuario_desativado') return;
    }
    await this.prisma.usuarios.update({
      where: { id },
      data: { status: deveAtivo ? 'Ativo' : 'Inativo', updated_at: new Date() },
    });
    await this.auditoria.registrar({
      autorId: req?.id ?? null,
      autorNome: req?.nome ?? (req ? null : 'Sistema'),
      alvoUsuarioId: id,
      alvoNome: r.nome,
      acao: deveAtivo ? 'operador_reativado' : 'operador_desativado',
      mensagem: deveAtivo
        ? `${r.nome} reativado: recebeu acesso`
        : `${r.nome} desativado: ficou sem nenhum acesso ativo`,
      detalhes: { antes: r.status, depois: deveAtivo ? 'Ativo' : 'Inativo', vinculos_ativos: Number(r.ativos) },
      objetoTipo: 'usuario',
      objetoId: id,
    });
  }

  /** Vínculo vencido conta como removido (PER-20): desativa quem ficou sem nenhum. */
  @Cron('15 * * * *', { name: 'vinculos-operador-validade', timeZone: 'America/Sao_Paulo' })
  async expirarVencidos(): Promise<void> {
    try {
      const ids = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT DISTINCT TRIM(u.id) AS id
        FROM usuarios u
        JOIN operador_vinculos v ON v.operador_id = u.id
        WHERE u.deleted_at IS NULL AND u.status = 'Ativo' AND u.role = 'operador'
          AND NOT EXISTS (
            SELECT 1 FROM operador_vinculos a WHERE a.operador_id = u.id AND a.removido_em IS NULL
              AND (a.validade IS NULL OR a.validade >= (now() AT TIME ZONE 'America/Sao_Paulo')::date))`;
      for (const { id } of ids) {
        await this.ajustarAtivacao(id, null);
        this.scope.invalidarAcesso(id);
      }
      if (ids.length) this.logger.log(`[vinculos] ${ids.length} operador(es) desativado(s) por validade vencida`);
    } catch (e) {
      if (!/operador_vinculo/.test((e as Error).message ?? '')) this.logger.warn(`[vinculos] expirar: ${(e as Error).message}`);
    }
  }

  // ==========================================================================
  // Apoio
  // ==========================================================================

  private async carregarOperador(operadorId: string, req: Requisitante, gravando = false) {
    if (!capacidades(papelCanonico(req.role)).gerirAcessoOperador) {
      throw new ForbiddenException('Seu perfil não define acesso de operador');
    }
    const id = operadorId?.trim();
    const u = id ? await this.prisma.usuarios.findFirst({
      where: { id, deleted_at: null },
      select: { id: true, nome: true, email: true, telefone: true, status: true },
    }) : null;
    if (!u) throw new NotFoundException('Usuário não encontrado');
    const { papel } = await this.usuarios.papelDoUsuario(u.id);
    if (papel !== 'operador') throw new BadRequestException('Acesso por equipamento é só para Operador');
    // Proprietário lê o acesso de operador ligado a ele; grava em qualquer
    // operador, mas só com equipamentos dele (o vínculo dele).
    if (!gravando && papelCanonico(req.role) === 'proprietario'
        && !(await this.usuarios.operadorLigadoAo(u.id, req.id!))) {
      throw new ForbiddenException('Usuário fora do escopo');
    }
    return { id: u.id.trim(), nome: u.nome, email: u.email, telefone: u.telefone, status: u.status };
  }

  /** Proprietário do vínculo: o próprio, para Proprietário; o informado, para analistas/Admin. */
  private proprietarioDoVinculo(pedido: string | undefined, req: Requisitante): string {
    if (papelCanonico(req.role) === 'proprietario') {
      if (pedido && pedido.trim() !== req.id?.trim()) throw new ForbiddenException('Você só edita o seu vínculo');
      return req.id!.trim();
    }
    const id = pedido?.trim();
    if (!id) throw new BadRequestException('Informe o proprietário do vínculo');
    return id;
  }

  private async estadoAtual(operadorId: string, proprietarioId: string): Promise<{ id: string; estado: EstadoVinculo } | null> {
    const [v] = await this.prisma.$queryRaw<Array<{ id: string; validade: Date | null }>>`
      SELECT TRIM(id) AS id, validade FROM operador_vinculos
      WHERE operador_id = ${operadorId}::bpchar AND proprietario_id = ${proprietarioId}::bpchar AND removido_em IS NULL
      LIMIT 1`;
    if (!v) return null;
    const [eqs, uns] = await Promise.all([
      this.prisma.$queryRaw<Array<{ equipamento_id: string; ver_rs: boolean }>>`
        SELECT TRIM(equipamento_id) AS equipamento_id, ver_rs FROM operador_vinculo_equipamentos WHERE vinculo_id = ${v.id}::bpchar`,
      this.prisma.$queryRaw<Array<{ unidade_id: string }>>`
        SELECT TRIM(unidade_id) AS unidade_id FROM operador_vinculo_unidades WHERE ver_geracao AND vinculo_id = ${v.id}::bpchar`,
    ]);
    return {
      id: v.id,
      estado: {
        validade: v.validade ? new Date(v.validade).toISOString().slice(0, 10) : null,
        equipamentos: eqs.map((e) => ({ equipamentoId: e.equipamento_id, verRs: e.ver_rs })),
        unidadesGeracao: uns.map((u) => u.unidade_id),
      },
    };
  }
}
