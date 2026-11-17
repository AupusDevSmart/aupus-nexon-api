import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import type { Request, Response } from 'express';
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

  private base(req: Request): string {
    const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol ?? 'https').split(',')[0];
    return `${proto}://${req.get('host')}/api/v1/cameras/instalador`;
  }

  /** GET /cameras/instalador — versão, links com token (2 h) e o comando para colar no Terminal. */
  async info(user: Usuario | undefined, req: Request, cliente?: ClienteInfo) {
    this.exigir(user);
    const m = await this.manifesto();
    const { token, valido_ate } = this.midia.gerarTokenMidia(user ?? {});
    const base = this.base(req);
    const q = `token=${encodeURIComponent(token)}`;
    await this.auditoria.registrar('camera_instalador', {
      mensagem: `Instalador do NexON (versão ${m.versao}) pedido para um Raspberry novo`,
      user,
      cliente,
      objetoTipo: 'camera_instalador',
      objetoId: m.versao,
      extra: { versao: m.versao, arquivo: m.arquivo, valido_ate },
    });
    return {
      versao: m.versao,
      tamanho: m.tamanho,
      publicado_em: m.publicado_em ?? null,
      valido_ate,
      url_imagem: `${base}/imagem?${q}`,
      comando: `curl -fsSL '${base}/script?${q}' | bash`,
    };
  }

  /** GET /cameras/instalador/imagem?token= — a imagem (.img.gz), com Range. */
  async imagem(user: Usuario | undefined, req: Request, res: Response) {
    this.exigir(user);
    const m = await this.manifesto();
    await this.storage.servir(req, res, `${PASTA}/${m.arquivo}`, 'application/gzip', 'private, no-store', m.arquivo);
  }

  /** GET /cameras/instalador/script?token= — instalar-pelo-pc.sh com o endereço da imagem e o sha256. */
  async script(user: Usuario | undefined, req: Request, res: Response) {
    this.exigir(user);
    const m = await this.manifesto();
    let texto: string;
    try {
      texto = await readFile(this.storage.absoluto(`${PASTA}/instalar-pelo-pc.sh`), 'utf8');
    } catch {
      throw new NotFoundException('Script do instalador não publicado');
    }
    const token = String(req.query.token ?? '');
    const url = `${this.base(req)}/imagem?token=${encodeURIComponent(token)}`;
    texto = texto.replace('__NEXON_IMAGEM_URL__', url).replace('__NEXON_IMAGEM_SHA__', m.sha256);
    res.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(texto);
  }
}
