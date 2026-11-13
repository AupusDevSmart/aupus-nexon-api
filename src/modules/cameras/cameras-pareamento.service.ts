import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { PermissionScopeService, PrismaService } from '@/core';
import { novoId26, type ClienteInfo } from '@/core/common/cliente-info';
import { CamerasAgenteService } from './cameras-agente.service';
import { CamerasAuditoriaService } from './cameras-auditoria.service';
import { CamerasMidiaService } from './cameras-midia.service';
import {
  chaveLimiteIp,
  deveEntregarToken,
  estadoPareamento,
  gerarCodigoUnico,
  LimitadorPorMinuto,
  mascararCodigo,
  mesmoIp,
  MSG_CODIGO_INVALIDO,
  MSG_MUITAS_TENTATIVAS_VINCULAR,
  normalizarCodigo,
  normalizarIp,
  PAREAMENTO_LIMITE_CRIAR_MIN,
  PAREAMENTO_LIMITE_ESTADO_MIN,
  PAREAMENTO_MAX_PENDENTES,
  PAREAMENTO_MAX_PENDENTES_POR_IP,
  PAREAMENTO_VALIDADE_S,
  VINCULAR_FALHAS_UNIDADE,
  VINCULAR_FALHAS_USUARIO,
  VINCULAR_JANELA_MS,
} from './cameras-regras';
import type { Usuario } from './cameras.tipos';
import type { EstadoPareamentoDto, PedirPareamentoDto, VincularPareamentoDto } from './dto/cameras-pareamento.dto';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/**
 * Pareamento do aparelho (NEXON-108): o agente sem token pede um código de 6 dígitos, a pessoa
 * logada digita o código, a API cria o agente e guarda o token cifrado até o aparelho buscar
 * uma única vez. Rotas do aparelho são públicas, com limite por IP em memória (sem @nestjs/throttler).
 */
@Injectable()
export class CamerasPareamentoService {
  private readonly logger = new Logger(CamerasPareamentoService.name);
  private readonly limiteCriar = new LimitadorPorMinuto(PAREAMENTO_LIMITE_CRIAR_MIN);
  private readonly limiteEstado = new LimitadorPorMinuto(PAREAMENTO_LIMITE_ESTADO_MIN);
  /** Falhas de vincular (código errado, pedido de outra rede): por usuário e por unidade, em 10 min. */
  private readonly falhasUsuario = new LimitadorPorMinuto(VINCULAR_FALHAS_USUARIO, VINCULAR_JANELA_MS);
  private readonly falhasUnidade = new LimitadorPorMinuto(VINCULAR_FALHAS_UNIDADE, VINCULAR_JANELA_MS);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: PermissionScopeService,
    private readonly midia: CamerasMidiaService,
    private readonly agentes: CamerasAgenteService,
    private readonly auditoria: CamerasAuditoriaService,
  ) {}

  private limitar(limitador: LimitadorPorMinuto, cliente?: ClienteInfo) {
    if (!limitador.permitir(chaveLimiteIp(cliente?.ip))) {
      throw new HttpException('Muitas tentativas; aguarde um minuto', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  // ---------------------------------------------------------------------------
  // Aparelho (público)
  // ---------------------------------------------------------------------------

  /** POST /cameras/pareamento → { pedido_id, segredo, codigo, expira_em }. */
  async pedir(dto: PedirPareamentoDto, cliente?: ClienteInfo, agora = new Date()) {
    this.limitar(this.limiteCriar, cliente);
    const ipPublico = normalizarIp(cliente?.ip);
    if (!ipPublico) throw new HttpException('IP de origem desconhecido', HttpStatus.BAD_REQUEST);

    // Faxina: pedido expirado há mais de 1 dia não serve nem para histórico.
    await this.prisma.cameras_pareamentos.deleteMany({
      where: { expira_em: { lt: new Date(agora.getTime() - 24 * 60 * 60 * 1000) }, agente_id: null },
    });
    // Teto por origem: uma rede só tem alguns aparelhos esperando ao mesmo tempo; quem abusa
    // esbarra aqui antes de chegar ao teto global.
    const daOrigem = await this.prisma.cameras_pareamentos.count({
      where: { ip_publico: ipPublico, agente_id: null, vinculado_em: null, expira_em: { gt: agora } },
    });
    if (daOrigem >= PAREAMENTO_MAX_PENDENTES_POR_IP) {
      throw new HttpException('Muitos aparelhos aguardando vínculo nesta rede; vincule ou aguarde expirar', HttpStatus.TOO_MANY_REQUESTS);
    }
    // Teto global: rota pública não pode encher a tabela (nem esgotar os códigos de 6 dígitos).
    const pendentes = await this.prisma.cameras_pareamentos.count({
      where: { agente_id: null, vinculado_em: null, expira_em: { gt: agora } },
    });
    if (pendentes >= PAREAMENTO_MAX_PENDENTES) {
      this.logger.warn(`[cameras] pareamento: ${pendentes} pedidos aguardando; novo pedido recusado (503)`);
      throw new ServiceUnavailableException('Pareamento indisponível no momento; tente de novo em alguns minutos');
    }
    const emUso = await this.prisma.cameras_pareamentos.findMany({
      where: { expira_em: { gt: agora } },
      select: { codigo: true },
    });
    const codigo = gerarCodigoUnico(
      emUso.map((p) => p.codigo),
      () => randomInt(0, 1_000_000),
    );
    const segredo = randomBytes(32).toString('base64url');
    const expiraEm = new Date(agora.getTime() + PAREAMENTO_VALIDADE_S * 1000);
    const p = await this.prisma.cameras_pareamentos.create({
      data: {
        id: novoId26(),
        codigo,
        segredo_hash: sha256(segredo),
        host: dto.host.trim().slice(0, 120),
        mac: dto.mac?.trim().toLowerCase() || null,
        versao: dto.versao?.trim() || null,
        ip_publico: ipPublico,
        ip_local: dto.ip_local?.trim() || null,
        criado_em: agora,
        expira_em: expiraEm,
      },
    });
    return { pedido_id: p.id, segredo, codigo, expira_em: p.expira_em };
  }

  /** POST /cameras/pareamento/:id/estado — token só na primeira consulta depois de vinculado. */
  async estado(id: string, dto: EstadoPareamentoDto, cliente?: ClienteInfo, agora = new Date()) {
    this.limitar(this.limiteEstado, cliente);
    const p = await this.prisma.cameras_pareamentos.findUnique({ where: { id: (id ?? '').trim() } });
    // Segredo errado = 404: não revela que o pedido existe.
    if (!p || !this.segredoConfere(dto.segredo, p.segredo_hash)) throw new NotFoundException('Pedido não encontrado');

    const estado = estadoPareamento(p, agora);
    const base = { estado, codigo: p.codigo, expira_em: p.expira_em };
    if (estado !== 'vinculado' || !p.agente_id) return base;

    const agente = await this.prisma.cameras_agentes.findFirst({
      where: { id: p.agente_id },
      select: { id: true, nome: true },
    });
    const resposta: Record<string, unknown> = { ...base, agente: agente ? { id: agente.id, nome: agente.nome } : null };
    if (deveEntregarToken(p, agora)) {
      // Entrega única: quem marcar entregue_em primeiro leva o token; a segunda consulta não.
      const marcado = await this.prisma.cameras_pareamentos.updateMany({
        where: { id: p.id, entregue_em: null },
        data: { entregue_em: agora, token_cifrado: null },
      });
      if (marcado.count === 1) {
        const token = this.midia.decifrar(p.token_cifrado);
        if (token) resposta.token = token;
        else this.logger.warn(`[cameras] pareamento ${p.id}: token cifrado ilegível (segredo de mídia trocado?)`);
      }
    }
    return resposta;
  }

  private segredoConfere(segredo: string, hash: string): boolean {
    const a = Buffer.from(sha256(segredo ?? ''), 'hex');
    const b = Buffer.from(hash ?? '', 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // ---------------------------------------------------------------------------
  // Pessoa logada (cadastroTecnico)
  // ---------------------------------------------------------------------------

  /** GET /cameras/pareamento/proximos — aparelhos aguardando na mesma rede (mesmo IP público). */
  async proximos(user?: Usuario, cliente?: ClienteInfo, agora = new Date()) {
    this.agentes.exigirCadastroTecnico(user);
    const ip = normalizarIp(cliente?.ip);
    if (!ip) return [];
    const pedidos = await this.prisma.cameras_pareamentos.findMany({
      where: { ip_publico: ip, agente_id: null, vinculado_em: null, expira_em: { gt: agora } },
      orderBy: { criado_em: 'desc' },
      take: 20,
    });
    // Sem `codigo`: quem está na mesma rede escolhe o aparelho por pedido_id (vincular confere o IP de novo).
    return pedidos.map((p) => ({
      pedido_id: p.id,
      host: p.host,
      mac: p.mac,
      ip_local: p.ip_local,
      criado_em: p.criado_em,
      expira_em: p.expira_em,
    }));
  }

  /**
   * POST /cameras/pareamento/vincular — cria o agente e guarda o token cifrado para o aparelho.
   * Por `codigo` (digitado do aparelho, de qualquer rede) ou por `pedido_id` (escolhido em /proximos,
   * só enquanto o IP de quem chama for o ip_publico do pedido). Falha conta no limite por usuário e
   * por unidade e vai para a trilha como camera_pareamento_falha.
   */
  async vincular(dto: VincularPareamentoDto, user?: Usuario, cliente?: ClienteInfo, agora = new Date()) {
    this.agentes.exigirCadastroTecnico(user);
    const temCodigo = dto.codigo !== undefined && dto.codigo !== null && dto.codigo !== '';
    const temPedido = !!dto.pedido_id?.trim();
    if (temCodigo === temPedido) throw new BadRequestException('Informe codigo ou pedido_id (só um dos dois)');
    const via: 'codigo' | 'pedido_id' = temCodigo ? 'codigo' : 'pedido_id';
    const unidadeId = dto.unidade_id.trim();

    const chaveUsuario = user?.id ? `u:${String(user.id).trim()}` : `ip:${chaveLimiteIp(cliente?.ip)}`;
    const chaveUnidade = `un:${unidadeId}`;
    const t = agora.getTime();
    // Conta a tentativa ANTES de qualquer await (sem corrida entre pedidos simultâneos);
    // só é devolvida se o vínculo der certo.
    if (!this.falhasUsuario.permitir(chaveUsuario, t)) {
      throw new HttpException(MSG_MUITAS_TENTATIVAS_VINCULAR, HttpStatus.TOO_MANY_REQUESTS);
    }
    if (!this.falhasUnidade.permitir(chaveUnidade, t)) {
      this.falhasUsuario.desfazer(chaveUsuario, t);
      throw new HttpException(MSG_MUITAS_TENTATIVAS_VINCULAR, HttpStatus.TOO_MANY_REQUESTS);
    }
    const devolverTentativa = () => {
      this.falhasUsuario.desfazer(chaveUsuario, t);
      this.falhasUnidade.desfazer(chaveUnidade, t);
    };

    if (user) await this.scope.assertEntityInScope('unidade', unidadeId, user);
    const ctx = await this.auditoria.contextoUnidade(unidadeId);
    if (!ctx.unidade || !ctx.planta) throw new NotFoundException('Unidade não encontrada');

    const falhar = async (motivo: string): Promise<never> => {
      const tentado = via === 'codigo' ? mascararCodigo(dto.codigo) : null;
      await this.auditoria.registrar('camera_pareamento_falha', {
        mensagem: `Pareamento recusado (${motivo}) por ${via === 'codigo' ? `código ${tentado}` : `pedido ${dto.pedido_id?.trim()}`} de IP ${cliente?.ip ?? '?'} — ${ctx.unidade!.nome} (${ctx.planta!.nome})`,
        user,
        cliente,
        unidade: ctx.unidade,
        planta: ctx.planta,
        objetoTipo: 'camera_pareamento',
        objetoId: via === 'pedido_id' ? (dto.pedido_id?.trim().slice(0, 26) ?? null) : null,
        resultado: 'negado',
        extra: { acao: 'vincular', via, motivo, codigo_tentado: tentado, pedido_id: via === 'pedido_id' ? dto.pedido_id?.trim() : null },
      });
      throw new NotFoundException(MSG_CODIGO_INVALIDO);
    };

    const aguardando = { agente_id: null, vinculado_em: null, expira_em: { gt: agora } };
    let p: Awaited<ReturnType<typeof this.prisma.cameras_pareamentos.findFirst>>;
    if (via === 'codigo') {
      const codigo = normalizarCodigo(dto.codigo);
      if (!codigo) return falhar('código inválido');
      p = await this.prisma.cameras_pareamentos.findFirst({ where: { codigo, ...aguardando }, orderBy: { criado_em: 'desc' } });
      if (!p) return falhar('código não encontrado ou expirado');
    } else {
      p = await this.prisma.cameras_pareamentos.findFirst({ where: { id: dto.pedido_id!.trim(), ...aguardando } });
      if (!p) return falhar('pedido não encontrado ou expirado');
      // Escolher pela lista só vale na mesma rede do aparelho; fora dela, digitar o código.
      if (!mesmoIp(cliente?.ip, p.ip_publico)) return falhar('pedido de outra rede');
    }

    // Reserva o pedido antes de criar o agente: dois cliques ao mesmo tempo não criam dois agentes.
    const reservado = await this.prisma.cameras_pareamentos.updateMany({
      where: { id: p.id, agente_id: null, vinculado_em: null },
      data: { vinculado_em: agora },
    });
    if (reservado.count !== 1) return falhar('pedido já vinculado');

    let criado: Awaited<ReturnType<CamerasAgenteService['inserirAgente']>>;
    try {
      criado = await this.agentes.inserirAgente(unidadeId, ctx.planta.id, dto.nome?.trim() || p.host, {
        host: p.host,
        versao: p.versao,
      });
      await this.prisma.cameras_pareamentos.update({
        where: { id: p.id },
        data: { agente_id: criado.agente.id, token_cifrado: this.midia.cifrar(criado.token) },
      });
    } catch (e) {
      await this.prisma.cameras_pareamentos
        .updateMany({ where: { id: p.id, agente_id: null }, data: { vinculado_em: null } })
        .catch(() => undefined);
      throw e;
    }
    const a = criado.agente;
    devolverTentativa();

    await this.auditoria.registrar('camera_agente_pareado', {
      mensagem: `Aparelho "${p.host}"${p.mac ? ` (MAC ${p.mac})` : ''} pareado pelo código ${p.codigo} (${via === 'codigo' ? 'código digitado' : 'escolhido na lista da mesma rede'}) de IP ${p.ip_publico}${p.ip_local ? ` / ${p.ip_local}` : ''} como agente de câmeras "${a.nome}" — ${ctx.unidade.nome} (${ctx.planta.nome})`,
      user,
      cliente,
      unidade: ctx.unidade,
      planta: ctx.planta,
      objetoTipo: 'camera_agente',
      objetoId: a.id,
      extra: {
        agente: { id: a.id, nome: a.nome },
        acao: 'pareado',
        via,
        pareamento: {
          id: p.id,
          codigo: p.codigo,
          host: p.host,
          mac: p.mac,
          versao: p.versao,
          ip_publico: p.ip_publico,
          ip_local: p.ip_local,
        },
      },
    });
    return { agente: this.agentes.apresentar(a, 0, agora) };
  }
}
