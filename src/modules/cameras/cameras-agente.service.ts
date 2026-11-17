import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type cameras_agentes } from '@prisma/client';
import { PermissionScopeService, PrismaService } from '@/core';
import { capacidades, MSG_SOMENTE_LEITURA, papelCanonico } from '@/core/modules/auth/papeis';
import { novoId26, type ClienteInfo } from '@/core/common/cliente-info';
import { CamerasAuditoriaService } from './cameras-auditoria.service';
import { CamerasConfigService } from './cameras-config.service';
import { CamerasEventosService } from './cameras-eventos.service';
import { CamerasMidiaService } from './cameras-midia.service';
import {
  agenteOnline,
  analiseNovaCamera,
  gerarSenhaCamera,
  normalizarGravacaoConfig,
  caminhoStream,
  DESCOBERTA_VALIDADE_S,
  descobertasPendentes,
  ehJpeg,
  estaArmado,
  lerGravacao,
  montarRtsp,
  normalizarAnalise,
  normalizarDescobertas,
  normalizarGravacaoStatus,
  POLL_S,
  TRECHO_ARQUIVO_MAX_MB,
  TRECHO_DURACAO_MAX_S,
  streamAtivo,
  TIPOS_SISTEMA,
} from './cameras-regras';
import { CamerasStorageService } from './cameras-storage.service';
import type { AgenteInfo, Usuario } from './cameras.tipos';
import type { ClassificacaoEventoDto, EventoAgenteDto, FimEventoDto, HeartbeatDto, MiniaturaDto, ResultadoComandoDto } from './dto/cameras-agente.dto';
import type { CriarAgenteDto, ListarAgentesDto } from './dto/cameras.dto';

/**
 * Agentes locais (nexon-camera-agent): cadastro pelo admin (cadastroTecnico) e as rotas que o
 * próprio agente chama com o token (config, heartbeat, miniaturas, eventos, clipes, comandos).
 */
/** Limites do cadastro automático de câmera de fábrica. */
const AUTO_CADASTRO_POR_VEZ = 4;
const AUTO_CADASTRO_MAX_UNIDADE = 64;

@Injectable()
export class CamerasAgenteService {
  private readonly logger = new Logger(CamerasAgenteService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: PermissionScopeService,
    private readonly midia: CamerasMidiaService,
    private readonly storage: CamerasStorageService,
    private readonly eventos: CamerasEventosService,
    private readonly auditoria: CamerasAuditoriaService,
    private readonly config: CamerasConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // Administração (usuário com cadastroTecnico)
  // ---------------------------------------------------------------------------

  private exigirCadastro(user?: Usuario) {
    if (user && !capacidades(papelCanonico(user.role)).cadastroTecnico) throw new ForbiddenException(MSG_SOMENTE_LEITURA);
  }

  exigirCadastroTecnico(user?: Usuario) {
    this.exigirCadastro(user);
  }

  apresentar(a: cameras_agentes, totalCameras: number, agora = new Date(), pendentes = 0) {
    return {
      id: a.id,
      unidade_id: a.unidade_id,
      planta_id: a.planta_id,
      nome: a.nome,
      versao: a.versao,
      host: a.host,
      ultimo_contato_em: a.ultimo_contato_em,
      online: agenteOnline(a.ultimo_contato_em, agora),
      ativo: a.ativo,
      /** Número de câmeras ligadas ao agente (nome combinado com o front web). */
      cameras: totalCameras,
      /** NEXON-108: câmeras encontradas na rede (24 h) que ainda não foram cadastradas. */
      descobertas_pendentes: pendentes,
      token_gerado_em: a.token_gerado_em,
      created_at: a.created_at,
      updated_at: a.updated_at,
    };
  }

  async listar(q: ListarAgentesDto, user?: Usuario) {
    this.exigirCadastro(user);
    const unidadeId = q.unidade_id.trim();
    if (user) await this.scope.assertEntityInScope('unidade', unidadeId, user);
    const agentes = await this.prisma.cameras_agentes.findMany({
      where: { unidade_id: unidadeId, deleted_at: null },
      orderBy: { created_at: 'asc' },
      include: { _count: { select: { cameras: { where: { deleted_at: null } } } } },
    });
    const agora = new Date();
    const pendentes = await this.contarPendentes(unidadeId, agentes.map((a) => a.id), agora);
    return agentes.map((a) => this.apresentar(a, a._count.cameras, agora, pendentes.get(a.id) ?? 0));
  }

  /** Descobertas recentes ainda sem câmera cadastrada na unidade, por agente. */
  private async contarPendentes(unidadeId: string, agenteIds: string[], agora: Date) {
    const porAgente = new Map<string, number>();
    if (!agenteIds.length) return porAgente;
    const [descobertas, ips] = await Promise.all([
      this.prisma.cameras_descobertas.findMany({
        where: { agente_id: { in: agenteIds }, visto_em: { gte: new Date(agora.getTime() - DESCOBERTA_VALIDADE_S * 1000) } },
        select: { agente_id: true, ip: true, visto_em: true },
      }),
      this.ipsCadastrados(unidadeId),
    ]);
    for (const d of descobertasPendentes(descobertas, ips, agora)) porAgente.set(d.agente_id, (porAgente.get(d.agente_id) ?? 0) + 1);
    return porAgente;
  }

  /** IPs das câmeras cadastradas (não excluídas) na unidade. */
  private async ipsCadastrados(unidadeId: string): Promise<string[]> {
    const cams = await this.prisma.cameras.findMany({ where: { unidade_id: unidadeId, deleted_at: null }, select: { ip: true } });
    return cams.map((c) => c.ip);
  }

  /** GET /cameras/agentes/:id/descobertas — câmeras encontradas na rede (24 h) ainda não cadastradas. */
  async descobertas(id: string, user?: Usuario, agora = new Date()) {
    this.exigirCadastro(user);
    const a = await this.buscarAgente(id, user);
    const [descobertas, ips] = await Promise.all([
      this.prisma.cameras_descobertas.findMany({
        where: { agente_id: a.id, visto_em: { gte: new Date(agora.getTime() - DESCOBERTA_VALIDADE_S * 1000) } },
        orderBy: { ip: 'asc' },
      }),
      this.ipsCadastrados(a.unidade_id),
    ]);
    return descobertasPendentes(descobertas, ips, agora).map((d) => ({
      ip: d.ip,
      mac: d.mac,
      fabricante: d.fabricante,
      modelo: d.modelo,
      serial: d.serial,
      porta_http: d.porta_http,
      porta_rtsp: d.porta_rtsp,
      inicializada: d.inicializada,
      visto_em: d.visto_em,
    }));
  }

  /**
   * Grava o agente com token novo (sem auditoria nem checagem de permissão: quem chama já fez).
   * Usado pelo cadastro manual e pelo pareamento por código.
   */
  async inserirAgente(
    unidadeId: string,
    plantaId: string,
    nome: string,
    extra: { host?: string | null; versao?: string | null } = {},
  ): Promise<{ agente: cameras_agentes; token: string }> {
    const { token, hash } = this.midia.gerarTokenAgente();
    const agente = await this.prisma.cameras_agentes.create({
      data: {
        id: novoId26(),
        unidade_id: unidadeId,
        planta_id: plantaId,
        nome: nome.trim().slice(0, 120),
        token_hash: hash,
        token_gerado_em: new Date(),
        host: extra.host?.trim().slice(0, 120) || null,
        versao: extra.versao?.trim().slice(0, 40) || null,
      },
    });
    return { agente, token };
  }

  /** Cria o agente e devolve o token em claro — única vez em que ele aparece. */
  async criar(dto: CriarAgenteDto, user?: Usuario, cliente?: ClienteInfo) {
    this.exigirCadastro(user);
    const unidadeId = dto.unidade_id.trim();
    if (user) await this.scope.assertEntityInScope('unidade', unidadeId, user);
    const ctx = await this.auditoria.contextoUnidade(unidadeId);
    if (!ctx.unidade || !ctx.planta) throw new NotFoundException('Unidade não encontrada');

    const { agente: a, token } = await this.inserirAgente(unidadeId, ctx.planta.id, dto.nome);
    await this.auditoria.registrar('camera_agente', {
      mensagem: `Agente de câmeras "${a.nome}" criado (token gerado) — ${ctx.unidade.nome} (${ctx.planta.nome})`,
      user,
      cliente,
      unidade: ctx.unidade,
      planta: ctx.planta,
      objetoTipo: 'camera_agente',
      objetoId: a.id,
      extra: { agente: { id: a.id, nome: a.nome }, acao: 'criado' },
    });
    return { agente: this.apresentar(a, 0), token };
  }

  /** Token novo; o anterior deixa de valer na hora. */
  async novoToken(id: string, user?: Usuario, cliente?: ClienteInfo) {
    this.exigirCadastro(user);
    const a = await this.buscarAgente(id, user);
    const { token, hash } = this.midia.gerarTokenAgente();
    const atualizado = await this.prisma.cameras_agentes.update({
      where: { id: a.id },
      data: { token_hash: hash, token_gerado_em: new Date() },
    });
    const ctx = await this.auditoria.contextoUnidade(a.unidade_id);
    await this.auditoria.registrar('camera_agente_token', {
      mensagem: `Token do agente de câmeras "${a.nome}" gerado de novo (o anterior deixou de valer) — ${ctx.unidade?.nome ?? a.unidade_id}${ctx.planta ? ` (${ctx.planta.nome})` : ''}`,
      user,
      cliente,
      unidade: ctx.unidade,
      planta: ctx.planta,
      objetoTipo: 'camera_agente',
      objetoId: a.id,
      extra: { agente: { id: a.id, nome: a.nome } },
    });
    const total = await this.prisma.cameras.count({ where: { agente_id: a.id, deleted_at: null } });
    return { agente: this.apresentar(atualizado, total), token };
  }

  /** Exclusão lógica; as câmeras ficam sem agente e os comandos pendentes caem em erro. */
  async remover(id: string, user?: Usuario, cliente?: ClienteInfo) {
    this.exigirCadastro(user);
    const a = await this.buscarAgente(id, user);
    const agora = new Date();
    const [desvinculadas] = await this.prisma.$transaction([
      this.prisma.cameras.updateMany({ where: { agente_id: a.id, deleted_at: null }, data: { agente_id: null, publicando: false } }),
      this.prisma.cameras_comandos.updateMany({
        where: { agente_id: a.id, estado: { in: ['pendente', 'entregue'] } },
        data: { estado: 'erro', erro: 'Agente removido', concluido_em: agora },
      }),
      this.prisma.cameras_agentes.update({ where: { id: a.id }, data: { deleted_at: agora, ativo: false } }),
    ]);
    const ctx = await this.auditoria.contextoUnidade(a.unidade_id);
    await this.auditoria.registrar('camera_agente', {
      mensagem: `Agente de câmeras "${a.nome}" removido (${desvinculadas.count} câmera(s) sem agente) — ${ctx.unidade?.nome ?? a.unidade_id}${ctx.planta ? ` (${ctx.planta.nome})` : ''}`,
      user,
      cliente,
      unidade: ctx.unidade,
      planta: ctx.planta,
      objetoTipo: 'camera_agente',
      objetoId: a.id,
      extra: { agente: { id: a.id, nome: a.nome }, acao: 'removido', cameras_desvinculadas: desvinculadas.count },
    });
    return { id: a.id, removido: true, cameras_desvinculadas: desvinculadas.count };
  }

  private async buscarAgente(id: string, user?: Usuario) {
    const a = await this.prisma.cameras_agentes.findFirst({ where: { id: id.trim(), deleted_at: null } });
    if (!a) throw new NotFoundException('Agente não encontrado');
    if (user) await this.scope.assertEntityInScope('unidade', a.unidade_id, user);
    return a;
  }

  // ---------------------------------------------------------------------------
  // Rotas do agente (CameraAgenteGuard)
  // ---------------------------------------------------------------------------

  /** GET /cameras/agente/config — câmeras ativas do agente com RTSP (senha decifrada) e estado do stream. */
  async configDoAgente(agente: AgenteInfo, agora = new Date()) {
    const [cameras, config] = await Promise.all([
      this.prisma.cameras.findMany({
        where: { agente_id: agente.id, deleted_at: null, ativa: true },
        orderBy: [{ ordem: 'asc' }, { nome: 'asc' }],
      }),
      this.config.obter(agente.unidade_id, agente.planta_id),
    ]);
    const armado = estaArmado(config, agora);
    return {
      agente: { id: agente.id, nome: agente.nome, unidade_id: agente.unidade_id, planta_id: agente.planta_id },
      poll_s: POLL_S,
      midia: {
        publicar_base: this.midia.publicarBase(),
        usuario: 'agente',
        publicar_token: this.midia.gerarTokenPublicar(agente.id, agora),
      },
      cameras: cameras.map((c) => {
        const senha = this.midia.decifrar(c.senha);
        const base = { fabricante: c.fabricante, ip: c.ip, porta_rtsp: c.porta_rtsp, usuario: c.usuario, canal: c.canal };
        return {
          id: c.id,
          nome: c.nome,
          rtsp_principal: montarRtsp(base, senha, 0),
          rtsp_secundario: montarRtsp(base, senha, 1),
          armado,
          analise: normalizarAnalise(c.analise),
          /**
           * NEXON-108: gravação contínua no disco do aparelho. Trechos pedidos chegam como comando
           * `trecho` { inicio, duracao_s ≤ TRECHO_DURACAO_MAX_S } e voltam em
           * POST /cameras/agente/comandos/:id/arquivo (MP4 ≤ TRECHO_ARQUIVO_MAX_MB, campo `arquivo`).
           */
          gravacao: { ...lerGravacao(c.gravacao).config, trecho_max_s: TRECHO_DURACAO_MAX_S, trecho_max_mb: TRECHO_ARQUIVO_MAX_MB },
          stream: {
            caminho: caminhoStream(c.id),
            continuo: c.stream_continuo,
            ativo: streamAtivo(c.stream_pedido_em, c.stream_continuo, agora),
            transcodificar: c.stream_transcodificar,
            bitrate_kbps: c.stream_bitrate_kbps,
          },
        };
      }),
    };
  }

  /** POST /cameras/agente/heartbeat — contato do agente e status de cada câmera. */
  async heartbeat(agente: AgenteInfo, dto: HeartbeatDto, agora = new Date()) {
    await this.prisma.cameras_agentes.update({
      where: { id: agente.id },
      data: {
        ultimo_contato_em: agora,
        ...(dto.versao?.trim() ? { versao: dto.versao.trim().slice(0, 40) } : {}),
        ...(dto.host?.trim() ? { host: dto.host.trim().slice(0, 120) } : {}),
      },
    });
    const ids = [...new Set(dto.cameras.map((c) => c.id.trim()).filter(Boolean))];
    const cameras = ids.length
      ? await this.prisma.cameras.findMany({ where: { id: { in: ids }, agente_id: agente.id, deleted_at: null } })
      : [];
    const porId = new Map(cameras.map((c) => [c.id, c]));
    for (const hc of dto.cameras) {
      const c = porId.get(hc.id.trim());
      if (!c) continue; // câmera de outro agente ou inexistente: ignora
      if (hc.erro) this.logger.warn(`[cameras] agente ${agente.nome} · câmera ${c.nome}: ${hc.erro}`);
      if (hc.online) await this.eventos.marcarOnline(c, agora, { publicando: hc.publicando ?? false });
      else await this.eventos.marcarOffline(c, agora);
      if (hc.gravacao) await this.gravarStatusGravacao(c, hc.gravacao, agora);
    }
    if (dto.descobertas !== undefined) await this.gravarDescobertas(agente, dto.descobertas, agora);
    return { ok: true, agora: agora.toISOString() };
  }

  /** NEXON-108: guarda o último estado da gravação no aparelho em cameras.gravacao.status (não mexe na config). */
  private async gravarStatusGravacao(c: { id: string; nome: string; gravacao?: unknown }, g: unknown, agora: Date) {
    const atual = (c.gravacao && typeof c.gravacao === 'object' && !Array.isArray(c.gravacao) ? c.gravacao : {}) as Record<string, unknown>;
    try {
      await this.prisma.cameras.update({
        where: { id: c.id },
        data: { gravacao: { ...atual, status: normalizarGravacaoStatus(g, agora) } as unknown as Prisma.InputJsonValue },
      });
    } catch (e) {
      this.logger.warn(`[cameras] câmera ${c.nome}: estado da gravação não gravado: ${(e as Error).message}`);
    }
  }

  /** Upsert por (agente, ip) do que veio no heartbeat; apaga o que não é visto há mais de 1 dia. */
  private async gravarDescobertas(agente: AgenteInfo, lista: unknown, agora: Date) {
    const itens = normalizarDescobertas(lista);
    try {
      await this.prisma.$transaction([
        ...itens.map((d) => {
          const dados = {
            mac: d.mac,
            fabricante: d.fabricante,
            modelo: d.modelo,
            serial: d.serial,
            porta_http: d.porta_http,
            porta_rtsp: d.porta_rtsp,
            inicializada: d.inicializada,
            visto_em: agora,
          };
          return this.prisma.cameras_descobertas.upsert({
            where: { agente_id_ip: { agente_id: agente.id, ip: d.ip } },
            create: { id: novoId26(), agente_id: agente.id, ip: d.ip, ...dados },
            update: dados,
          });
        }),
        this.prisma.cameras_descobertas.deleteMany({
          where: { agente_id: agente.id, visto_em: { lt: new Date(agora.getTime() - DESCOBERTA_VALIDADE_S * 1000) } },
        }),
      ]);
    } catch (e) {
      // Descoberta é ajuda de cadastro: falha aqui não pode derrubar o heartbeat (status das câmeras).
      this.logger.warn(`[cameras] agente ${agente.nome}: descobertas não gravadas: ${(e as Error).message}`);
    }
    try {
      await this.autoCadastrar(agente, itens);
    } catch (e) {
      this.logger.warn(`[cameras] agente ${agente.nome}: cadastro automático falhou: ${(e as Error).message}`);
    }
    try {
      await this.seguirMac(agente, itens);
    } catch (e) {
      this.logger.warn(`[cameras] agente ${agente.nome}: IP das câmeras não conferido: ${(e as Error).message}`);
    }
  }

  /**
   * Câmera Intelbras/Dahua de fábrica (sem senha) achada pelo aparelho entra sozinha no NexON: nome "Câmera N",
   * usuário admin e senha forte gerada (cifrada). O aparelho vê a câmera na config e grava essa senha nela
   * (DevInit). Desliga por usina em cameras_unidade_config.auto_cadastrar. Audit camera_cadastro (automático).
   */
  /**
   * POST /cameras/agente/descobertas/senha-conhecida { ip, camera_id }: o aparelho achou na rede uma câmera com
   * senha que não está no NexON e conseguiu entrar nela com a senha de outra câmera da usina (`camera_id`).
   * Cadastra sozinha copiando usuário e senha (cifrada) dessa câmera; a senha nunca trafega.
   * Mesmas travas do cadastro automático (opção da usina, Intelbras/Dahua, 64 por usina, sem duplicar IP/MAC).
   */
  async senhaConhecida(agente: AgenteInfo, ip: string, cameraId: string) {
    const ref = await this.cameraDoAgente(agente, cameraId);
    const d = await this.prisma.cameras_descobertas.findFirst({ where: { agente_id: agente.id, ip: ip.trim() } });
    if (!d || !d.mac || !d.fabricante || !['intelbras', 'dahua'].includes(d.fabricante.toLowerCase())) {
      return { cadastrada: false, motivo: 'descoberta_invalida' };
    }
    const cfg = await this.config.obter(agente.unidade_id, agente.planta_id);
    if (cfg.auto_cadastrar === false) return { cadastrada: false, motivo: 'auto_cadastro_desligado' };
    const mac = d.mac.toLowerCase();
    const existe = await this.prisma.cameras.findFirst({
      where: { deleted_at: null, OR: [{ agente_id: agente.id, ip: d.ip }, { mac }] },
      select: { id: true },
    });
    if (existe) return { cadastrada: false, motivo: 'ja_cadastrada' };
    const total = await this.prisma.cameras.count({ where: { unidade_id: agente.unidade_id, deleted_at: null } });
    if (total >= AUTO_CADASTRO_MAX_UNIDADE) return { cadastrada: false, motivo: 'limite' };
    const c = await this.prisma.cameras.create({
      data: {
        id: novoId26(),
        unidade_id: agente.unidade_id,
        planta_id: agente.planta_id,
        agente_id: agente.id,
        nome: `Câmera ${total + 1}`,
        fabricante: d.fabricante.toLowerCase(),
        modelo: d.modelo,
        ip: d.ip,
        mac,
        porta_rtsp: d.porta_rtsp ?? 554,
        porta_http: d.porta_http ?? 80,
        usuario: ref.usuario,
        senha: ref.senha,
        canal: 1,
        ordem: total + 1,
        analise: analiseNovaCamera({}) as unknown as Prisma.InputJsonValue,
        gravacao: { config: normalizarGravacaoConfig(undefined) } as unknown as Prisma.InputJsonValue,
      },
    });
    this.logger.log(`[cameras] agente ${agente.nome}: câmera ${d.ip} (${mac}) cadastrada sozinha com a senha de "${ref.nome}"`);
    const ctx = await this.auditoria.contextoUnidade(agente.unidade_id);
    await this.auditoria.registrar('camera_cadastro', {
      mensagem: `Câmera "${c.nome}" (${c.ip}) cadastrada sozinha pelo aparelho ${agente.nome} (mesma senha da câmera "${ref.nome}") — ${ctx.unidade?.nome ?? agente.unidade_id}${ctx.planta ? ` (${ctx.planta.nome})` : ''}`,
      user: null,
      unidade: ctx.unidade,
      planta: ctx.planta,
      camera: { id: c.id, nome: c.nome, ip: c.ip, unidade_id: c.unidade_id },
      objetoTipo: 'camera',
      objetoId: c.id,
      extra: { automatico: true, origem: 'senha_conhecida', senha_de: { id: ref.id, nome: ref.nome }, mac, serial: d.serial, modelo: d.modelo },
    });
    return { cadastrada: true, camera_id: c.id };
  }

  private async autoCadastrar(
    agente: AgenteInfo,
    itens: { ip: string; mac: string | null; fabricante: string | null; modelo: string | null; serial: string | null; porta_http: number | null; inicializada: boolean | null }[],
  ) {
    // Só Intelbras/Dahua declarada pela descoberta, com MAC; no máximo AUTO_CADASTRO_POR_VEZ por heartbeat e
    // AUTO_CADASTRO_MAX_UNIDADE câmeras na usina (aparelho com problema não enche o cadastro).
    const novas = itens
      .filter((d) => d.inicializada === false && d.mac && !!d.fabricante && ['intelbras', 'dahua'].includes(d.fabricante.toLowerCase()))
      .slice(0, AUTO_CADASTRO_POR_VEZ);
    if (novas.length === 0 || !agente.unidade_id || !agente.planta_id) return;
    const cfg = await this.config.obter(agente.unidade_id, agente.planta_id);
    if (cfg.auto_cadastrar === false) return;
    const macs = novas.map((d) => d.mac!.toLowerCase());
    const existentes = await this.prisma.cameras.findMany({
      where: { deleted_at: null, OR: [{ agente_id: agente.id, ip: { in: novas.map((d) => d.ip) } }, { mac: { in: macs } }] },
      select: { ip: true, mac: true },
    });
    const ja = new Set(existentes.flatMap((c) => [c.ip, (c.mac ?? '').toLowerCase()]));
    let total = await this.prisma.cameras.count({ where: { unidade_id: agente.unidade_id, deleted_at: null } });
    if (total >= AUTO_CADASTRO_MAX_UNIDADE) return;
    const ctx = await this.auditoria.contextoUnidade(agente.unidade_id);
    for (const d of novas) {
      const mac = d.mac!.toLowerCase();
      if (ja.has(d.ip) || ja.has(mac) || total >= AUTO_CADASTRO_MAX_UNIDADE) continue;
      total += 1;
      const c = await this.prisma.cameras.create({
        data: {
          id: novoId26(),
          unidade_id: agente.unidade_id,
          planta_id: agente.planta_id,
          agente_id: agente.id,
          nome: `Câmera ${total}`,
          fabricante: (d.fabricante ?? 'intelbras').toLowerCase(),
          modelo: d.modelo,
          ip: d.ip,
          mac,
          porta_rtsp: 554,
          porta_http: d.porta_http ?? 80,
          usuario: 'admin',
          senha: this.midia.cifrar(gerarSenhaCamera()),
          canal: 1,
          ordem: total,
          analise: analiseNovaCamera({}) as unknown as Prisma.InputJsonValue,
          gravacao: { config: normalizarGravacaoConfig(undefined) } as unknown as Prisma.InputJsonValue,
        },
      });
      ja.add(d.ip);
      ja.add(mac);
      this.logger.log(`[cameras] agente ${agente.nome}: câmera de fábrica ${d.ip} (${mac}) cadastrada sozinha como "${c.nome}"`);
      await this.auditoria.registrar('camera_cadastro', {
        mensagem: `Câmera "${c.nome}" (${c.ip}) cadastrada sozinha pelo aparelho ${agente.nome} (nova de fábrica; senha criada pelo aparelho) — ${ctx.unidade?.nome ?? agente.unidade_id}${ctx.planta ? ` (${ctx.planta.nome})` : ''}`,
        user: null,
        unidade: ctx.unidade,
        planta: ctx.planta,
        camera: { id: c.id, nome: c.nome, ip: c.ip, unidade_id: c.unidade_id },
        objetoTipo: 'camera',
        objetoId: c.id,
        extra: { automatico: true, mac, serial: d.serial, modelo: d.modelo, agente: { id: agente.id, nome: agente.nome } },
      });
    }
  }

  /**
   * A câmera é a mesma enquanto o MAC for o mesmo: guarda o MAC (descoberta no mesmo IP) e, quando o
   * aparelho muda de rede ou o roteador dá outro IP, troca cameras.ip sozinho (audit camera_ip_atualizado).
   */
  private async seguirMac(agente: AgenteInfo, itens: { ip: string; mac: string | null }[]) {
    const comMac = itens.filter((d) => d.mac);
    if (comMac.length === 0) return;
    const cams = await this.prisma.cameras.findMany({
      where: { agente_id: agente.id, deleted_at: null },
      select: { id: true, nome: true, ip: true, mac: true, unidade_id: true },
    });
    const ipsEmUso = new Set(cams.map((c) => c.ip));
    for (const c of cams) {
      const mac = c.mac?.toLowerCase() ?? null;
      if (!mac) {
        const mesmoIp = comMac.find((d) => d.ip === c.ip);
        if (mesmoIp?.mac) await this.prisma.cameras.update({ where: { id: c.id }, data: { mac: mesmoIp.mac.toLowerCase() } });
        continue;
      }
      const achada = comMac.find((d) => d.mac!.toLowerCase() === mac);
      if (!achada || achada.ip === c.ip || ipsEmUso.has(achada.ip)) continue;
      await this.prisma.cameras.update({ where: { id: c.id }, data: { ip: achada.ip } });
      ipsEmUso.delete(c.ip);
      ipsEmUso.add(achada.ip);
      this.logger.log(`[cameras] câmera ${c.nome}: IP ${c.ip} -> ${achada.ip} (mesmo MAC ${mac})`);
      const ctx = await this.auditoria.contextoUnidade(c.unidade_id);
      await this.auditoria.registrar('camera_ip_atualizado', {
        mensagem: `Câmera "${c.nome}" mudou de endereço ${c.ip} → ${achada.ip} (mesmo MAC ${mac}) — ${ctx.unidade?.nome ?? c.unidade_id}${ctx.planta ? ` (${ctx.planta.nome})` : ''}`,
        user: null,
        unidade: ctx.unidade,
        planta: ctx.planta,
        camera: { id: c.id, nome: c.nome, ip: achada.ip, unidade_id: c.unidade_id },
        objetoTipo: 'camera',
        objetoId: c.id,
        extra: { ip_anterior: c.ip, ip_novo: achada.ip, mac, agente: { id: agente.id, nome: agente.nome } },
      });
    }
  }

  /** POST /cameras/agente/miniaturas (multipart: camera_id + arquivo JPEG). */
  async miniatura(agente: AgenteInfo, dto: MiniaturaDto, file?: Express.Multer.File) {
    const c = await this.cameraDoAgente(agente, dto.camera_id);
    if (!file?.buffer?.length) throw new BadRequestException('Envie o JPEG no campo "arquivo"');
    if (!ehJpeg(file.buffer)) throw new BadRequestException('Miniatura deve ser JPEG');
    await this.storage.salvar(this.storage.caminhoMiniatura(c.id), file.buffer);
    const agora = new Date();
    await this.prisma.cameras.update({ where: { id: c.id }, data: { miniatura_em: agora } });
    return { ok: true, miniatura_em: agora.toISOString() };
  }

  /** POST /cameras/agente/eventos (multipart). Sistema (sem_sinal/sinal_restabelecido) também muda o status. */
  async evento(agente: AgenteInfo, dto: EventoAgenteDto, file?: Express.Multer.File) {
    const c = await this.cameraDoAgente(agente, dto.camera_id);
    if ((TIPOS_SISTEMA as readonly string[]).includes(dto.tipo)) {
      const agora = new Date();
      const inicio = new Date(dto.inicio_em);
      if (Number.isNaN(inicio.getTime())) throw new BadRequestException('inicio_em inválido');
      const semSinal = dto.tipo === 'sem_sinal';
      await this.eventos.atualizarStatus(c, semSinal ? 'offline' : 'online', agora);
      const r = await this.eventos.registrarSistema(c, semSinal ? 'sem_sinal' : 'sinal_restabelecido', agora, inicio);
      return { id: r.id, alerta: semSinal, descartado: false, motivo_descarte: null, enviar_clipe: false };
    }
    return this.eventos.registrarDoAgente(c, dto, file?.buffer);
  }

  async fimEvento(agente: AgenteInfo, id: string, dto: FimEventoDto) {
    const e = await this.eventoDoAgente(agente, id);
    // Câmera só é buscada se o fim pode reclassificar (evento ainda `movimento`).
    const c = e.tipo === 'movimento' ? await this.cameraDoEvento(e.camera_id) : null;
    await this.eventos.fim(e, dto, c);
    return { ok: true };
  }

  /** POST /cameras/agente/eventos/:id/classificacao — movimento → pessoa/veículo/animal (NEXON-108). */
  async classificacao(agente: AgenteInfo, id: string, dto: ClassificacaoEventoDto, file?: Express.Multer.File) {
    const e = await this.eventoDoAgente(agente, id);
    const c = await this.cameraDoEvento(e.camera_id);
    return this.eventos.reclassificar(e, c, dto, file?.buffer?.length ? file.buffer : undefined);
  }

  async clipe(agente: AgenteInfo, id: string, file?: Express.Multer.File) {
    const e = await this.eventoDoAgente(agente, id);
    if (!file?.buffer?.length) throw new BadRequestException('Envie o MP4 no campo "clipe"');
    await this.eventos.clipe(e, file.buffer);
    return { ok: true, clipe_url: `/api/v1/cameras/eventos/${e.id}/clipe` };
  }

  /** GET /cameras/agente/comandos — pendentes, marcados como entregues. */
  async comandos(agente: AgenteInfo, agora = new Date()) {
    const pendentes = await this.prisma.cameras_comandos.findMany({
      where: { agente_id: agente.id, estado: 'pendente' },
      orderBy: { created_at: 'asc' },
      take: 20,
    });
    if (pendentes.length) {
      await this.prisma.cameras_comandos.updateMany({
        where: { id: { in: pendentes.map((c) => c.id) } },
        data: { estado: 'entregue', entregue_em: agora },
      });
    }
    return { comandos: pendentes.map((c) => ({ id: c.id, camera_id: c.camera_id, tipo: c.tipo, parametros: c.parametros })) };
  }

  async resultado(agente: AgenteInfo, id: string, dto: ResultadoComandoDto) {
    const c = await this.prisma.cameras_comandos.findFirst({ where: { id: id.trim(), agente_id: agente.id } });
    if (!c) throw new NotFoundException('Comando não encontrado');
    await this.prisma.cameras_comandos.update({
      where: { id: c.id },
      data: {
        estado: dto.ok ? 'ok' : 'erro',
        erro: dto.ok ? null : (dto.erro?.trim() || 'erro no agente').slice(0, 500),
        evento_id: dto.evento_id?.trim() || null,
        ...(dto.dados ? { resultado: dto.dados as Prisma.InputJsonValue } : {}),
        concluido_em: new Date(),
      },
    });
    return { ok: true };
  }

  private async cameraDoAgente(agente: AgenteInfo, cameraId: string) {
    const c = await this.prisma.cameras.findFirst({ where: { id: (cameraId ?? '').trim(), agente_id: agente.id, deleted_at: null } });
    if (!c) throw new NotFoundException('Câmera não encontrada para este agente');
    return c;
  }

  /** Câmera do evento (mesmo se removida depois: o evento continua dela). */
  private async cameraDoEvento(cameraId: string) {
    const c = await this.prisma.cameras.findFirst({ where: { id: cameraId } });
    if (!c) throw new NotFoundException('Câmera do evento não encontrada');
    return c;
  }

  private async eventoDoAgente(agente: AgenteInfo, id: string) {
    const e = await this.prisma.cameras_eventos.findFirst({ where: { id: (id ?? '').trim(), camera: { agente_id: agente.id } } });
    if (!e) throw new NotFoundException('Evento não encontrado');
    return e;
  }
}
