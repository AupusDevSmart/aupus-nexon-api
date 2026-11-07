import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * Arquivos das câmeras (miniaturas, snapshots e clipes) em CAMERAS_STORAGE_DIR (padrão
 * ./storage/cameras) — fora de ./uploads, que é servido sem autenticação. Caminhos gravados no
 * banco são relativos a essa pasta: miniaturas/<camera_id>.jpg, eventos/<evento_id>.jpg|.mp4.
 * Servidos só por rotas autenticadas; MP4 honra Range (seek no <video>).
 */
@Injectable()
export class CamerasStorageService {
  private readonly logger = new Logger(CamerasStorageService.name);

  dir(): string {
    return resolve(process.env.CAMERAS_STORAGE_DIR || './storage/cameras');
  }

  caminhoMiniatura(cameraId: string): string {
    return `miniaturas/${this.idSeguro(cameraId)}.jpg`;
  }

  caminhoEvento(eventoId: string, ext: 'jpg' | 'mp4'): string {
    return `eventos/${this.idSeguro(eventoId)}.${ext}`;
  }

  /** Caminho absoluto, garantido dentro da pasta de storage. */
  absoluto(rel: string): string {
    const abs = resolve(this.dir(), rel);
    const r = relative(this.dir(), abs);
    if (!r || r.startsWith('..') || resolve(this.dir(), r) !== abs) throw new Error(`caminho fora do storage: ${rel}`);
    return abs;
  }

  private idSeguro(id: string): string {
    const v = (id ?? '').trim();
    if (!/^[a-z0-9]{1,26}$/.test(v)) throw new Error(`id inválido para arquivo: ${id}`);
    return v;
  }

  /** Grava em arquivo temporário e renomeia: quem lê nunca vê arquivo pela metade. */
  async salvar(rel: string, conteudo: Buffer): Promise<void> {
    const abs = this.absoluto(rel);
    await mkdir(dirname(abs), { recursive: true });
    const tmp = join(dirname(abs), `.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await writeFile(tmp, conteudo);
      await rename(tmp, abs);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
  }

  async existe(rel: string | null | undefined): Promise<boolean> {
    if (!rel) return false;
    try {
      const s = await stat(this.absoluto(rel));
      return s.isFile();
    } catch {
      return false;
    }
  }

  async remover(rel: string | null | undefined): Promise<void> {
    if (!rel) return;
    try {
      await unlink(this.absoluto(rel));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.logger.warn(`[cameras] não removeu ${rel}: ${(e as Error).message}`);
    }
  }

  /**
   * Envia o arquivo (200) ou um trecho (206, `Range: bytes=a-b`). Lança 404 se não existe.
   * Responde direto no `res` (fora do ResponseInterceptor).
   */
  async servir(req: Request, res: Response, rel: string | null | undefined, contentType: string, cacheControl = 'private, max-age=60'): Promise<void> {
    if (!rel) throw new NotFoundException('Arquivo não disponível');
    let abs: string;
    let tamanho: number;
    let modificado: Date;
    try {
      abs = this.absoluto(rel);
      const s = await stat(abs);
      if (!s.isFile()) throw new Error('não é arquivo');
      tamanho = s.size;
      modificado = s.mtime;
    } catch {
      throw new NotFoundException('Arquivo não disponível');
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', cacheControl);
    res.setHeader('Last-Modified', modificado.toUTCString());
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const range = typeof req.headers.range === 'string' ? req.headers.range : null;
    let inicio = 0;
    let fim = tamanho - 1;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!m || (m[1] === '' && m[2] === '')) {
        res.status(416).setHeader('Content-Range', `bytes */${tamanho}`);
        res.end();
        return;
      }
      if (m[1] === '') {
        // Sufixo: últimos N bytes.
        inicio = Math.max(0, tamanho - Number(m[2]));
      } else {
        inicio = Number(m[1]);
        if (m[2] !== '') fim = Math.min(Number(m[2]), tamanho - 1);
      }
      if (inicio > fim || inicio >= tamanho) {
        res.status(416).setHeader('Content-Range', `bytes */${tamanho}`);
        res.end();
        return;
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${inicio}-${fim}/${tamanho}`);
    } else {
      res.status(200);
    }
    res.setHeader('Content-Length', String(fim - inicio + 1));

    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    await new Promise<void>((resolver) => {
      const stream = createReadStream(abs, { start: inicio, end: fim });
      stream.on('error', (e) => {
        this.logger.warn(`[cameras] erro lendo ${rel}: ${e.message}`);
        if (!res.headersSent) res.status(500);
        res.end();
        resolver();
      });
      stream.on('close', () => resolver());
      stream.pipe(res);
    });
  }
}
