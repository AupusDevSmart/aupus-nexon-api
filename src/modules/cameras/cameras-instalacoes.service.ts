import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/core';
import { capacidades, papelCanonico } from '@/core/modules/auth/papeis';
import { novoId26, type ClienteInfo } from '@/core/common/cliente-info';
import { CamerasAuditoriaService } from './cameras-auditoria.service';
import { CamerasMidiaService } from './cameras-midia.service';
import type { Usuario } from './cameras.tipos';
import type { RelatoAparelhoDto, RelatoInstalacaoDto } from './dto/cameras.dto';

const ESTADOS = new Set(['andamento', 'erro', 'ok']);
const MAX_REGISTRO = 60_000;

/** Tira tokens e chaves que possam ter caído no registro (URLs com ?token=, chave de vínculo). */
export function limparRegistro(texto: string): string {
  return texto
    .replace(/(token=)[^&\s'"]+/gi, '$1***')
    .replace(/vin\.[\w.-]+/g, 'vin.***')
    .replace(/nxcam_[\w-]+/g, 'nxcam_***');
}

/**
 * NEXON-108: relato das instalações feitas pelo computador. O instalar-pelo-pc (.sh/.ps1) manda, com o token
 * de mídia de quem copiou o comando, o passo, o estado e o fim do registro; o administrador lista e lê para
 * investigar sem depender de foto. Erro e fim com sucesso entram na auditoria (camera_instalacao).
 */
@Injectable()
export class CamerasInstalacoesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly midia: CamerasMidiaService,
    private readonly auditoria: CamerasAuditoriaService,
  ) {}

  async relatar(user: Usuario | undefined, dto: RelatoInstalacaoDto, cliente?: ClienteInfo) {
    // Só quem pode instalar aparelhos (o mesmo do comando do instalador) relata.
    if (!user?.id || !capacidades(papelCanonico(user.role)).cadastroTecnico) throw new ForbiddenException('Sem permissão');
    const sessao = (dto.sessao ?? '').trim();
    if (!/^[A-Za-z0-9-]{8,40}$/.test(sessao)) throw new BadRequestException('Sessão inválida');
    const estado = ESTADOS.has(dto.estado ?? '') ? (dto.estado as string) : 'andamento';
    // A usina só vale se a chave de vínculo foi gerada por quem relata.
    const lida = this.midia.lerVinculo(dto.vinculo);
    const vinc = lida && lida.by?.trim() === user.id.trim() ? lida : null;
    // Pelo token de mídia o nome não vem: busca uma vez no cadastro.
    const nomeUsuario =
      user.nome ?? (await this.prisma.usuarios.findFirst({ where: { id: user.id.trim() }, select: { nome: true } }))?.nome ?? null;
    const dados = {
      usuario_id: user.id.trim(),
      usuario_nome: nomeUsuario,
      unidade_id: vinc?.un?.trim() ?? null,
      sistema: dto.sistema?.slice(0, 160) ?? null,
      passo: dto.passo?.slice(0, 120) ?? null,
      estado,
      mensagem: dto.mensagem ? limparRegistro(dto.mensagem).slice(0, 2000) : null,
      ...(dto.registro ? { registro: limparRegistro(dto.registro).slice(-MAX_REGISTRO) } : {}),
      ip: cliente?.ip?.slice(0, 60) ?? null,
      versao: dto.versao?.slice(0, 40) ?? null,
    };
    const antes = await this.prisma.cameras_instalacoes.findUnique({ where: { sessao }, select: { estado: true, usuario_id: true } });
    if (antes && antes.usuario_id && antes.usuario_id.trim() !== user.id.trim()) throw new ForbiddenException('Sessão de outra pessoa');
    const linha = antes
      ? await this.prisma.cameras_instalacoes.update({ where: { sessao }, data: dados })
      : await this.prisma.cameras_instalacoes.create({ data: { id: novoId26(), sessao, ...dados } });
    if (estado !== 'andamento' && antes?.estado !== estado) {
      const ctx = await this.auditoria.contextoUnidade(linha.unidade_id);
      await this.auditoria.registrar('camera_instalacao', {
        mensagem:
          estado === 'ok'
            ? `Raspberry gravado pelo computador${ctx.unidade ? ` para ${ctx.unidade.nome}` : ''} (${linha.sistema ?? 'sistema ?'})`
            : `Instalação do Raspberry pelo computador falhou no passo "${linha.passo ?? '?'}": ${linha.mensagem ?? ''}`.slice(0, 480),
        user,
        cliente,
        unidade: ctx.unidade,
        planta: ctx.planta,
        objetoTipo: 'camera_instalacao',
        objetoId: linha.id,
        extra: { sessao, estado, passo: linha.passo, sistema: linha.sistema, versao: linha.versao },
      });
    }
    return { ok: true };
  }

  /**
   * POST /cameras/instalador/relato-aparelho — o próprio Raspberry, no primeiro boot, conta onde está (ligou,
   * internet, instalando, pronto, erro). Sem login: vale a chave de vínculo gravada no cartão/pendrive (assinada,
   * 48 h, de quem gerou o comando). Uma linha por aparelho (sessão pi-<nonce>).
   */
  async relatarAparelho(dto: RelatoAparelhoDto, cliente?: ClienteInfo) {
    const vinc = this.midia.lerVinculo(dto.vinculo);
    if (!vinc) throw new ForbiddenException('Chave inválida ou vencida');
    const sessao = `pi-${vinc.n}`;
    const estado = ESTADOS.has(dto.estado ?? '') ? (dto.estado as string) : 'andamento';
    const autor = vinc.by
      ? await this.prisma.usuarios.findFirst({ where: { id: vinc.by.trim() }, select: { id: true, nome: true } })
      : null;
    const dados = {
      usuario_id: autor?.id?.trim() ?? null,
      usuario_nome: autor?.nome ?? null,
      unidade_id: vinc.un.trim(),
      sistema: `Raspberry${dto.host ? ` ${dto.host.slice(0, 60)}` : ''}${dto.ip_local ? ` (${dto.ip_local.slice(0, 40)})` : ''}`.slice(0, 160),
      passo: dto.passo?.slice(0, 120) ?? null,
      estado,
      mensagem: dto.mensagem ? limparRegistro(dto.mensagem).slice(0, 2000) : null,
      ...(dto.registro ? { registro: limparRegistro(dto.registro).slice(-MAX_REGISTRO) } : {}),
      ip: cliente?.ip?.slice(0, 60) ?? null,
      versao: dto.versao?.slice(0, 40) ?? null,
    };
    const antes = await this.prisma.cameras_instalacoes.findUnique({ where: { sessao }, select: { estado: true } });
    const linha = antes
      ? await this.prisma.cameras_instalacoes.update({ where: { sessao }, data: dados })
      : await this.prisma.cameras_instalacoes.create({ data: { id: novoId26(), sessao, ...dados } });
    if (estado !== 'andamento' && antes?.estado !== estado) {
      const ctx = await this.auditoria.contextoUnidade(linha.unidade_id);
      await this.auditoria.registrar('camera_instalacao', {
        mensagem:
          estado === 'ok'
            ? `Raspberry terminou o primeiro boot${ctx.unidade ? ` em ${ctx.unidade.nome}` : ''}`
            : `Primeiro boot do Raspberry falhou no passo "${linha.passo ?? '?'}": ${linha.mensagem ?? ''}`.slice(0, 480),
        user: autor ? ({ id: autor.id, nome: autor.nome } as Usuario) : null,
        cliente,
        unidade: ctx.unidade,
        planta: ctx.planta,
        objetoTipo: 'camera_instalacao',
        objetoId: linha.id,
        extra: { sessao, estado, passo: linha.passo, sistema: linha.sistema, origem: 'raspberry' },
      });
    }
    return { ok: true };
  }

  private exigirAdmin(user?: Usuario) {
    if (user && papelCanonico(user.role) !== 'admin') throw new ForbiddenException('Só o administrador vê as instalações');
  }

  /** GET /cameras/instalacoes — últimas 100 (sem o registro), com o nome da usina. */
  async listar(user?: Usuario) {
    this.exigirAdmin(user);
    const linhas = await this.prisma.cameras_instalacoes.findMany({
      orderBy: { created_at: 'desc' },
      take: 100,
      select: {
        id: true, sessao: true, usuario_nome: true, unidade_id: true, sistema: true, passo: true, estado: true,
        mensagem: true, versao: true, created_at: true, updated_at: true,
      },
    });
    const ids = [...new Set(linhas.map((l) => l.unidade_id?.trim()).filter((x): x is string => !!x))];
    const unidades = ids.length ? await this.prisma.unidades.findMany({ where: { id: { in: ids } }, select: { id: true, nome: true } }) : [];
    const nome = new Map(unidades.map((u) => [u.id.trim(), u.nome]));
    return linhas.map((l) => ({ ...l, unidade_nome: l.unidade_id ? (nome.get(l.unidade_id.trim()) ?? null) : null }));
  }

  /** GET /cameras/instalacoes/:id — o registro completo do Terminal. */
  async registro(id: string, user?: Usuario) {
    this.exigirAdmin(user);
    const l = await this.prisma.cameras_instalacoes.findUnique({ where: { id: id.trim() }, select: { id: true, registro: true } });
    if (!l) throw new NotFoundException('Instalação não encontrada');
    return l;
  }
}
