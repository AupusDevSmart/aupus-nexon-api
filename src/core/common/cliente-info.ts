import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { customAlphabet } from 'nanoid';

/**
 * De onde veio a requisição: plataforma + aparelho (headers que os apps NexON
 * mandam em TODA request) + IP. Gravado na trilha de comandos (logs_mqtt.dispositivo)
 * e nas sessões (auth_sessoes).
 *
 *   X-Client-Platform: iOS | Android        (web não manda)
 *   X-Client-Device:   "iPhone 15 Pro" | "Pixel 7"
 */
export interface ClienteInfo {
  plataforma: string | null;
  aparelho: string | null;
  /** Rótulo pronto para a trilha: "iPhone 15 Pro · iOS", "Chrome no Windows", "Web". */
  dispositivo: string;
  /**
   * IP do cliente para a trilha: `req.ip` do Express, que só considera
   * X-Forwarded-For vindo de proxy confiável (`trust proxy` = loopback, o nginx
   * da própria VPS — ver main.ts). Sem req.ip, cai no socket. NUNCA o XFF cru.
   */
  ip: string | null;
  /** Endereço do socket TCP (no servidor, o nginx = 127.0.0.1). */
  ipSocket: string | null;
  /** X-Forwarded-For bruto, saneado — só pista para investigação, falsificável. */
  xff: string | null;
  userAgent: string | null;
}

/** Tira caracteres de controle (quebra de linha, NUL, ESC) e corta no tamanho. */
export function sanear(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
  return t || null;
}

/** Aceita só texto com cara de IP (v4/v6); qualquer outra coisa vira null. */
function ipValido(v: unknown): string | null {
  const t = sanear(typeof v === 'string' ? v.replace(/^::ffff:/, '') : v, 64);
  return t && /^[0-9a-fA-F:.]+$/.test(t) ? t : null;
}

function header(headers: Record<string, any> | undefined, nome: string, max = 80): string | null {
  if (!headers) return null;
  const v = headers[nome] ?? headers[nome.toLowerCase()];
  const s = Array.isArray(v) ? v[0] : v;
  if (typeof s !== 'string') return null;
  return sanear(s, max);
}

/** "Chrome no Windows" a partir do User-Agent (web). Sem UA → "Web". */
export function rotuloNavegador(ua: string | null): string {
  if (!ua) return 'Web';
  const navegador = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null;
  const so = /Windows/.test(ua)
    ? 'Windows'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  if (navegador && so) return `${navegador} no ${so}`;
  return navegador ?? so ?? 'Web';
}

export function extrairClienteInfo(req: { headers?: Record<string, any>; ip?: string; socket?: any } | undefined): ClienteInfo {
  const headers = req?.headers ?? {};
  const plataforma = header(headers, 'x-client-platform');
  const aparelho = header(headers, 'x-client-device');
  const userAgent = header(headers, 'user-agent', 255);
  const xff = header(headers, 'x-forwarded-for', 255);
  const ipSocket = ipValido(req?.socket?.remoteAddress);
  const ip = ipValido(req?.ip) ?? ipSocket;

  let dispositivo: string;
  if (aparelho && plataforma) dispositivo = `${aparelho} · ${plataforma}`;
  else if (aparelho) dispositivo = aparelho;
  else if (plataforma) dispositivo = plataforma;
  else dispositivo = rotuloNavegador(userAgent);

  return {
    plataforma: plataforma ?? (aparelho ? null : 'Web'),
    aparelho,
    dispositivo: dispositivo.slice(0, 120),
    ip,
    ipSocket,
    xff,
    userAgent,
  };
}

/** `@Cliente() cliente: ClienteInfo` — headers X-Client-* + IP da requisição. */
export const Cliente = createParamDecorator((_: unknown, ctx: ExecutionContext): ClienteInfo => {
  return extrairClienteInfo(ctx.switchToHttp().getRequest());
});

/** Id char(26) no mesmo formato que usuarios.service usa (nanoid a-z0-9). */
export const novoId26 = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 26);
