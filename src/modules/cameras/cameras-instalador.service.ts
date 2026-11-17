import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import type { Request, Response } from 'express';
import { PermissionScopeService } from '@/core';
import { capacidades, papelCanonico } from '@/core/modules/auth/papeis';
import type { ClienteInfo } from '@/core/common/cliente-info';
import { CamerasAuditoriaService } from './cameras-auditoria.service';
import { CamerasMidiaService } from './cameras-midia.service';
import { CamerasStorageService } from './cameras-storage.service';
import type { Usuario } from './cameras.tipos';

/** storage/cameras/instalador: atual.json + <arquivo>.img.gz + instalar-pelo-pc.sh (deploy/publicar-instalador.sh). */
const PASTA = 'instalador';

interface ManifestoInstalador {
  versao: string;
  arquivo: string;
  sha256: string;
  tamanho: number;
  publicado_em?: string;
}

/**
 * Instalação de Raspberry novo (NEXON-108): a imagem única do NexON (vale para SD, pendrive e para gravar pelo
 * cabo USB-C) e o script do PC, entregues com token de mídia do usuário (2 h). Quem pede fica na auditoria.
 */
@Injectable()
export class CamerasInstaladorService {
  constructor(
    private readonly storage: CamerasStorageService,
    private readonly midia: CamerasMidiaService,
    private readonly auditoria: CamerasAuditoriaService,
    private readonly scope: PermissionScopeService,
  ) {}

  private async manifesto(): Promise<ManifestoInstalador> {
    try {
      const m = JSON.parse(await readFile(this.storage.absoluto(`${PASTA}/atual.json`), 'utf8')) as ManifestoInstalador;
      if (m?.versao && /^[\w.-]+\.img\.gz$/.test(m.arquivo) && /^[0-9a-f]{64}$/.test(m.sha256)) return m;
    } catch {
      /* sem instalador publicado */
    }
    throw new NotFoundException('Nenhum instalador publicado');
  }

  private exigir(user?: Usuario) {
    if (!user || !capacidades(papelCanonico(user.role)).cadastroTecnico) {
      throw new ForbiddenException('Sem permissão para instalar aparelhos');
    }
  }

  /** Endereço do instalador. Vai dentro de scripts (bash e PowerShell): só aceita host e protocolo limpos. */
  private base(req: Request): string {
    const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol ?? 'https').split(',')[0].trim();
    const host = String(req.get('host') ?? '');
    if (!/^https?$/.test(proto) || !/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host)) throw new BadRequestException('Endereço inválido');
    return `${proto}://${host}/api/v1/cameras/instalador`;
  }

  /** GET /cameras/instalador — versão, links com token (2 h) e o comando para colar no Terminal. */
  async info(user: Usuario | undefined, req: Request, cliente?: ClienteInfo, unidadeId?: string) {
    this.exigir(user);
    const m = await this.manifesto();
    const { token, valido_ate } = this.midia.gerarTokenMidia(user ?? {});
    const base = this.base(req);
    const qImagem = `token=${encodeURIComponent(token)}`;
    let q = qImagem;
    // Com a usina: o Raspberry instalado por este comando entra sozinho nela (chave de uso único, 48 h).
    // A chave vai só no comando do Terminal (não no link da imagem).
    let vinculo: { valido_ate: string } | null = null;
    let ctx: Awaited<ReturnType<CamerasAuditoriaService['contextoUnidade']>> = { unidade: null, planta: null };
    if (unidadeId?.trim()) {
      const un = unidadeId.trim();
      if (user) await this.scope.assertEntityInScope('unidade', un, user);
      ctx = await this.auditoria.contextoUnidade(un);
      if (!ctx.unidade) throw new NotFoundException('Usina não encontrada');
      const v = this.midia.gerarVinculo(un, user?.id?.trim() ?? null);
      q += `&vinculo=${encodeURIComponent(v.chave)}`;
      vinculo = { valido_ate: v.valido_ate };
    }
    await this.auditoria.registrar('camera_instalador', {
      mensagem: `Instalador do NexON (versão ${m.versao}) pedido para um Raspberry novo${ctx.unidade ? ` — entra sozinho em ${ctx.unidade.nome}` : ''}`,
      user,
      cliente,
      unidade: ctx.unidade,
      planta: ctx.planta,
      objetoTipo: 'camera_instalador',
      objetoId: m.versao,
      extra: { versao: m.versao, arquivo: m.arquivo, valido_ate, vinculo_automatico: !!vinculo },
    });
    return {
      versao: m.versao,
      tamanho: m.tamanho,
      publicado_em: m.publicado_em ?? null,
      valido_ate,
      url_imagem: `${base}/imagem?${qImagem}`,
      comando: `curl -fsSL '${base}/script?${q}' | bash`,
      // Windows: PowerShell; o script pede administrador sozinho (abre outra janela).
      comando_windows: `powershell -ExecutionPolicy Bypass -Command "irm '${base}/script?${q}&so=windows' | iex"`,
      vinculo_automatico: vinculo,
      usina: ctx.unidade?.nome ?? null,
    };
  }

  /** GET /cameras/instalador/imagem?token= — a imagem (.img.gz), com Range. */
  async imagem(user: Usuario | undefined, req: Request, res: Response) {
    this.exigir(user);
    const m = await this.manifesto();
    await this.storage.servir(req, res, `${PASTA}/${m.arquivo}`, 'application/gzip', 'private, no-store', m.arquivo);
  }

  /** GET /cameras/instalador/script?token=[&so=windows] — instalar-pelo-pc.sh (ou .ps1) com o endereço da imagem e o sha256. */
  async script(user: Usuario | undefined, req: Request, res: Response) {
    this.exigir(user);
    const m = await this.manifesto();
    const windows = req.query.so === 'windows';
    let texto: string;
    try {
      texto = await readFile(this.storage.absoluto(`${PASTA}/${windows ? 'instalar-pelo-pc.ps1' : 'instalar-pelo-pc.sh'}`), 'utf8');
    } catch {
      throw new NotFoundException('Script do instalador não publicado');
    }
    const token = String(req.query.token ?? '');
    // O token vai dentro do script: só o formato que a API gera (base64url.base64url).
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new BadRequestException('Token inválido');
    const url = `${this.base(req)}/imagem?token=${encodeURIComponent(token)}`;
    const vinculo = String(req.query.vinculo ?? '');
    const vinculoOk = /^vin\.[\w.-]+$/.test(vinculo) ? vinculo : '';
    // O .ps1 se baixa de novo como administrador: leva o próprio endereço (mesmo token e chave).
    let self = `${this.base(req)}/script?token=${encodeURIComponent(token)}`;
    if (vinculoOk) self += `&vinculo=${encodeURIComponent(vinculoOk)}`;
    self += '&so=windows';
    texto = texto
      .replace('__NEXON_IMAGEM_URL__', url)
      .replace('__NEXON_IMAGEM_SHA__', m.sha256)
      .replace('__NEXON_VINCULO__', vinculoOk)
      .replace('__NEXON_SCRIPT_URL__', self);
    // Defesa extra: no .ps1 os valores ficam entre aspas simples.
    if (windows && /'/.test(url + self + vinculoOk)) throw new BadRequestException('Endereço inválido');
    if (windows) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(texto);
      return;
    }
    res.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(texto);
  }
}
