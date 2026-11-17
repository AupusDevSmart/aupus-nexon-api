import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import type { Request, Response } from 'express';
import { PermissionScopeService, PrismaService } from '@/core';
import { capacidades, papelCanonico } from '@/core/modules/auth/papeis';
import { novoId26, type ClienteInfo } from '@/core/common/cliente-info';
import { CamerasAuditoriaService } from './cameras-auditoria.service';
import { CamerasDespertarService } from './cameras-despertar.service';
import { CamerasStorageService } from './cameras-storage.service';
import type { AgenteInfo, Usuario } from './cameras.tipos';

/** Comandos do aparelho pela web (não são de uma câmera). */
export const TIPOS_COMANDO_APARELHO = ['atualizar', 'reiniciar', 'logs'] as const;
export type TipoComandoAparelho = (typeof TIPOS_COMANDO_APARELHO)[number];

/** Pacote publicado do agente: storage/cameras/agente/atual.json + <versao>.tar.gz. */
const MANIFESTO = 'agente/atual.json';

export interface ManifestoAgente {
  versao: string;
  sha256: string;
  tamanho: number;
  publicado_em?: string;
  notas?: string;
}

/** Tira credenciais de URLs (rtsp://user:senha@, ?token=) antes de mostrar os registros do aparelho. */
export function semSegredos<T>(v: T): T {
  if (typeof v === 'string') {
    return v
      .replace(/([a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)[^@\s]+@/gi, '$1***@')
      .replace(/([?&](?:token|senha|password|pwd)=)[^&\s"']+/gi, '$1***') as T;
  }
  if (Array.isArray(v)) return v.map((x) => semSegredos(x)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, semSegredos(x)])) as T;
  return v;
}

const ROTULO: Record<TipoComandoAparelho, string> = {
  atualizar: 'Atualização',
  reiniciar: 'Reinício',
  logs: 'Leitura dos registros',
};

/**
 * Aparelho pela web (NEXON-108): atualizar o programa, reiniciar e ver os registros, sem estar na rede local.
 * O pedido vira um comando sem câmera em cameras_comandos; o aparelho é acordado na hora (long-poll) e responde
 * com o resultado (logs voltam em `resultado.linhas`). Audit camera_agente_comando em todo pedido.
 */
@Injectable()
export class CamerasAparelhoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: PermissionScopeService,
    private readonly storage: CamerasStorageService,
    private readonly auditoria: CamerasAuditoriaService,
    private readonly despertar: CamerasDespertarService,
  ) {}

  async manifesto(): Promise<ManifestoAgente | null> {
    try {
      const m = JSON.parse(await readFile(this.storage.absoluto(MANIFESTO), 'utf8')) as ManifestoAgente;
      return m?.versao && /^[0-9a-f]{64}$/.test(m.sha256) ? m : null;
    } catch {
      return null;
    }
  }

  /** GET /cameras/atualizacao — versão disponível para os aparelhos (tela compara com a de cada um). */
  async disponivel() {
    const m = await this.manifesto();
    return m ? { versao: m.versao, publicado_em: m.publicado_em ?? null, notas: m.notas ?? null } : { versao: null };
  }

  /** POST /cameras/agentes/:id/comandos { tipo } */
  async pedir(agenteId: string, tipo: string, user?: Usuario, cliente?: ClienteInfo) {
    if (!(TIPOS_COMANDO_APARELHO as readonly string[]).includes(tipo)) throw new BadRequestException('Comando inválido');
    const t = tipo as TipoComandoAparelho;
    const papel = papelCanonico(user?.role);
    if (t === 'logs' ? !capacidades(papel).cadastroTecnico : papel !== 'admin') {
      throw new ForbiddenException(t === 'logs' ? 'Sem permissão para ver os registros do aparelho' : 'Só o administrador atualiza ou reinicia o aparelho');
    }
    const a = await this.agente(agenteId, user);
    let parametros: Record<string, unknown> = {};
    if (t === 'atualizar') {
      const m = await this.manifesto();
      if (!m) throw new BadRequestException('Nenhuma versão publicada para atualizar');
      parametros = { versao: m.versao };
    }
    const cmd = await this.prisma.cameras_comandos.create({
      data: { id: novoId26(), camera_id: null, agente_id: a.id, tipo: t, parametros: parametros as object, solicitado_por_id: user?.id?.trim() ?? null },
    });
    this.despertar.despertar(a.id);
    const ctx = await this.auditoria.contextoUnidade(a.unidade_id);
    await this.auditoria.registrar('camera_agente_comando', {
      mensagem: `${ROTULO[t]} pedida ao aparelho "${a.nome}"${t === 'atualizar' ? ` (versão ${a.versao ?? '?'} → ${String(parametros.versao)})` : ''} — ${ctx.unidade?.nome ?? a.unidade_id}${ctx.planta ? ` (${ctx.planta.nome})` : ''}`,
      user,
      cliente,
      unidade: ctx.unidade,
      planta: ctx.planta,
      objetoTipo: 'camera_agente',
      objetoId: a.id,
      extra: { comando: { id: cmd.id, tipo: t, ...parametros }, agente: { id: a.id, nome: a.nome, versao: a.versao, host: a.host } },
    });
    return { id: cmd.id, tipo: t, estado: cmd.estado };
  }

  /** GET /cameras/agentes/:id/comandos/:cmdId — estado e resultado (logs: resultado.linhas). */
  async estado(agenteId: string, comandoId: string, user?: Usuario) {
    const a = await this.agente(agenteId, user);
    const c = await this.prisma.cameras_comandos.findFirst({ where: { id: comandoId.trim(), agente_id: a.id, camera_id: null } });
    if (!c) throw new NotFoundException('Comando não encontrado');
    const pendente = c.estado === 'pendente' || c.estado === 'entregue';
    const expirado = pendente && Date.now() - c.created_at.getTime() > 3 * 60_000;
    return {
      id: c.id,
      tipo: c.tipo,
      estado: expirado ? 'expirado' : c.estado,
      erro: c.erro,
      resultado: semSegredos(c.resultado ?? null),
      criado_em: c.created_at,
      concluido_em: c.concluido_em,
    };
  }

  // ------------------------------------------------------------------ rotas do agente
  async infoAgente(_agente: AgenteInfo) {
    const m = await this.manifesto();
    if (!m) throw new NotFoundException('Nenhuma versão publicada');
    return { versao: m.versao, sha256: m.sha256, tamanho: m.tamanho };
  }

  async arquivoAgente(_agente: AgenteInfo, req: Request, res: Response) {
    const m = await this.manifesto();
    if (!m) throw new NotFoundException('Nenhuma versão publicada');
    await this.storage.servir(req, res, `agente/${m.versao}.tar.gz`, 'application/gzip', 'private, no-store');
  }

  private async agente(id: string, user?: Usuario) {
    const a = await this.prisma.cameras_agentes.findFirst({ where: { id: id.trim(), deleted_at: null } });
    if (!a) throw new NotFoundException('Aparelho não encontrado');
    if (user) await this.scope.assertEntityInScope('unidade', a.unidade_id, user);
    return a;
  }
}
