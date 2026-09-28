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
  ip: string | null;
  userAgent: string | null;
}

function header(headers: Record<string, any> | undefined, nome: string, max = 80): string | null {
  if (!headers) return null;
  const v = headers[nome] ?? headers[nome.toLowerCase()];
  const s = Array.isArray(v) ? v[0] : v;
  if (typeof s !== 'string') return null;
  const t = s.trim().slice(0, max);
  return t || null;
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
  const ip = (xff ? xff.split(',')[0].trim() : null) || req?.ip || req?.socket?.remoteAddress || null;

  let dispositivo: string;
  if (aparelho && plataforma) dispositivo = `${aparelho} · ${plataforma}`;
  else if (aparelho) dispositivo = aparelho;
  else if (plataforma) dispositivo = plataforma;
  else dispositivo = rotuloNavegador(userAgent);

  return {
    plataforma: plataforma ?? (aparelho ? null : 'Web'),
    aparelho,
    dispositivo: dispositivo.slice(0, 120),
    ip: ip ? String(ip).replace(/^::ffff:/, '').slice(0, 64) : null,
    userAgent: userAgent ? userAgent.slice(0, 255) : null,
  };
}

/** `@Cliente() cliente: ClienteInfo` — headers X-Client-* + IP da requisição. */
export const Cliente = createParamDecorator((_: unknown, ctx: ExecutionContext): ClienteInfo => {
  return extrairClienteInfo(ctx.switchToHttp().getRequest());
});

/** Id char(26) no mesmo formato que usuarios.service usa (nanoid a-z0-9). */
export const novoId26 = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 26);
