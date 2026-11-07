import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { PermissionScopeService, PrismaService } from '@/core';
import {
  cameraDoCaminho,
  ehLoopback,
  PREFIXO_TOKEN_AGENTE,
  PREFIXO_TOKEN_PUBLICAR,
  TOKEN_MIDIA_S,
  TOKEN_PUBLICAR_S,
  tokenDaQuery,
} from './cameras-regras';
import type { AgenteInfo } from './cameras.tipos';

interface PayloadMidia {
  u: string;
  r: string | null;
  e: number;
}

interface PayloadPublicar {
  a: string;
  e: number;
}

/**
 * Segredos do módulo: token de mídia (HMAC, 2 h) para <img>/<video>/HLS sem header, token de
 * publicação do agente no MediaMTX (HMAC, 30 min), token do agente (aleatório, só o hash no
 * banco), cifra da senha das câmeras (AES-256-GCM) e a autenticação externa do MediaMTX.
 * Chave: MIDIA_TOKEN_SECRET, senão JWT_SECRET.
 */
@Injectable()
export class CamerasMidiaService {
  private readonly logger = new Logger(CamerasMidiaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: PermissionScopeService,
  ) {}

  private segredo(): string {
    const s = process.env.MIDIA_TOKEN_SECRET || process.env.JWT_SECRET;
    if (!s) throw new Error('MIDIA_TOKEN_SECRET (ou JWT_SECRET) não configurado');
    return s;
  }

  // ---------------------------------------------------------------------------
  // Tokens HMAC (payload base64url + assinatura), como o link público do boletim
  // ---------------------------------------------------------------------------

  private assinar(payload: object): string {
    const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = createHmac('sha256', this.segredo()).update(p).digest('base64url');
    return `${p}.${sig}`;
  }

  private abrir<T extends { e?: number }>(token: string, agora = new Date()): T | null {
    if (typeof token !== 'string' || !token.includes('.')) return null;
    const [p, sig] = token.split('.');
    if (!p || !sig) return null;
    const esperado = createHmac('sha256', this.segredo()).update(p).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(esperado);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const o = JSON.parse(Buffer.from(p, 'base64url').toString()) as T;
      if (typeof o?.e !== 'number' || agora.getTime() > o.e) return null;
      return o;
    } catch {
      return null;
    }
  }

  /** Token de mídia do usuário logado: vale para o que ele pode ver, por 2 h. */
  gerarTokenMidia(user: { id?: string; role?: string | null }, agora = new Date()): { token: string; valido_ate: string } {
    const e = agora.getTime() + TOKEN_MIDIA_S * 1000;
    const payload: PayloadMidia = { u: (user.id ?? '').trim(), r: user.role ?? null, e };
    return { token: this.assinar(payload), valido_ate: new Date(e).toISOString() };
  }

  verificarTokenMidia(token: string, agora = new Date()): { u: string; r: string | null } | null {
    const o = this.abrir<PayloadMidia>(token, agora);
    if (!o || typeof o.u !== 'string' || !o.u) return null;
    return { u: o.u, r: typeof o.r === 'string' ? o.r : null };
  }

  /**
   * Token de mídia → usuário vivo no banco. O papel gravado no token é só pista: o que vale é o
   * papel ATUAL (Spatie `model_has_roles`, senão a coluna legada), e usuário inativo, apagado ou
   * inexistente não entra — igual ao JwtStrategy. Devolve null quando o token não serve mais.
   */
  async usuarioDoTokenMidia(token: string, agora = new Date()): Promise<{ id: string; role: string | null } | null> {
    const p = this.verificarTokenMidia(token, agora);
    if (!p) return null;
    const u = await this.prisma.usuarios.findFirst({
      where: { id: p.u, deleted_at: null, status: 'Ativo' },
      select: { id: true, role: true },
    });
    if (!u) return null;
    const mhr = await this.prisma.model_has_roles.findFirst({
      where: { model_id: p.u, model_type: 'App\\Models\\User' },
      include: { roles: true },
    });
    return { id: u.id.trim(), role: mhr?.roles?.name ?? u.role ?? null };
  }

  /** Token curto para o agente publicar no MediaMTX sem expor o token de longa duração. */
  gerarTokenPublicar(agenteId: string, agora = new Date()): string {
    const payload: PayloadPublicar = { a: agenteId.trim(), e: agora.getTime() + TOKEN_PUBLICAR_S * 1000 };
    return `${PREFIXO_TOKEN_PUBLICAR}${this.assinar(payload)}`;
  }

  verificarTokenPublicar(token: string, agora = new Date()): { a: string } | null {
    if (typeof token !== 'string' || !token.startsWith(PREFIXO_TOKEN_PUBLICAR)) return null;
    const o = this.abrir<PayloadPublicar>(token.slice(PREFIXO_TOKEN_PUBLICAR.length), agora);
    return o && typeof o.a === 'string' && o.a ? { a: o.a } : null;
  }

  // ---------------------------------------------------------------------------
  // Token do agente (aleatório; só o sha256 fica no banco)
  // ---------------------------------------------------------------------------

  gerarTokenAgente(): { token: string; hash: string } {
    const token = `${PREFIXO_TOKEN_AGENTE}${randomBytes(32).toString('base64url')}`;
    return { token, hash: this.hashToken(token) };
  }

  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Agente ativo dono do token, ou null. Comparação do hash em tempo constante. */
  async agentePorToken(token: string | null | undefined): Promise<AgenteInfo | null> {
    if (typeof token !== 'string' || !token.startsWith(PREFIXO_TOKEN_AGENTE) || token.length < 20) return null;
    const hash = this.hashToken(token);
    const a = await this.prisma.cameras_agentes.findFirst({
      where: { token_hash: hash, ativo: true, deleted_at: null },
      select: { id: true, unidade_id: true, planta_id: true, nome: true, token_hash: true },
    });
    if (!a) return null;
    const x = Buffer.from(a.token_hash);
    const y = Buffer.from(hash);
    if (x.length !== y.length || !timingSafeEqual(x, y)) return null;
    return { id: a.id.trim(), unidade_id: a.unidade_id.trim(), planta_id: a.planta_id.trim(), nome: a.nome };
  }

  // ---------------------------------------------------------------------------
  // Senha da câmera (AES-256-GCM): "v1.<iv>.<tag>.<cifrado>" em base64url
  // ---------------------------------------------------------------------------

  private chave(): Buffer {
    return createHash('sha256').update(this.segredo()).digest();
  }

  cifrar(texto: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.chave(), iv);
    const ct = Buffer.concat([c.update(texto ?? '', 'utf8'), c.final()]);
    return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
  }

  /** Senha em claro; '' se o valor não decifra (chave trocada ou formato estranho). */
  decifrar(cifrado: string | null | undefined): string {
    if (!cifrado) return '';
    const [ver, iv, tag, ct] = cifrado.split('.');
    if (ver !== 'v1' || !iv || !tag || ct === undefined) return '';
    try {
      const d = createDecipheriv('aes-256-gcm', this.chave(), Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
    } catch (e) {
      this.logger.warn(`[cameras] senha não decifrada: ${(e as Error).message}`);
      return '';
    }
  }

  // ---------------------------------------------------------------------------
  // URLs do servidor de mídia
  // ---------------------------------------------------------------------------

  publicUrl(): string {
    return (process.env.MIDIA_PUBLIC_URL || 'http://localhost:8888').replace(/\/$/, '');
  }

  publicarBase(): string {
    return (process.env.MIDIA_PUBLICAR_BASE || 'rtsp://localhost:8554').replace(/\/$/, '');
  }

  hlsUrl(caminho: string, token: string): string {
    return `${this.publicUrl()}/hls/${caminho}/index.m3u8?token=${encodeURIComponent(token)}`;
  }

  // ---------------------------------------------------------------------------
  // Autenticação externa do MediaMTX (POST /cameras/midia/auth)
  // ---------------------------------------------------------------------------

  /**
   * publish → user 'agente' + password = token do agente OU publicar_token do agente dono da câmera
   * do path `cam-<id>`. read/playback → `token=` na query com usuário que vê a unidade da câmera.
   * Qualquer outra coisa → false. Só aceita chamada do próprio servidor (loopback), salvo
   * MIDIA_AUTH_LOCAL_ONLY=false.
   */
  async autenticarMediaMtx(b: Record<string, unknown>, ipOrigem: string | null | undefined): Promise<boolean> {
    const localOnly = (process.env.MIDIA_AUTH_LOCAL_ONLY ?? 'true').trim().toLowerCase() !== 'false';
    if (localOnly && !ehLoopback(ipOrigem)) {
      this.logger.warn(`[midia] auth recusada: origem ${ipOrigem ?? '?'} não é loopback`);
      return false;
    }
    const action = typeof b.action === 'string' ? b.action : '';
    const path = typeof b.path === 'string' ? b.path : '';
    const cameraId = cameraDoCaminho(path);
    const recusar = (motivo: string) => {
      this.logger.warn(`[midia] auth recusada (${action || '?'} ${path || '?'} de ${typeof b.ip === 'string' ? b.ip : '?'}): ${motivo}`);
      return false;
    };
    if (!cameraId) return recusar('path não é cam-<id>');

    if (action === 'publish') {
      if (b.user !== 'agente' || typeof b.password !== 'string' || !b.password) return recusar('credencial de publicação ausente');
      const camera = await this.prisma.cameras.findFirst({
        where: { id: cameraId, deleted_at: null },
        select: { agente_id: true },
      });
      if (!camera?.agente_id) return recusar('câmera sem agente');
      const dono = camera.agente_id.trim();
      const agente = await this.agentePorToken(b.password);
      if (agente?.id === dono) return true;
      const pub = this.verificarTokenPublicar(b.password);
      if (pub?.a === dono) return true;
      return recusar('token não é do agente da câmera');
    }

    if (action === 'read' || action === 'playback') {
      const token = tokenDaQuery(typeof b.query === 'string' ? b.query : null);
      if (!token) return recusar('sem token de mídia');
      const usuario = await this.usuarioDoTokenMidia(token);
      if (!usuario) return recusar('token de mídia inválido, expirado ou de usuário inativo');
      const camera = await this.prisma.cameras.findFirst({
        where: { id: cameraId, deleted_at: null },
        select: { unidade_id: true },
      });
      if (!camera) return recusar('câmera não existe');
      try {
        await this.scope.assertEntityInScope('unidade', camera.unidade_id.trim(), usuario);
        return true;
      } catch {
        return recusar(`usuário ${usuario.id} não vê a unidade da câmera`);
      }
    }

    return recusar('ação não permitida');
  }
}
