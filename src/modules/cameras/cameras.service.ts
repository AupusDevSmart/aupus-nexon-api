import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Prisma, type cameras } from '@prisma/client';
import { PermissionScopeService, PrismaService } from '@/core';
import { capacidades, MSG_SOMENTE_LEITURA, papelCanonico, type Capacidades } from '@/core/modules/auth/papeis';
import { novoId26, type ClienteInfo } from '@/core/common/cliente-info';
import { EquipamentosCmdService } from '../equipamentos-cmd/equipamentos-cmd.service';
import { CamerasAuditoriaService } from './cameras-auditoria.service';
import { CamerasConfigService } from './cameras-config.service';
import { CamerasEventosService } from './cameras-eventos.service';
import { CamerasMidiaService } from './cameras-midia.service';
import {
  agenteOnline,
  armadoAte,
  caminhoStream,
  estaArmado,
  horaLocal,
  inicioDaNoite,
  modoVigente,
  analiseNovaCamera,
  normalizarAnalise,
  STREAM_PEDIDO_S,
} from './cameras-regras';
import { CamerasStorageService } from './cameras-storage.service';
import type { Usuario } from './cameras.tipos';
import type {
  AcionarDto,
  ArmarDto,
  ConfigUnidadeDto,
  CriarCameraDto,
  EditarCameraDto,
  ListarCamerasDto,
  PontoComandoDto,
} from './dto/cameras.dto';

type Capacidade = Extract<keyof Capacidades, 'cadastroTecnico' | 'comandar' | 'configOperacional'>;
type Estatistica = { nao_lidos: number; ultimo_alerta_em: Date | null } | undefined;

const t = (v: string | null | undefined) => (v ? v.trim() : null);
const ROTULO_DISPOSITIVO = { refletor: 'Refletor', sirene: 'Sirene' } as const;

/**
 * Rotas de usuário das câmeras: cadastro (cadastroTecnico), vídeo/miniatura/foto, resumo e
 * configuração da unidade (configOperacional), armar/desarmar e refletor/sirene (comandar).
 * Escopo: toda câmera/unidade passa por PermissionScopeService.assertEntityInScope('unidade').
 * Toda ação grava em auditoria_acessos (acao camera_*).
 */
@Injectable()
export class CamerasService {
  private readonly logger = new Logger(CamerasService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: PermissionScopeService,
    private readonly midia: CamerasMidiaService,
    private readonly eventos: CamerasEventosService,
    private readonly cmd: EquipamentosCmdService,
    private readonly auditoria: CamerasAuditoriaService,
    private readonly storage: CamerasStorageService,
    private readonly config: CamerasConfigService,
  ) {}

  private exigir(user: Usuario | undefined, cap: Capacidade) {
    if (user && !capacidades(papelCanonico(user.role))[cap]) throw new ForbiddenException(MSG_SOMENTE_LEITURA);
  }

  // ---------------------------------------------------------------------------
  // Listagem e detalhe
  // ---------------------------------------------------------------------------

  async listar(q: ListarCamerasDto, user?: Usuario) {
    const unidadeId = q.unidade_id.trim();
    if (user) await this.scope.assertEntityInScope('unidade', unidadeId, user);
    const [cameras, stats] = await Promise.all([
      this.prisma.cameras.findMany({
        where: { unidade_id: unidadeId, deleted_at: null },
        orderBy: [{ ordem: 'asc' }, { nome: 'asc' }],
      }),
      this.eventos.estatisticasPorCamera(unidadeId),
    ]);
    return cameras.map((c) => this.apresentar(c, stats.get(c.id)));
  }

  async detalhe(id: string, user?: Usuario) {
    const c = await this.buscar(id, user);
    const stats = await this.eventos.estatisticasPorCamera(c.unidade_id);
    return this.apresentar(c, stats.get(c.id));
  }

  /** Objeto "Camera" do contrato. Senha nunca sai. */
  apresentar(c: cameras, s?: Estatistica) {
    return {
      id: c.id,
      unidade_id: c.unidade_id,
      planta_id: c.planta_id,
      agente_id: c.agente_id,
      equipamento_id: c.equipamento_id,
      nome: c.nome,
      fabricante: c.fabricante,
      modelo: c.modelo,
      ip: c.ip,
      porta_rtsp: c.porta_rtsp,
      porta_http: c.porta_http,
      usuario: c.usuario,
      canal: c.canal,
      ativa: c.ativa,
      ordem: c.ordem,
      status: c.status,
      status_em: c.status_em,
      ultimo_contato_em: c.ultimo_contato_em,
      miniatura_url: `/api/v1/cameras/${c.id}/miniatura`,
      miniatura_em: c.miniatura_em,
      nao_lidos: s?.nao_lidos ?? 0,
      ultimo_alerta_em: s?.ultimo_alerta_em ?? null,
      stream: {
        continuo: c.stream_continuo,
        transcodificar: c.stream_transcodificar,
        publicando: c.publicando,
        caminho: caminhoStream(c.id),
        bitrate_kbps: c.stream_bitrate_kbps,
      },
      analise: normalizarAnalise(c.analise),
      created_at: c.created_at,
      updated_at: c.updated_at,
    };
  }

  // ---------------------------------------------------------------------------
  // Cadastro (cadastroTecnico)
  // ---------------------------------------------------------------------------

  async criar(dto: CriarCameraDto, user?: Usuario, cliente?: ClienteInfo) {
    this.exigir(user, 'cadastroTecnico');
    const unidadeId = dto.unidade_id.trim();
    if (user) await this.scope.assertEntityInScope('unidade', unidadeId, user);
    const ctx = await this.auditoria.contextoUnidade(unidadeId);
    if (!ctx.unidade || !ctx.planta) throw new NotFoundException('Unidade não encontrada');
    const agenteId = await this.validarAgente(dto.agente_id ?? null, unidadeId);
    const equipamentoId = await this.validarEquipamento(dto.equipamento_id ?? null, user);

    const c = await this.prisma.cameras.create({
      data: {
        id: novoId26(),
        unidade_id: unidadeId,
        planta_id: ctx.planta.id,
        agente_id: agenteId,
        equipamento_id: equipamentoId,
        nome: dto.nome.trim(),
        fabricante: dto.fabricante?.trim().toLowerCase() || 'intelbras',
        modelo: dto.modelo?.trim() || null,
        ip: dto.ip.trim(),
        porta_rtsp: dto.porta_rtsp ?? 554,
        porta_http: dto.porta_http ?? 80,
        usuario: dto.usuario.trim(),
        senha: this.midia.cifrar(dto.senha),
        canal: dto.canal ?? 1,
        ativa: dto.ativa ?? true,
        ordem: dto.ordem ?? (await this.proximaOrdem(unidadeId)),
        stream_continuo: dto.stream?.continuo ?? false,
        stream_transcodificar: dto.stream?.transcodificar ?? false,
        stream_bitrate_kbps: dto.stream?.bitrate_kbps ?? 800,
        analise: analiseNovaCamera(dto.analise) as unknown as Prisma.InputJsonValue,
      },
    });
    await this.auditoria.registrar('camera_cadastro', {
      mensagem: `Câmera "${c.nome}" (${c.ip}) cadastrada — ${ctx.unidade.nome} (${ctx.planta.nome})`,
      user,
      cliente,
      unidade: ctx.unidade,
      planta: ctx.planta,
      camera: { id: c.id, nome: c.nome, ip: c.ip, unidade_id: c.unidade_id },
      extra: { camera_dados: this.semSenha(c) },
    });
    return this.apresentar(c);
  }

  async editar(id: string, dto: EditarCameraDto, user?: Usuario, cliente?: ClienteInfo) {
    this.exigir(user, 'cadastroTecnico');
    const atual = await this.buscar(id, user);

    let unidadeId = atual.unidade_id;
    let plantaId = atual.planta_id;
    let ctx = await this.auditoria.contextoUnidade(unidadeId);
    if (dto.unidade_id && dto.unidade_id.trim() !== atual.unidade_id) {
      unidadeId = dto.unidade_id.trim();
      if (user) await this.scope.assertEntityInScope('unidade', unidadeId, user);
      ctx = await this.auditoria.contextoUnidade(unidadeId);
      if (!ctx.unidade || !ctx.planta) throw new NotFoundException('Unidade não encontrada');
      plantaId = ctx.planta.id;
    }
    let agenteId = atual.agente_id;
    if (dto.agente_id !== undefined) agenteId = await this.validarAgente(dto.agente_id, unidadeId);
    else if (unidadeId !== atual.unidade_id && atual.agente_id) {
      // Mudou de unidade sem dizer o agente: só fica se o agente for da unidade nova.
      agenteId = await this.validarAgente(atual.agente_id, unidadeId).catch(() => null);
    }
    const equipamentoId = dto.equipamento_id === undefined ? atual.equipamento_id : await this.validarEquipamento(dto.equipamento_id, user);

    const dados: Prisma.camerasUncheckedUpdateInput = {
      unidade_id: unidadeId,
      planta_id: plantaId,
      agente_id: agenteId,
      equipamento_id: equipamentoId,
    };
    if (dto.nome !== undefined) dados.nome = dto.nome.trim();
    if (dto.ip !== undefined) dados.ip = dto.ip.trim();
    if (dto.usuario !== undefined) dados.usuario = dto.usuario.trim();
    if (dto.senha !== undefined) dados.senha = this.midia.cifrar(dto.senha);
    if (dto.porta_rtsp !== undefined) dados.porta_rtsp = dto.porta_rtsp;
    if (dto.porta_http !== undefined) dados.porta_http = dto.porta_http;
    if (dto.canal !== undefined) dados.canal = dto.canal;
    if (dto.fabricante !== undefined) dados.fabricante = dto.fabricante.trim().toLowerCase() || 'intelbras';
    if (dto.modelo !== undefined) dados.modelo = dto.modelo.trim() || null;
    if (dto.ordem !== undefined) dados.ordem = dto.ordem;
    if (dto.ativa !== undefined) dados.ativa = dto.ativa;
    if (dto.stream?.continuo !== undefined) dados.stream_continuo = dto.stream.continuo;
    if (dto.stream?.transcodificar !== undefined) dados.stream_transcodificar = dto.stream.transcodificar;
    if (dto.stream?.bitrate_kbps !== undefined) dados.stream_bitrate_kbps = dto.stream.bitrate_kbps;
    if (dto.analise !== undefined) {
      dados.analise = normalizarAnalise({ ...normalizarAnalise(atual.analise), ...dto.analise }) as unknown as Prisma.InputJsonValue;
    }
    if (dto.ativa === false) dados.publicando = false;

    const c = await this.prisma.cameras.update({ where: { id: atual.id }, data: dados });
    const alteracoes = this.alteracoes(this.semSenha(atual), this.semSenha(c));
    if (dto.senha !== undefined) alteracoes.senha = { de: '***', para: '*** (alterada)' };
    await this.auditoria.registrar('camera_edicao', {
      mensagem: `Câmera "${c.nome}" (${c.ip}) editada — ${ctx.unidade?.nome ?? c.unidade_id}${ctx.planta ? ` (${ctx.planta.nome})` : ''}: ${Object.keys(alteracoes).join(', ') || 'sem mudança'}`,
      user,
      cliente,
      unidade: ctx.unidade,
      planta: ctx.planta,
      camera: { id: c.id, nome: c.nome, ip: c.ip, unidade_id: c.unidade_id },
      extra: { alteracoes },
    });
    const stats = await this.eventos.estatisticasPorCamera(c.unidade_id);
    return this.apresentar(c, stats.get(c.id));
  }

  async excluir(id: string, user?: Usuario, cliente?: ClienteInfo) {
    this.exigir(user, 'cadastroTecnico');
    const c = await this.buscar(id, user);
    const agora = new Date();
    await this.prisma.$transaction([
      this.prisma.cameras.update({ where: { id: c.id }, data: { deleted_at: agora, ativa: false, publicando: false } }),
      this.prisma.cameras_comandos.updateMany({
        where: { camera_id: c.id, estado: { in: ['pendente', 'entregue'] } },
        data: { estado: 'erro', erro: 'Câmera excluída', concluido_em: agora },
      }),
    ]);
    await this.storage.remover(this.storage.caminhoMiniatura(c.id));
    const ctx = await this.auditoria.contextoUnidade(c.unidade_id);
    await this.auditoria.registrar('camera_exclusao', {
      mensagem: `Câmera "${c.nome}" (${c.ip}) excluída — ${ctx.unidade?.nome ?? c.unidade_id}${ctx.planta ? ` (${ctx.planta.nome})` : ''}`,
      user,
      cliente,
      unidade: ctx.unidade,
      planta: ctx.planta,
      camera: { id: c.id, nome: c.nome, ip: c.ip, unidade_id: c.unidade_id },
      extra: { camera_dados: this.semSenha(c) },
    });
    return { id: c.id, excluida: true };
  }

  // ---------------------------------------------------------------------------
  // Miniatura, vídeo ao vivo e foto
  // ---------------------------------------------------------------------------

  async miniatura(id: string, user: Usuario | undefined, req: Request, res: Response): Promise<void> {
    const c = await this.buscar(id, user);
    if (!c.miniatura_em) throw new NotFoundException('Câmera ainda sem miniatura');
    await this.storage.servir(req, res, this.storage.caminhoMiniatura(c.id), 'image/jpeg', 'private, max-age=30');
  }

  /** Marca a câmera como assistida (90 s) e devolve o HLS com token de mídia do usuário. */
  async stream(id: string, user?: Usuario) {
    const c = await this.buscar(id, user);
    const agora = new Date();
    await this.prisma.cameras.update({ where: { id: c.id }, data: { stream_pedido_em: agora } });
    const estado = c.publicando ? 'publicando' : c.status === 'offline' || !c.ativa ? 'offline' : 'aguardando';
    const { token } = this.midia.gerarTokenMidia(user ?? {}, agora);
    return {
      hls_url: this.midia.hlsUrl(caminhoStream(c.id), token),
      estado,
      valido_ate: new Date(agora.getTime() + STREAM_PEDIDO_S * 1000).toISOString(),
    };
  }

  /** Pede uma foto agora ao agente (comando `foto`). 409 CAMERA_SEM_AGENTE sem agente em contato. */
  async foto(id: string, user?: Usuario, cliente?: ClienteInfo) {
    this.exigir(user, 'comandar');
    const c = await this.buscar(id, user);
    const ctx = await this.auditoria.contextoUnidade(c.unidade_id);
    const agente = c.agente_id
      ? await this.prisma.cameras_agentes.findFirst({
          where: { id: c.agente_id, deleted_at: null, ativo: true },
          select: { id: true, nome: true, ultimo_contato_em: true },
        })
      : null;
    if (!agente || !agenteOnline(agente.ultimo_contato_em)) {
      const motivo = agente ? 'agente sem contato há mais de 3 min' : 'câmera sem agente';
      await this.auditoria.registrar('camera_comando', {
        mensagem: `Foto da câmera "${c.nome}" (${c.ip}) recusada: ${motivo} — ${ctx.unidade?.nome ?? c.unidade_id}`,
        user,
        cliente,
        unidade: ctx.unidade,
        planta: ctx.planta,
        camera: { id: c.id, nome: c.nome, ip: c.ip, unidade_id: c.unidade_id },
        resultado: 'negado',
        extra: { comando: { tipo: 'foto' }, agente: agente ? { id: agente.id, nome: agente.nome } : null, motivo },
      });
      throw new ConflictException({
        message: agente ? 'O agente desta câmera está sem contato' : 'Esta câmera não tem agente',
        code: 'CAMERA_SEM_AGENTE',
      });
    }
    const cmd = await this.prisma.cameras_comandos.create({
      data: { id: novoId26(), camera_id: c.id, agente_id: agente.id, tipo: 'foto', parametros: {}, solicitado_por_id: t(user?.id) },
    });
    await this.auditoria.registrar('camera_comando', {
      mensagem: `Foto pedida à câmera "${c.nome}" (${c.ip}) — ${ctx.unidade?.nome ?? c.unidade_id}${ctx.planta ? ` (${ctx.planta.nome})` : ''}`,
      user,
      cliente,
      unidade: ctx.unidade,
      planta: ctx.planta,
      camera: { id: c.id, nome: c.nome, ip: c.ip, unidade_id: c.unidade_id },
      extra: { comando: { id: cmd.id, tipo: 'foto' }, agente: { id: agente.id, nome: agente.nome } },
    });
    return { comando_id: cmd.id };
  }

  // ---------------------------------------------------------------------------
  // Unidade: resumo, config, armar, acionar
  // ---------------------------------------------------------------------------

  async resumo(unidadeId: string, user?: Usuario) {
    const id = unidadeId.trim();
    if (user) await this.scope.assertEntityInScope('unidade', id, user);
    const ctx = await this.auditoria.contextoUnidade(id);
    if (!ctx.unidade) throw new NotFoundException('Unidade não encontrada');
    const agora = new Date();
    const [cameras, config, naoLidos, ultimoAlerta] = await Promise.all([
      this.prisma.cameras.findMany({
        where: { unidade_id: id, deleted_at: null },
        select: { id: true, nome: true, status: true, status_em: true },
        orderBy: [{ ordem: 'asc' }, { nome: 'asc' }],
      }),
      this.config.obter(id, ctx.planta?.id),
      this.eventos.contarNaoLidos(id),
      this.eventos.ultimoAlerta(id),
    ]);
    const inicioNoite = inicioDaNoite(config, agora);
    const noite = await this.eventos.contarDesde(id, inicioNoite);
    return {
      total: cameras.length,
      online: cameras.filter((c) => c.status === 'online').length,
      offline: cameras.filter((c) => c.status === 'offline').length,
      armado: estaArmado(config, agora),
      armado_ate: armadoAte(config, agora),
      armamento_modo: modoVigente(config, agora),
      nao_lidos: naoLidos,
      ultimo_alerta: ultimoAlerta,
      noite: { inicio: inicioNoite, alertas: noite.alertas, descartados: noite.descartados },
      sem_sinal: cameras
        .filter((c) => c.status === 'offline')
        .map((c) => ({ camera_id: c.id, camera_nome: c.nome, desde: c.status_em })),
      comandos: {
        refletor: !!(config.refletor_equipamento_id && config.refletor_ponto_id),
        sirene: !!(config.sirene_equipamento_id && config.sirene_ponto_id),
      },
    };
  }

  async obterConfig(unidadeId: string, user?: Usuario) {
    const id = unidadeId.trim();
    if (user) await this.scope.assertEntityInScope('unidade', id, user);
    const ctx = await this.auditoria.contextoUnidade(id);
    if (!ctx.unidade) throw new NotFoundException('Unidade não encontrada');
    return this.config.apresentar(await this.config.obter(id, ctx.planta?.id));
  }

  async salvarConfig(unidadeId: string, dto: ConfigUnidadeDto, user?: Usuario, cliente?: ClienteInfo) {
    this.exigir(user, 'configOperacional');
    const id = unidadeId.trim();
    if (user) await this.scope.assertEntityInScope('unidade', id, user);
    const ctx = await this.auditoria.contextoUnidade(id);
    if (!ctx.unidade || !ctx.planta) throw new NotFoundException('Unidade não encontrada');
    if (dto.refletor) await this.validarPonto(dto.refletor, user);
    if (dto.sirene) await this.validarPonto(dto.sirene, user);
    if (dto.armamento.armado_manual_ate && Number.isNaN(new Date(dto.armamento.armado_manual_ate).getTime())) {
      throw new BadRequestException('armado_manual_ate inválido');
    }

    const antes = await this.config.obter(id, ctx.planta.id);
    const depois = await this.config.salvar(id, ctx.planta.id, dto, t(user?.id));
    const simNao = (v: unknown) => (v ? 'sim' : 'não');
    await this.auditoria.registrar('camera_config', {
      mensagem:
        `Configuração das câmeras salva — ${ctx.unidade.nome} (${ctx.planta.nome}): modo ${depois.armamento_modo}, ` +
        `refletor ${simNao(depois.refletor_ponto_id)}, sirene ${simNao(depois.sirene_ponto_id)}, chamado ${simNao(depois.abrir_chamado)}, ` +
        `${depois.notificar_emails.length} e-mail(s)`,
      user,
      cliente,
      unidade: ctx.unidade,
      planta: ctx.planta,
      objetoTipo: 'unidade',
      objetoId: id,
      extra: { antes: this.config.apresentar(antes), depois: this.config.apresentar(depois) },
    });
    return this.config.apresentar(depois);
  }

  /** Armamento manual (sobrepõe a agenda até `ate`; sem `ate`, ver cameras-regras.decidirArmar). */
  async armar(unidadeId: string, dto: ArmarDto, user?: Usuario, cliente?: ClienteInfo) {
    this.exigir(user, 'comandar');
    const id = unidadeId.trim();
    if (user) await this.scope.assertEntityInScope('unidade', id, user);
    const ctx = await this.auditoria.contextoUnidade(id);
    if (!ctx.unidade || !ctx.planta) throw new NotFoundException('Unidade não encontrada');
    const agora = new Date();
    const ate = dto.ate ? new Date(dto.ate) : null;
    if (ate && (Number.isNaN(ate.getTime()) || ate.getTime() <= agora.getTime())) {
      throw new BadRequestException('ate deve ser uma data futura');
    }

    const cfg = await this.config.armar(id, ctx.planta.id, dto.armado, ate, t(user?.id), agora);
    const resultado = { armado: estaArmado(cfg, agora), armado_ate: armadoAte(cfg, agora), armamento_modo: modoVigente(cfg, agora) };
    await this.auditoria.registrar(dto.armado ? 'camera_armada' : 'camera_desarmada', {
      mensagem: `Câmeras ${dto.armado ? 'armadas' : 'desarmadas'} manualmente${ate ? ` até ${horaLocal(ate)}` : ''} — ${ctx.unidade.nome} (${ctx.planta.nome})`,
      user,
      cliente,
      unidade: ctx.unidade,
      planta: ctx.planta,
      objetoTipo: 'unidade',
      objetoId: id,
      extra: { pedido: { armado: dto.armado, ate: ate?.toISOString() ?? null }, resultado },
    });
    return this.resumo(id, user);
  }

  /** Pulsa o ponto de comando configurado (mesmo caminho do acionar ponto; cai em logs_mqtt). */
  async acionar(unidadeId: string, dto: AcionarDto, user?: Usuario, cliente?: ClienteInfo) {
    this.exigir(user, 'comandar');
    const id = unidadeId.trim();
    if (user) await this.scope.assertEntityInScope('unidade', id, user);
    const ctx = await this.auditoria.contextoUnidade(id);
    if (!ctx.unidade) throw new NotFoundException('Unidade não encontrada');
    const cfg = await this.config.obter(id, ctx.planta?.id);
    const rotulo = ROTULO_DISPOSITIVO[dto.dispositivo];
    const equipamentoId = dto.dispositivo === 'refletor' ? cfg.refletor_equipamento_id : cfg.sirene_equipamento_id;
    const pontoId = dto.dispositivo === 'refletor' ? cfg.refletor_ponto_id : cfg.sirene_ponto_id;
    if (!equipamentoId || !pontoId) {
      throw new BadRequestException({ message: `${rotulo} não configurado nesta unidade`, code: 'DISPOSITIVO_NAO_CONFIGURADO' });
    }
    const base = {
      user,
      cliente,
      unidade: ctx.unidade,
      planta: ctx.planta,
      objetoTipo: 'unidade',
      objetoId: id,
    };
    try {
      const autor = user ? { id: user.id, role: user.role, nome: user.nome ?? undefined } : undefined;
      const r = await this.cmd.acionarPonto(equipamentoId, pontoId, autor, false, undefined, cliente);
      await this.auditoria.registrar('camera_comando', {
        ...base,
        mensagem: `${rotulo} acionado pelas câmeras — ${ctx.unidade.nome}${ctx.planta ? ` (${ctx.planta.nome})` : ''}`,
        extra: { dispositivo: dto.dispositivo, equipamento_id: equipamentoId, ponto_id: pontoId, resultado: r },
      });
      return r;
    } catch (e) {
      await this.auditoria.registrar('camera_comando', {
        ...base,
        mensagem: `${rotulo} NÃO acionado pelas câmeras — ${ctx.unidade.nome}: ${(e as Error).message}`,
        resultado: 'erro',
        extra: { dispositivo: dto.dispositivo, equipamento_id: equipamentoId, ponto_id: pontoId, erro: (e as Error).message },
      });
      throw e;
    }
  }

  tokenMidia(user?: Usuario) {
    return this.midia.gerarTokenMidia(user ?? {});
  }

  // ---------------------------------------------------------------------------
  // Apoio
  // ---------------------------------------------------------------------------

  private async buscar(id: string, user?: Usuario): Promise<cameras> {
    const c = await this.prisma.cameras.findFirst({ where: { id: (id ?? '').trim(), deleted_at: null } });
    if (!c) throw new NotFoundException('Câmera não encontrada');
    if (user) await this.scope.assertEntityInScope('unidade', c.unidade_id, user);
    return c;
  }

  /** Agente informado precisa existir e ser da mesma unidade. null = sem agente. */
  private async validarAgente(agenteId: string | null, unidadeId: string): Promise<string | null> {
    const id = t(agenteId);
    if (!id) return null;
    const a = await this.prisma.cameras_agentes.findFirst({
      where: { id, deleted_at: null },
      select: { id: true, unidade_id: true },
    });
    if (!a) throw new NotFoundException('Agente não encontrado');
    if (a.unidade_id !== unidadeId) throw new BadRequestException('O agente não é desta unidade');
    return a.id;
  }

  private async validarEquipamento(equipamentoId: string | null, user?: Usuario): Promise<string | null> {
    const id = t(equipamentoId);
    if (!id) return null;
    const e = await this.prisma.equipamentos.findFirst({ where: { id, deleted_at: null }, select: { id: true } });
    if (!e) throw new NotFoundException('Equipamento não encontrado');
    if (user) await this.scope.assertEntityInScope('equipamento', id, user);
    return e.id.trim();
  }

  /** Refletor/sirene: ponto de comando ativo do equipamento, dentro do escopo. */
  private async validarPonto(p: PontoComandoDto, user?: Usuario): Promise<void> {
    const eqId = p.equipamento_id.trim();
    const pId = p.ponto_id.trim();
    if (user) await this.scope.assertEntityInScope('equipamento', eqId, user);
    const ponto = await this.prisma.equipamento_pontos.findFirst({
      where: { id: pId, equipamento_id: eqId, deleted_at: null },
      select: { tipo: true, ativo: true, nome: true },
    });
    if (!ponto) throw new NotFoundException(`Ponto ${pId} não encontrado no equipamento ${eqId}`);
    if (ponto.tipo !== 'comando' || !ponto.ativo) throw new BadRequestException(`Ponto "${ponto.nome}" não é um comando ativo`);
  }

  private async proximaOrdem(unidadeId: string): Promise<number> {
    const r = await this.prisma.cameras.aggregate({ where: { unidade_id: unidadeId, deleted_at: null }, _max: { ordem: true } });
    return (r._max.ordem ?? 0) + 1;
  }

  private semSenha(c: cameras): Record<string, unknown> {
    const { senha: _senha, ...resto } = c;
    return resto;
  }

  private alteracoes(antes: Record<string, unknown>, depois: Record<string, unknown>): Record<string, { de: unknown; para: unknown }> {
    const out: Record<string, { de: unknown; para: unknown }> = {};
    for (const k of Object.keys(depois)) {
      if (k === 'updated_at') continue;
      if (JSON.stringify(antes[k]) !== JSON.stringify(depois[k])) out[k] = { de: antes[k], para: depois[k] };
    }
    return out;
  }
}
