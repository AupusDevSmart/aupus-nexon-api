import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/core';

export interface WhatsappGrupo {
  jid: string;
  nome: string;
  participantes: number;
}

/**
 * Cliente da API interna de WhatsApp da Aupus (wpp.aupusenergia.com.br). Portado do
 * bdo-aupus-api. As credenciais (api_key/base_url) são lidas de `bdo.configuracoes`
 * (mesmo banco) — evita reconfigurar o segredo durante a migração do envio pro NexON.
 *
 * Endpoints: POST /external/send-suporte (número), /external/send-suporte-grupo (grupo),
 * GET /external/grupos. Header: x-api-key. Rate limit ~60/min.
 */
@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(private readonly prisma: PrismaService) {}

  private async cfg(chave: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<Array<{ valor: string | null }>>`
      SELECT valor FROM bdo.configuracoes WHERE chave = ${chave} LIMIT 1
    `;
    return rows[0]?.valor ?? null;
  }

  private async credenciais(): Promise<{ base: string; apiKey: string }> {
    const base = (await this.cfg('whatsapp_base_url')) || 'https://wpp.aupusenergia.com.br';
    const apiKey = await this.cfg('whatsapp_api_key');
    if (!apiKey) throw new Error('whatsapp_api_key não configurada (bdo.configuracoes)');
    return { base, apiKey };
  }

  async listarGrupos(): Promise<WhatsappGrupo[]> {
    const { base, apiKey } = await this.credenciais();
    const res = await fetch(`${base}/api/v1/external/grupos`, { headers: { 'x-api-key': apiKey } });
    if (!res.ok) throw new Error(`Listar grupos: HTTP ${res.status}`);
    const body: any = await res.json();
    return body.grupos ?? [];
  }

  async enviarParaNumero(phone: string, texto: string, contatoNome?: string): Promise<void> {
    const { base, apiKey } = await this.credenciais();
    const cleanPhone = this.normalizarPhone(phone);
    if (!cleanPhone) throw new Error(`Número inválido: ${phone}`);
    const res = await fetch(`${base}/api/v1/external/send-suporte`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ phone: cleanPhone, texto, ...(contatoNome && { contatoNome }) }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`send-suporte HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
  }

  async enviarParaGrupo(groupJid: string, texto: string, comFooter = false): Promise<void> {
    const { base, apiKey } = await this.credenciais();
    const res = await fetch(`${base}/api/v1/external/send-suporte-grupo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ groupJid, texto, comFooter }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`send-suporte-grupo HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
  }

  /** Normaliza "(62) 99999-9999" etc. → dígitos; assume Brasil (55) se sem DDI. */
  normalizarPhone(input: string): string | null {
    if (!input) return null;
    const digitos = input.replace(/\D/g, '');
    if (!digitos || digitos.length < 10) return null;
    if (digitos.startsWith('55') && digitos.length >= 12) return digitos;
    if (digitos.length === 10 || digitos.length === 11) return `55${digitos}`;
    return digitos;
  }
}
