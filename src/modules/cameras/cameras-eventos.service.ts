import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Prisma, type cameras, type cameras_eventos } from '@prisma/client';
import { PermissionScopeService, PrismaService } from '@/core';
import { novoId26, type ClienteInfo } from '@/core/common/cliente-info';
import { CamerasAuditoriaService } from './cameras-auditoria.service';
import { CamerasConfigService, type ConfigUnidade } from './cameras-config.service';
import { CamerasNotificacaoService } from './cameras-notificacao.service';
import {
  decidirEvento,
  decidirReclassificacao,
  ehJpeg,
  ehMp4,
  estaArmado,
  expandirTipos,
  interpretarDados,
  interpretarCaixas,
  intervaloDoDia,
  normalizarAnalise,
  TIPOS_SISTEMA,
  tipoReclassificado,
  tituloEvento,
  type TipoEvento,
} from './cameras-regras';
import { CamerasStorageService } from './cameras-storage.service';
import type { Usuario } from './cameras.tipos';
import type { ClassificacaoEventoDto, EventoAgenteDto, FimEventoDto } from './dto/cameras-agente.dto';
import type { ListarEventosDto, MarcarLidosDto } from './dto/cameras.dto';

/** O que o service precisa saber da câmera para registrar um evento. */
export type CameraBasica = Pick<
  cameras,
  'id' | 'nome' | 'ip' | 'unidade_id' | 'planta_id' | 'equipamento_id' | 'status' | 'status_em' | 'publicando' | 'analise'
>;

type EventoRow = Prisma.cameras_eventosGetPayload<{ include: { camera: { select: { nome: true } } } }>;

const t = (v: string | null | undefined) => (v ? v.trim() : null);
const objeto = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const INCLUDE = { camera: { select: { nome: true } } } as const;

/**
 * Eventos das câmeras: leitura paginada para web/apps, marcar lidos, arquivos (snapshot/clipe),
 * registro vindo do agente (com decisão alerta/descartado), eventos de sistema (sem_sinal /
 * sinal_restabelecido) e estatísticas do resumo.
 */
@Injectable()
export class CamerasEventosService {
  private readonly logger = new Logger(CamerasEventosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: PermissionScopeService,
    private readonly storage: CamerasStorageService,
    private readonly notificacao: CamerasNotificacaoService,
    private readonly auditoria: CamerasAuditoriaService,
    private readonly config: CamerasConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // Leitura (usuário)
  // ---------------------------------------------------------------------------

  private async whereEscopo(user?: Usuario): Promise<Prisma.cameras_eventosWhereInput> {
    const where: Prisma.cameras_eventosWhereInput = {};
    if (!user) return where;
    const scope = await this.scope.getScope(user);
    if (this.scope.isScoped(scope)) where.planta_id = { in: scope.map((p) => p.trim()) };
    // Operador: só instalações liberadas (NEXON-20).
    const unidades = await this.scope.getUnidadesScope(user);
    if (unidades) where.unidade_id = { in: unidades.map((u) => u.trim()) };
    return where;
  }

  async listar(q: ListarEventosDto, user?: Usuario) {
    const page = q.page ?? 1;
    const limit = Math.min(q.limit ?? 20, 100);
    const where = await this.whereEscopo(user);

    if (q.unidade_id) {
      const id = q.unidade_id.trim();
      if (user) await this.scope.assertEntityInScope('unidade', id, user);
      where.unidade_id = id;
    }
    if (q.camera_id) {
      const cam = await this.cameraVisivel(q.camera_id, user);
      where.camera_id = cam.id;
    }
    if (q.dia) {
      const r = intervaloDoDia(q.dia);
      if (!r) throw new BadRequestException('dia inválido (AAAA-MM-DD)');
      where.inicio_em = { gte: r.inicio, lt: r.fim };
    }
    if (q.tipo) {
      const tipos = expandirTipos(q.tipo);
      if (!tipos) throw new BadRequestException(`tipo inválido: ${q.tipo}`);
      where.tipo = { in: tipos };
    }
    if (q.somente_nao_lidos) {
      where.alerta = true;
      where.lido_em = null;
    }
    if (!q.incluir_descartados || q.somente_nao_lidos) where.descartado = false;

    const [linhas, total] = await Promise.all([
      this.prisma.cameras_eventos.findMany({
        where,
        orderBy: [{ inicio_em: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: INCLUDE,
      }),
      this.prisma.cameras_eventos.count({ where }),
    ]);
    return {
      data: await this.apresentar(linhas),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  async detalhe(id: string, user?: Usuario) {
    const e = await this.buscarVisivel(id, user);
    return (await this.apresentar([e]))[0];
  }

  /** Snapshot (JPEG) ou clipe (MP4, com Range) direto no `res`. 404 se o evento não tem o arquivo. */
  async arquivo(id: string, tipo: 'snapshot' | 'clipe', user: Usuario | undefined, req: Request, res: Response): Promise<void> {
    const e = await this.buscarVisivel(id, user);
    if (tipo === 'snapshot') return this.storage.servir(req, res, e.snapshot_path, 'image/jpeg', 'private, max-age=86400');
    return this.storage.servir(req, res, e.clipe_path, 'video/mp4', 'private, max-age=86400');
  }

  async marcarLido(id: string, user?: Usuario) {
    const e = await this.buscarVisivel(id, user);
    if (!e.lido_em) {
      await this.prisma.cameras_eventos.update({
        where: { id: e.id },
        data: { lido_em: new Date(), lido_por_id: t(user?.id), lido_por_nome: user?.nome ?? null },
      });
    }
    return this.detalhe(e.id, user);
  }

  /** Marca todos os alertas não lidos da unidade (ou de uma câmera). Trilha camera_evento_lido. */
  async marcarLidos(dto: MarcarLidosDto, user?: Usuario, cliente?: ClienteInfo) {
    const unidadeId = dto.unidade_id.trim();
    if (user) await this.scope.assertEntityInScope('unidade', unidadeId, user);
    const where: Prisma.cameras_eventosWhereInput = { unidade_id: unidadeId, alerta: true, lido_em: null };
    let camera: { id: string; nome: string; ip: string; unidade_id: string } | null = null;
    if (dto.camera_id) {
      camera = await this.cameraVisivel(dto.camera_id, user);
      if (camera.unidade_id !== unidadeId) throw new BadRequestException('camera_id não é desta unidade');
      where.camera_id = camera.id;
    }
    const r = await this.prisma.cameras_eventos.updateMany({
      where,
      data: { lido_em: new Date(), lido_por_id: t(user?.id), lido_por_nome: user?.nome ?? null },
    });
    const ctx = await this.auditoria.contextoUnidade(unidadeId);
    await this.auditoria.registrar('camera_evento_lido', {
      mensagem: `${r.count} alerta(s) de câmera marcados como lidos — ${camera ? `câmera ${camera.nome}, ` : ''}${ctx.unidade?.nome ?? unidadeId}${ctx.planta ? ` (${ctx.planta.nome})` : ''}`,
      user,
      cliente,
      unidade: ctx.unidade,
      planta: ctx.planta,
      camera,
      objetoTipo: camera ? 'camera' : 'unidade',
      objetoId: camera?.id ?? unidadeId,
      extra: { marcados: r.count },
    });
    return { marcados: r.count };
  }

  // ---------------------------------------------------------------------------
  // Estatísticas do resumo e da lista de câmeras
  // ---------------------------------------------------------------------------

  async contarNaoLidos(unidadeId: string): Promise<number> {
    return this.prisma.cameras_eventos.count({
      where: { unidade_id: unidadeId.trim(), alerta: true, lido_em: null, descartado: false },
    });
  }

  /** Por câmera: alertas não lidos e horário do último alerta. */
  async estatisticasPorCamera(unidadeId: string): Promise<Map<string, { nao_lidos: number; ultimo_alerta_em: Date | null }>> {
    const id = unidadeId.trim();
    const [naoLidos, ultimos] = await Promise.all([
      this.prisma.cameras_eventos.groupBy({
        by: ['camera_id'],
        where: { unidade_id: id, alerta: true, lido_em: null, descartado: false },
        _count: { _all: true },
      }),
      this.prisma.cameras_eventos.groupBy({
        by: ['camera_id'],
        where: { unidade_id: id, alerta: true, descartado: false },
        _max: { inicio_em: true },
      }),
    ]);
    const m = new Map<string, { nao_lidos: number; ultimo_alerta_em: Date | null }>();
    for (const u of ultimos) m.set(u.camera_id, { nao_lidos: 0, ultimo_alerta_em: u._max.inicio_em ?? null });
    for (const n of naoLidos) {
      const atual = m.get(n.camera_id) ?? { nao_lidos: 0, ultimo_alerta_em: null };
      m.set(n.camera_id, { ...atual, nao_lidos: n._count._all });
    }
    return m;
  }

  async ultimoAlerta(unidadeId: string) {
    const e = await this.prisma.cameras_eventos.findFirst({
      where: { unidade_id: unidadeId.trim(), alerta: true, descartado: false },
      orderBy: [{ inicio_em: 'desc' }, { id: 'desc' }],
      include: INCLUDE,
    });
    return e ? (await this.apresentar([e]))[0] : null;
  }

  /** Alertas e descartados desde o começo da noite. */
  async contarDesde(unidadeId: string, desde: Date): Promise<{ alertas: number; descartados: number }> {
    const id = unidadeId.trim();
    const [alertas, descartados] = await Promise.all([
      this.prisma.cameras_eventos.count({ where: { unidade_id: id, alerta: true, inicio_em: { gte: desde } } }),
      this.prisma.cameras_eventos.count({ where: { unidade_id: id, descartado: true, inicio_em: { gte: desde } } }),
    ]);
    return { alertas, descartados };
  }

  // ---------------------------------------------------------------------------
  // Registro (agente e worker)
  // ---------------------------------------------------------------------------

  /** Detecção ou foto vinda do agente. Decide alerta/descartado, guarda o snapshot e notifica. */
  async registrarDoAgente(camera: CameraBasica, dto: EventoAgenteDto, snapshot?: Buffer, agora = new Date()) {
    const dados = interpretarDados(dto.dados);
    if (dados === null) throw new BadRequestException('dados deve ser um objeto JSON');
    const inicio = new Date(dto.inicio_em);
    if (Number.isNaN(inicio.getTime())) throw new BadRequestException('inicio_em inválido');
    const fim = dto.fim_em ? new Date(dto.fim_em) : null;
    if (fim && Number.isNaN(fim.getTime())) throw new BadRequestException('fim_em inválido');
    if (snapshot && !ehJpeg(snapshot)) throw new BadRequestException('snapshot deve ser JPEG');

    const config = await this.config.obter(camera.unidade_id, camera.planta_id);
    const armado = estaArmado(config, agora);
    const decisao = decidirEvento(dto.tipo, armado, normalizarAnalise(camera.analise));

    const id = novoId26();
    const snapshotPath = snapshot ? this.storage.caminhoEvento(id, 'jpg') : null;
    if (snapshot && snapshotPath) await this.storage.salvar(snapshotPath, snapshot);

    const evento = await this.prisma.cameras_eventos.create({
      data: {
        id,
        camera_id: camera.id,
        unidade_id: camera.unidade_id,
        planta_id: camera.planta_id,
        tipo: dto.tipo,
        inicio_em: inicio,
        fim_em: fim,
        confianca: dto.confianca ?? null,
        armado,
        alerta: decisao.alerta,
        descartado: decisao.descartado,
        motivo_descarte: decisao.motivo_descarte,
        snapshot_path: snapshotPath,
        dados: dados as Prisma.InputJsonValue,
      },
    });
    if (decisao.alerta) await this.notificar(evento, camera, config);
    return {
      id: evento.id,
      alerta: decisao.alerta,
      descartado: decisao.descartado,
      motivo_descarte: decisao.motivo_descarte,
      enviar_clipe: decisao.enviar_clipe,
    };
  }

  /**
   * sem_sinal / sinal_restabelecido. Não repete: se o último evento de sistema da câmera já é
   * deste tipo, devolve o existente. sem_sinal é alerta (notifica); sinal_restabelecido não.
   */
  async registrarSistema(
    camera: CameraBasica,
    tipo: Extract<TipoEvento, 'sem_sinal' | 'sinal_restabelecido'>,
    agora = new Date(),
    inicio: Date = agora,
  ): Promise<{ id: string; criado: boolean }> {
    const ultimo = await this.prisma.cameras_eventos.findFirst({
      where: { camera_id: camera.id, tipo: { in: [...TIPOS_SISTEMA] } },
      orderBy: [{ inicio_em: 'desc' }, { id: 'desc' }],
      select: { id: true, tipo: true },
    });
    if (ultimo?.tipo === tipo) return { id: ultimo.id, criado: false };

    const config = await this.config.obter(camera.unidade_id, camera.planta_id);
    const armado = estaArmado(config, agora);
    const decisao = decidirEvento(tipo, armado, normalizarAnalise(camera.analise));
    const evento = await this.prisma.cameras_eventos.create({
      data: {
        id: novoId26(),
        camera_id: camera.id,
        unidade_id: camera.unidade_id,
        planta_id: camera.planta_id,
        tipo,
        inicio_em: inicio,
        armado,
        alerta: decisao.alerta,
        descartado: false,
        dados: {},
      },
    });
    if (decisao.alerta) await this.notificar(evento, camera, config);
    return { id: evento.id, criado: true };
  }

  /** Status da câmera (heartbeat, worker ou evento de sistema do agente). */
  async atualizarStatus(
    camera: CameraBasica,
    status: 'online' | 'offline',
    agora = new Date(),
    extras: { publicando?: boolean } = {},
  ): Promise<void> {
    const mudou = camera.status !== status;
    await this.prisma.cameras.update({
      where: { id: camera.id },
      data: {
        status,
        status_em: mudou ? agora : camera.status_em ?? agora,
        ...(status === 'online' ? { ultimo_contato_em: agora } : {}),
        publicando: status === 'online' ? extras.publicando ?? camera.publicando : false,
      },
    });
  }

  /** Offline + evento sem_sinal (sem repetir). */
  async marcarOffline(camera: CameraBasica, agora = new Date()): Promise<{ evento_id: string }> {
    await this.atualizarStatus(camera, 'offline', agora);
    const r = await this.registrarSistema(camera, 'sem_sinal', agora);
    return { evento_id: r.id };
  }

  /** Online; se estava offline, evento sinal_restabelecido. */
  async marcarOnline(camera: CameraBasica, agora = new Date(), extras: { publicando?: boolean } = {}): Promise<{ evento_id: string | null }> {
    await this.atualizarStatus(camera, 'online', agora, extras);
    if (camera.status !== 'offline') return { evento_id: null };
    const r = await this.registrarSistema(camera, 'sinal_restabelecido', agora);
    return { evento_id: r.id };
  }

  async fim(evento: cameras_eventos, dto: FimEventoDto, camera?: CameraBasica | null, agora = new Date()): Promise<void> {
    const fim = new Date(dto.fim_em);
    if (Number.isNaN(fim.getTime())) throw new BadRequestException('fim_em inválido');
    const atual = objeto(evento.dados);
    await this.prisma.cameras_eventos.update({
      where: { id: evento.id },
      data: { fim_em: fim, dados: { ...atual, ...(dto.dados ?? {}) } as Prisma.InputJsonValue },
    });
    // Classe no fim: campos de topo ou, no agente antigo, dentro de `dados` (tipo/confianca/caixas).
    const extra = dto.dados ?? {};
    const tipo = dto.tipo ?? extra.tipo;
    if (!camera || !tipoReclassificado(evento.tipo, tipo)) return;
    const confianca = Number(dto.confianca ?? extra.confianca);
    await this.reclassificar(
      { ...evento, dados: { ...atual, ...extra } as Prisma.JsonValue },
      camera,
      {
        tipo: tipo as ClassificacaoEventoDto['tipo'],
        confianca: Number.isFinite(confianca) ? Math.min(1, Math.max(0, confianca)) : 0,
        caixas: dto.caixas ?? extra.caixas,
      },
      undefined,
      agora,
    );
  }

  /**
   * NEXON-108: o agente reconheceu pessoa/veículo/animal num evento aberto como `movimento`.
   * Sobe a classe (nunca rebaixa), troca caixas e snapshot, refaz a decisão com o armamento de
   * agora e, se passou a alertar, marca alerta e notifica uma única vez. Idempotente: repetir a
   * chamada (ou chegar junto com o fim) não altera de novo nem notifica de novo.
   */
  async reclassificar(
    evento: cameras_eventos,
    camera: CameraBasica,
    dto: ClassificacaoEventoDto,
    snapshot?: Buffer,
    agora = new Date(),
  ): Promise<{ id: string; tipo: string; alterado: boolean; alerta: boolean; descartado: boolean; motivo_descarte: string | null; enviar_clipe: boolean }> {
    const sem = {
      id: evento.id,
      tipo: evento.tipo,
      alterado: false,
      alerta: evento.alerta,
      descartado: evento.descartado,
      motivo_descarte: evento.motivo_descarte,
      enviar_clipe: false,
    };
    const tipo = tipoReclassificado(evento.tipo, dto.tipo);
    if (!tipo) return sem;
    if (snapshot && !ehJpeg(snapshot)) throw new BadRequestException('snapshot deve ser JPEG');
    const caixas = dto.caixas === undefined || dto.caixas === null ? undefined : interpretarCaixas(dto.caixas);
    if (caixas === null) throw new BadRequestException('caixas deve ser uma lista de objetos');

    const config = await this.config.obter(camera.unidade_id, camera.planta_id);
    const armado = estaArmado(config, agora);
    const d = decidirReclassificacao(tipo, evento.alerta, armado, normalizarAnalise(camera.analise));

    const snapshotPath = snapshot ? this.storage.caminhoEvento(evento.id, 'jpg') : evento.snapshot_path;
    if (snapshot && snapshotPath) await this.storage.salvar(snapshotPath, snapshot);

    const dados = { ...objeto(evento.dados), ...(caixas ? { caixas } : {}), reclassificado_em: agora.toISOString() };
    // where tipo = 'movimento': só uma chamada vence (classificação e fim chegando juntos).
    const r = await this.prisma.cameras_eventos.updateMany({
      where: { id: evento.id, tipo: 'movimento' },
      data: {
        tipo,
        confianca: dto.confianca,
        armado,
        alerta: d.alerta,
        descartado: d.descartado,
        motivo_descarte: d.motivo_descarte,
        snapshot_path: snapshotPath,
        dados: dados as Prisma.InputJsonValue,
      },
    });
    if (r.count !== 1) return sem;
    this.logger.log(
      `[cameras] evento ${evento.id} reclassificado movimento → ${tipo} (${Math.round(dto.confianca * 100)}%)` +
        `${d.notificar ? ' — alerta' : d.descartado ? ` — descartado (${d.motivo_descarte})` : ''}`,
    );
    if (d.notificar) await this.notificar({ ...evento, tipo, confianca: new Prisma.Decimal(dto.confianca) }, camera, config);
    return { id: evento.id, tipo, alterado: true, alerta: d.alerta, descartado: d.descartado, motivo_descarte: d.motivo_descarte, enviar_clipe: d.enviar_clipe };
  }

  async clipe(evento: cameras_eventos, conteudo: Buffer): Promise<string> {
    if (!ehMp4(conteudo)) throw new BadRequestException('clipe deve ser MP4');
    const rel = this.storage.caminhoEvento(evento.id, 'mp4');
    await this.storage.salvar(rel, conteudo);
    await this.prisma.cameras_eventos.update({ where: { id: evento.id }, data: { clipe_path: rel } });
    return rel;
  }

  private async notificar(evento: cameras_eventos, camera: CameraBasica, config: ConfigUnidade): Promise<void> {
    try {
      const ctx = await this.auditoria.contextoUnidade(camera.unidade_id);
      await this.notificacao.alertar({
        evento: {
          id: evento.id,
          tipo: evento.tipo,
          inicio_em: evento.inicio_em,
          confianca: evento.confianca == null ? null : Number(evento.confianca),
        },
        camera: { id: camera.id, nome: camera.nome, equipamento_id: t(camera.equipamento_id), unidade_id: camera.unidade_id },
        unidade: ctx.unidade,
        planta: ctx.planta,
        config: { abrir_chamado: config.abrir_chamado, notificar_emails: config.notificar_emails },
      });
    } catch (e) {
      this.logger.warn(`[cameras] notificação do evento ${evento.id} falhou: ${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Apoio
  // ---------------------------------------------------------------------------

  private async buscarVisivel(id: string, user?: Usuario): Promise<EventoRow> {
    const e = await this.prisma.cameras_eventos.findFirst({ where: { id: id.trim() }, include: INCLUDE });
    if (!e) throw new NotFoundException('Evento não encontrado');
    if (user) await this.scope.assertEntityInScope('unidade', e.unidade_id, user);
    return e;
  }

  private async cameraVisivel(id: string, user?: Usuario) {
    const c = await this.prisma.cameras.findFirst({
      where: { id: id.trim(), deleted_at: null },
      select: { id: true, nome: true, ip: true, unidade_id: true },
    });
    if (!c) throw new NotFoundException('Câmera não encontrada');
    if (user) await this.scope.assertEntityInScope('unidade', c.unidade_id, user);
    return c;
  }

  /** Objeto "Evento" do contrato (camera_nome, titulo, urls e número do chamado). */
  async apresentar(linhas: EventoRow[]) {
    const chamadoIds = [...new Set(linhas.map((l) => l.chamado_id).filter((x): x is string => !!x))];
    const chamados = chamadoIds.length
      ? await this.prisma.chamados.findMany({ where: { id: { in: chamadoIds } }, select: { id: true, numero: true } })
      : [];
    const numero = new Map(chamados.map((c) => [c.id.trim(), c.numero]));
    return linhas.map((e) => ({
      id: e.id,
      camera_id: e.camera_id,
      camera_nome: e.camera?.nome ?? null,
      unidade_id: e.unidade_id,
      planta_id: e.planta_id,
      tipo: e.tipo,
      titulo: tituloEvento(e.tipo),
      inicio_em: e.inicio_em,
      fim_em: e.fim_em,
      confianca: e.confianca == null ? null : Number(e.confianca),
      armado: e.armado,
      alerta: e.alerta,
      descartado: e.descartado,
      motivo_descarte: e.motivo_descarte,
      snapshot_url: e.snapshot_path ? `/api/v1/cameras/eventos/${e.id}/snapshot` : null,
      clipe_url: e.clipe_path ? `/api/v1/cameras/eventos/${e.id}/clipe` : null,
      lido_em: e.lido_em,
      lido_por_nome: e.lido_por_nome,
      chamado_id: e.chamado_id,
      chamado_numero: e.chamado_id ? (numero.get(e.chamado_id) ?? null) : null,
      dados: e.dados,
      created_at: e.created_at,
    }));
  }
}
