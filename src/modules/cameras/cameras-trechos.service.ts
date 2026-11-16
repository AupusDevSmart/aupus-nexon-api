import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { cameras, cameras_comandos } from '@prisma/client';
import type { Request, Response } from 'express';
import { PermissionScopeService, PrismaService } from '@/core';
import { novoId26, type ClienteInfo } from '@/core/common/cliente-info';
import { CamerasDespertarService } from './cameras-despertar.service';
import { CamerasAuditoriaService } from './cameras-auditoria.service';
import { CamerasMidiaService } from './cameras-midia.service';
import {
  nomeDownload,
  agenteOnline,
  ehMp4,
  ERRO_TRECHO_EXPIRADO,
  estadoTrecho,
  GRAVACAO_DIAS_MAX,
  horaLocal,
  TRECHO_ARQUIVO_MAX_MB,
  TRECHO_ARQUIVO_VIDA_S,
  TRECHO_EXPIRA_S,
  TRECHO_PENDENTES_MAX,
  trechoVencido,
} from './cameras-regras';
import { CamerasStorageService } from './cameras-storage.service';
import type { AgenteInfo, Usuario } from './cameras.tipos';
import type { PedirTrechoDto } from './dto/cameras.dto';

const TIPO = 'trecho';
const t = (v: string | null | undefined) => (v ? v.trim() : null);

/**
 * NEXON-108 — Histórico gravado no aparelho. A câmera e o agente nunca ficam expostos (ADR 0004):
 * o usuário pede um trecho (comando `trecho` { inicio, duracao_s }), o agente corta do disco local
 * e envia o MP4 em POST /cameras/agente/comandos/:id/arquivo; o arquivo fica em
 * CAMERAS_STORAGE_DIR/trechos/<comando_id>.mp4 por 24 h e é servido com token de mídia.
 * Permissão: a mesma de ver eventos e o ao vivo (escopo da unidade, sem capacidade extra).
 */
@Injectable()
export class CamerasTrechosService {
  private readonly logger = new Logger(CamerasTrechosService.name);
  private limpando = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: PermissionScopeService,
    private readonly midia: CamerasMidiaService,
    private readonly storage: CamerasStorageService,
    private readonly auditoria: CamerasAuditoriaService,
    @Optional() private readonly despertar?: CamerasDespertarService,
  ) {}

  /** POST /cameras/:id/trechos */
  async pedir(cameraId: string, dto: PedirTrechoDto, user?: Usuario, cliente?: ClienteInfo, agora = new Date()) {
    const c = await this.buscarCamera(cameraId, user);
    const inicio = new Date(dto.inicio);
    if (Number.isNaN(inicio.getTime())) throw new BadRequestException('inicio inválido');
    if (inicio.getTime() > agora.getTime()) throw new BadRequestException('inicio no futuro');
    if (agora.getTime() - inicio.getTime() > (GRAVACAO_DIAS_MAX + 1) * 86_400_000) {
      throw new BadRequestException(`O aparelho guarda no máximo ${GRAVACAO_DIAS_MAX} dias`);
    }

    const ctx = await this.auditoria.contextoUnidade(c.unidade_id);
    const camera = { id: c.id, nome: c.nome, ip: c.ip, unidade_id: c.unidade_id };
    const agente = c.agente_id
      ? await this.prisma.cameras_agentes.findFirst({
          where: { id: c.agente_id, deleted_at: null, ativo: true },
          select: { id: true, nome: true, ultimo_contato_em: true },
        })
      : null;
    if (!agente || !agenteOnline(agente.ultimo_contato_em, agora)) {
      throw new ConflictException({
        message: agente ? 'O aparelho desta câmera está offline' : 'Esta câmera não tem aparelho',
        code: 'CAMERA_SEM_AGENTE',
      });
    }

    const limite = new Date(agora.getTime() - TRECHO_EXPIRA_S * 1000);
    const abertos = await this.prisma.cameras_comandos.count({
      where: {
        camera_id: c.id,
        tipo: TIPO,
        OR: [
          { estado: 'pendente', created_at: { gte: limite } },
          { estado: 'entregue', entregue_em: { gte: limite } },
        ],
      },
    });
    if (abertos >= TRECHO_PENDENTES_MAX) {
      throw new HttpException(
        { message: `Já há ${abertos} trechos sendo buscados nesta câmera; aguarde`, code: 'TRECHOS_DEMAIS' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const parametros = { inicio: inicio.toISOString(), duracao_s: dto.duracao_s };
    const cmd = await this.prisma.cameras_comandos.create({
      data: { id: novoId26(), camera_id: c.id, agente_id: agente.id, tipo: TIPO, parametros, solicitado_por_id: t(user?.id) },
    });
    this.despertar?.despertar(agente.id);
    await this.auditoria.registrar('camera_trecho_pedido', {
      mensagem:
        `Trecho do histórico pedido à câmera "${c.nome}" (${c.ip}): ${horaLocal(inicio)}, ${dto.duracao_s} s — ` +
        `${ctx.unidade?.nome ?? c.unidade_id}${ctx.planta ? ` (${ctx.planta.nome})` : ''}`,
      user,
      cliente,
      unidade: ctx.unidade,
      planta: ctx.planta,
      camera,
      extra: { comando: { id: cmd.id, tipo: TIPO }, inicio: parametros.inicio, duracao_s: dto.duracao_s, agente: { id: agente.id, nome: agente.nome } },
    });
    return { comando_id: cmd.id, estado: 'pendente' as const };
  }

  /** GET /cameras/trechos/:comando_id */
  async estado(comandoId: string, user?: Usuario, agora = new Date()) {
    let cmd = await this.buscarComando(comandoId, user);
    if ((cmd.estado === 'pendente' || cmd.estado === 'entregue') && trechoVencido(cmd, agora)) {
      await this.prisma.cameras_comandos.updateMany({
        where: { id: cmd.id, estado: { in: ['pendente', 'entregue'] } },
        data: { estado: 'erro', erro: ERRO_TRECHO_EXPIRADO, concluido_em: agora },
      });
      cmd = { ...cmd, estado: 'erro', erro: ERRO_TRECHO_EXPIRADO, concluido_em: agora };
    }
    const rel = this.storage.caminhoTrecho(cmd.id);
    const existe = cmd.estado === 'ok' ? await this.storage.existe(rel) : false;
    const estado = estadoTrecho(cmd, existe, agora);
    const p = (cmd.parametros ?? {}) as { inicio?: string; duracao_s?: number };
    const out: {
      comando_id: string;
      estado: typeof estado;
      inicio: string | null;
      duracao_s: number | null;
      erro?: string;
      url?: string;
    } = { comando_id: cmd.id, estado, inicio: p.inicio ?? null, duracao_s: p.duracao_s ?? null };
    if (estado === 'erro') out.erro = cmd.erro ?? 'erro no aparelho';
    if (estado === 'pronto') {
      const { token } = this.midia.gerarTokenMidia(user ?? {}, agora);
      out.url = `/api/v1/cameras/trechos/${cmd.id}/arquivo?token=${encodeURIComponent(token)}`;
    }
    return out;
  }

  /** GET /cameras/trechos/:comando_id/arquivo (JWT ou ?token=) — MP4 com Range. */
  /** MP4 do trecho. `baixar`: vem como anexo com nome legível e entra no audit log (camera_download). */
  async arquivo(comandoId: string, user: Usuario | undefined, req: Request, res: Response, baixar = false, cliente?: ClienteInfo): Promise<void> {
    const cmd = await this.buscarComando(comandoId, user);
    if (cmd.estado !== 'ok') throw new NotFoundException('Trecho ainda não disponível');
    let nome: string | null = null;
    if (baixar) {
      const c = await this.buscarCamera(cmd.camera_id);
      const p = (cmd.parametros ?? {}) as { inicio?: string; duracao_s?: number };
      const inicio = p.inicio ? new Date(p.inicio) : cmd.created_at;
      nome = nomeDownload(c.nome, inicio, `historico-${p.duracao_s ?? ''}s`, 'mp4');
      const ctx = await this.auditoria.contextoUnidade(c.unidade_id);
      await this.auditoria.registrar('camera_download', {
        mensagem: `Trecho do histórico baixado — câmera "${c.nome}" (${c.ip}), ${ctx.unidade?.nome ?? c.unidade_id}${ctx.planta ? ` (${ctx.planta.nome})` : ''}`,
        user,
        cliente,
        unidade: ctx.unidade,
        planta: ctx.planta,
        camera: { id: c.id, nome: c.nome, ip: c.ip, unidade_id: c.unidade_id },
        objetoTipo: 'camera_trecho',
        objetoId: cmd.id,
        extra: { arquivo: nome, inicio: inicio.toISOString(), duracao_s: p.duracao_s ?? null },
      });
    }
    await this.storage.servir(req, res, this.storage.caminhoTrecho(cmd.id), 'video/mp4', baixar ? 'private, no-store' : 'private, max-age=3600', nome);
  }

  /** POST /cameras/agente/comandos/:id/arquivo — MP4 do trecho (campo `arquivo`). */
  async receber(agente: AgenteInfo, comandoId: string, file?: Express.Multer.File, agora = new Date()) {
    const cmd = await this.prisma.cameras_comandos.findFirst({ where: { id: (comandoId ?? '').trim(), agente_id: agente.id } });
    if (!cmd) throw new NotFoundException('Comando não encontrado');
    if (cmd.tipo !== TIPO) throw new BadRequestException('Este comando não recebe arquivo');
    if (!file?.buffer?.length) throw new BadRequestException('Envie o MP4 no campo "arquivo"');
    if (file.buffer.length > TRECHO_ARQUIVO_MAX_MB * 1024 * 1024) throw new BadRequestException(`Trecho maior que ${TRECHO_ARQUIVO_MAX_MB} MB`);
    if (!ehMp4(file.buffer)) throw new BadRequestException('Trecho deve ser MP4');
    // Chegou depois de expirar: aceita mesmo assim (quem perguntar de novo já vê pronto).
    await this.storage.salvar(this.storage.caminhoTrecho(cmd.id), file.buffer);
    await this.prisma.cameras_comandos.update({
      where: { id: cmd.id },
      data: { estado: 'ok', erro: null, concluido_em: agora },
    });
    return { ok: true, comando_id: cmd.id, bytes: file.buffer.length };
  }

  /** De hora em hora: apaga trechos com mais de 24 h e encerra pedidos sem resposta. CAMERAS_WORKER=off desliga. */
  @Interval(60 * 60_000)
  async tick() {
    if (this.limpando || process.env.CAMERAS_WORKER === 'off') return;
    this.limpando = true;
    try {
      const r = await this.limpar();
      if (r.arquivos || r.expirados) this.logger.log(`[cameras] trechos: ${r.arquivos} arquivo(s) apagado(s), ${r.expirados} pedido(s) expirado(s)`);
    } catch (e) {
      this.logger.warn(`[cameras] limpeza de trechos: ${(e as Error).message}`);
    } finally {
      this.limpando = false;
    }
  }

  async limpar(agora = new Date()): Promise<{ arquivos: number; expirados: number }> {
    const arquivos = await this.storage.limparAntigos('trechos', TRECHO_ARQUIVO_VIDA_S * 1000, agora);
    const limite = new Date(agora.getTime() - TRECHO_EXPIRA_S * 1000);
    const r = await this.prisma.cameras_comandos.updateMany({
      where: {
        tipo: TIPO,
        OR: [
          { estado: 'pendente', created_at: { lt: limite } },
          { estado: 'entregue', entregue_em: { lt: limite } },
        ],
      },
      data: { estado: 'erro', erro: ERRO_TRECHO_EXPIRADO, concluido_em: agora },
    });
    return { arquivos, expirados: r.count };
  }

  private async buscarCamera(id: string, user?: Usuario): Promise<cameras> {
    const c = await this.prisma.cameras.findFirst({ where: { id: (id ?? '').trim(), deleted_at: null } });
    if (!c) throw new NotFoundException('Câmera não encontrada');
    if (user) await this.scope.assertEntityInScope('unidade', c.unidade_id, user);
    return c;
  }

  private async buscarComando(id: string, user?: Usuario): Promise<cameras_comandos> {
    const cmd = await this.prisma.cameras_comandos.findFirst({ where: { id: (id ?? '').trim(), tipo: TIPO } });
    if (!cmd) throw new NotFoundException('Pedido de trecho não encontrado');
    await this.buscarCamera(cmd.camera_id, user);
    return cmd;
  }
}
