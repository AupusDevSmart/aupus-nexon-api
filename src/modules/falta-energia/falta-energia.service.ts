import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { createHash, randomBytes } from 'crypto';
import { PrismaService, PermissionScopeService, ScopedUser } from '@/core';
import { AuditoriaAcessosService, type AcaoAuditoria } from '@/core/modules/usuarios/auditoria-acessos.service';
import { isGlobal, papelCanonico } from '@/core/modules/auth/papeis';
import { novoId26, type ClienteInfo } from '@/core/common/cliente-info';
import { ChamadosService } from '../chamados/chamados.service';
import { MqttService } from '../../shared/mqtt/mqtt.service';
import {
  automacaoLigada,
  chaveDoEvento,
  duracao,
  horaBr,
  lerAviso,
  lerRetornoWhatsaupus,
  MAX_TENTATIVAS,
  minutosConfirmacao,
  montarPayloadWhatsaupus,
  normalizarUc,
  pendenciasParaRobo,
  STATUS_EVENTO_ROTULO,
  type DadosInstalacao,
  type StatusEvento,
} from './falta-energia-regras';
import type { AvisarFaltaEnergiaDto, ListarFaltaEnergiaDto } from './dto/falta-energia.dto';

type Usuario = ScopedUser & { nome?: string | null; email?: string | null };
type Evento = Awaited<ReturnType<PrismaService['falta_energia_eventos']['findFirst']>> & {};

const t = (v: string | null | undefined) => (v ? v.trim() : null);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** Evento aberto há mais que isso não agrupa aviso novo (TON que morreu sem mandar "retorno"). */
const JANELA_AGRUPAR_MS = 24 * 3_600_000;

interface Instalacao extends DadosInstalacao {
  equipamento: { id: string; nome: string } | null;
  unidade: { id: string; nome: string } | null;
  plantaId: string;
  proprietarioId: string | null;
}

/**
 * Falta de energia (NEXON-145): aviso da TON → chamado EXTERNO na concessionária (NEXON-144) →
 * robô da Equatorial no WhatsAupus → protocolo de volta no chamado. Tudo com trilha em
 * auditoria_acessos (objeto_tipo 'falta_energia', objeto_id = evento) e linha do tempo no chamado.
 */
@Injectable()
export class FaltaEnergiaService implements OnModuleInit {
  private readonly logger = new Logger(FaltaEnergiaService.name);
  private rodando = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly chamados: ChamadosService,
    private readonly auditoria: AuditoriaAcessosService,
    private readonly scopeService: PermissionScopeService,
    private readonly mqtt: MqttService,
  ) {}

  onModuleInit() {
    this.mqtt.setEnergiaHook((tonId, dados) => this.receberDaTon(tonId, dados));
  }

  // ---------------------------------------------------------------------------
  // Entrada: TON (MQTT <base>/energia) e pedido manual
  // ---------------------------------------------------------------------------

  /** Hook do MqttService para `<base>/energia`. Nunca lança (log e segue). */
  async receberDaTon(tonId: string, dados: unknown): Promise<void> {
    try {
      const aviso = lerAviso(dados);
      if (!aviso) {
        this.logger.warn(`[falta-energia] payload não entendido da TON ${tonId}: ${JSON.stringify(dados).slice(0, 200)}`);
        return;
      }
      const inst = await this.instalacaoDaTon(tonId);
      if (!inst) {
        this.logger.warn(`[falta-energia] TON ${tonId} sem planta: aviso ignorado`);
        return;
      }
      if (aviso.tipo === 'falta') await this.registrarFalta(inst, aviso.em, 'TON', dados);
      else await this.registrarRetorno(inst, aviso.em, dados);
    } catch (e) {
      this.logger.error(`[falta-energia] TON ${tonId}: ${(e as Error).message}`);
    }
  }

  /** Botão "Avisar falta de energia" (admin e analistas): abre na hora, sem esperar confirmação. */
  async avisarManual(dto: AvisarFaltaEnergiaDto, user: Usuario, cliente?: ClienteInfo) {
    if (!isGlobal(papelCanonico(user?.role))) throw new ForbiddenException('Só admin e analistas avisam falta de energia');
    const inst = dto.equipamento_id
      ? await this.instalacaoDaTon(dto.equipamento_id.trim())
      : dto.unidade_id
        ? await this.instalacaoDaUnidade(dto.unidade_id.trim())
        : null;
    if (!inst) throw new NotFoundException('Equipamento ou unidade não encontrado (ou sem planta)');
    await this.scopeService.assertPlantaInScope(inst.plantaId, user);

    const aberto = await this.eventoAberto(chaveDoEvento(inst.unidade?.id, inst.plantaId));
    if (aberto && aberto.status !== 'FALHOU' && aberto.status !== 'SEM_DADOS') {
      throw new BadRequestException(`Já existe aviso de falta aberto nesta unidade (${STATUS_EVENTO_ROTULO[aberto.status as StatusEvento]})`);
    }
    const ev = await this.prisma.falta_energia_eventos.create({
      data: {
        id: novoId26(),
        equipamento_id: inst.equipamento?.id ?? null,
        unidade_id: inst.unidade?.id ?? null,
        planta_id: inst.plantaId,
        chave: chaveDoEvento(inst.unidade?.id, inst.plantaId),
        origem: 'MANUAL',
        status: 'AGUARDANDO',
        inicio_em: new Date(),
        uc: normalizarUc(inst.uc),
        concessionaria: inst.concessionariaNome,
        autor_id: t(user.id),
        autor_nome: user.nome ?? null,
      },
    });
    await this.auditar('falta_energia_manual', ev, inst, {
      user,
      cliente,
      mensagem: `Falta de energia avisada à mão — ${inst.planta.nome}${inst.unidade ? ` / ${inst.unidade.nome}` : ''}, UC ${ev.uc ?? 'sem UC'}`,
    });
    await this.abrirChamado(ev.id);
    return this.apresentar(await this.prisma.falta_energia_eventos.findUniqueOrThrow({ where: { id: ev.id } }));
  }

  /** Reenviar ao robô depois de FALHOU (ou de corrigir o cadastro em SEM_DADOS). */
  async reenviar(id: string, user: Usuario, cliente?: ClienteInfo) {
    if (!isGlobal(papelCanonico(user?.role))) throw new ForbiddenException('Só admin e analistas reenviam');
    const ev = await this.prisma.falta_energia_eventos.findUnique({ where: { id: id.trim() } });
    if (!ev) throw new NotFoundException('Aviso de falta não encontrado');
    await this.scopeService.assertPlantaInScope(ev.planta_id, user);
    if (ev.status !== 'FALHOU' && ev.status !== 'SEM_DADOS') throw new BadRequestException('Só reenvia aviso que falhou ou estava sem dados');
    if (!ev.chamado_id) throw new BadRequestException('Aviso sem chamado');

    const inst = await this.instalacaoDoEvento(ev);
    const pend = pendenciasParaRobo(inst);
    if (pend.length) throw new BadRequestException(`Ainda falta: ${pend.join(', ')}`);
    await this.prisma.falta_energia_eventos.update({
      where: { id: ev.id },
      data: { status: 'ENVIANDO', tentativas: 0, ultimo_erro: null, uc: normalizarUc(inst.uc), concessionaria: inst.concessionariaNome },
    });
    await this.nota(ev.chamado_id, `Reenviado ao robô da concessionária por ${user.nome ?? 'usuário'}.`, user, cliente);
    await this.enviar(ev.id);
    return this.apresentar(await this.prisma.falta_energia_eventos.findUniqueOrThrow({ where: { id: ev.id } }));
  }

  async listar(q: ListarFaltaEnergiaDto, user?: Usuario) {
    const where: Record<string, unknown> = {};
    if (q.chamado_id) where.chamado_id = q.chamado_id.trim();
    if (q.planta_id) where.planta_id = q.planta_id.trim();
    const scope = await this.scopeService.getScope(user);
    if (this.scopeService.isScoped(scope)) {
      const ids = scope.map((p) => p.trim());
      if (q.planta_id && !ids.includes(q.planta_id.trim())) return { data: [] };
      where.planta_id = q.planta_id ? q.planta_id.trim() : { in: ids };
    }
    const linhas = await this.prisma.falta_energia_eventos.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: Math.min(q.limit ?? 20, 100),
    });
    return { data: linhas.map((l) => this.apresentar(l)) };
  }

  // ---------------------------------------------------------------------------
  // Retorno do WhatsAupus (callback com token na URL)
  // ---------------------------------------------------------------------------

  async retornoWhatsaupus(token: string, body: unknown) {
    const ev = token?.length >= 32
      ? await this.prisma.falta_energia_eventos.findFirst({ where: { callback_token_hash: sha256(token) } })
      : null;
    if (!ev) throw new NotFoundException('Retorno desconhecido');
    const r = lerRetornoWhatsaupus(body);
    const inst = await this.instalacaoDoEvento(ev);
    this.logger.log(`[falta-energia] retorno WhatsAupus evento=${ev.id} status=${r.status} protocolo=${r.protocolo ?? '-'}`);

    if (r.status === 'completed' && r.protocolo) {
      if (ev.status === 'PROTOCOLO' && ev.protocolo === r.protocolo) return { ok: true, repetido: true };
      const agora = new Date();
      await this.prisma.falta_energia_eventos.update({
        where: { id: ev.id },
        data: { status: 'PROTOCOLO', protocolo: r.protocolo, callback_em: agora, ultimo_erro: null, whatsaupus_id: ev.whatsaupus_id ?? r.complaintId },
      });
      if (ev.chamado_id) {
        await this.passo(`protocolo no chamado ${ev.chamado_id}`, () =>
          this.chamados.editar(ev.chamado_id!, { protocolo: r.protocolo!, aberto_em: agora.toISOString() }),
        );
        if (!ev.fim_em) {
          await this.passo(`status do chamado ${ev.chamado_id}`, () =>
            this.chamados.mudarStatus(ev.chamado_id!, {
              status: 'EM_ANDAMENTO',
              texto: `Protocolo ${r.protocolo} aberto na ${ev.concessionaria ?? 'concessionária'} pelo WhatsApp.`,
            }),
          );
        } else {
          await this.nota(ev.chamado_id, `Protocolo ${r.protocolo} aberto na ${ev.concessionaria ?? 'concessionária'} pelo WhatsApp (a energia já tinha voltado).`);
        }
      }
      const extras = [
        r.previsao ? `Previsão da concessionária: ${r.previsao}.` : '',
        r.ucNova && r.ucNova !== normalizarUc(ev.uc) ? `A Clara informou a UC no padrão novo: ${r.ucNova} (atualize o cadastro da unidade).` : '',
      ].filter(Boolean);
      if (ev.chamado_id && extras.length) await this.nota(ev.chamado_id, extras.join(' '));
      await this.auditar('falta_energia_protocolo', { ...ev, protocolo: r.protocolo }, inst, {
        mensagem: `Protocolo ${r.protocolo} da ${ev.concessionaria ?? 'concessionária'} — falta de energia em ${inst.planta.nome}, UC ${ev.uc ?? '-'}`,
        extra: { whatsaupus_id: r.complaintId, uc_nova: r.ucNova, previsao: r.previsao },
      });
      return { ok: true };
    }

    if (r.status === 'failed' || r.status === 'completed') {
      const erro = r.erro || (r.status === 'completed' ? 'Concluído sem protocolo' : 'Robô não conseguiu abrir');
      await this.prisma.falta_energia_eventos.update({
        where: { id: ev.id },
        data: { status: 'FALHOU', ultimo_erro: erro.slice(0, 500), callback_em: new Date() },
      });
      if (ev.chamado_id) {
        await this.nota(ev.chamado_id, `O WhatsApp da concessionária não devolveu protocolo: ${erro}. Abra na mão (62 3243-2020 ou 0800 062 0196) e registre o protocolo aqui.`);
      }
      await this.auditar('falta_energia_falhou', ev, inst, {
        resultado: 'erro',
        mensagem: `Robô não abriu protocolo — falta de energia em ${inst.planta.nome}, UC ${ev.uc ?? '-'}: ${erro}`,
        extra: { whatsaupus_id: r.complaintId, erro },
      });
      return { ok: true };
    }

    // needs_human: o robô parou e um atendente do WhatsAupus assumiu; o protocolo chega depois pelo
    // mesmo callback. Nota uma vez por motivo. in_progress: só carimba.
    if (r.status === 'needs_human') {
      const motivo = `Atendente do WhatsAupus assumiu: ${r.erro ?? 'o robô não entendeu a Clara'}`.slice(0, 500);
      const novo = ev.ultimo_erro !== motivo;
      await this.prisma.falta_energia_eventos.update({ where: { id: ev.id }, data: { callback_em: new Date(), ultimo_erro: motivo } });
      if (novo && ev.chamado_id) await this.nota(ev.chamado_id, `${motivo}. O protocolo aparece aqui quando ele terminar.`);
      if (novo) {
        await this.auditar('falta_energia_falhou', ev, inst, {
          resultado: 'erro',
          mensagem: `Robô da ${ev.concessionaria ?? 'concessionária'} passou para atendente — ${inst.planta.nome}, UC ${ev.uc ?? '-'}: ${r.erro ?? '-'}`,
          extra: { whatsaupus_id: r.complaintId, atendente: true },
        });
      }
      return { ok: true };
    }
    await this.prisma.falta_energia_eventos.update({ where: { id: ev.id }, data: { callback_em: new Date() } });
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Fila: confirmação da falta e entrega ao WhatsAupus
  // ---------------------------------------------------------------------------

  @Interval(20_000)
  async tick() {
    if (this.rodando || !automacaoLigada()) return;
    this.rodando = true;
    try {
      const limite = new Date(Date.now() - minutosConfirmacao() * 60_000);
      const confirmar = await this.prisma.falta_energia_eventos.findMany({
        where: { status: 'AGUARDANDO', fim_em: null, inicio_em: { lte: limite } },
        orderBy: { inicio_em: 'asc' },
        take: 20,
        select: { id: true },
      });
      for (const { id } of confirmar) await this.abrirChamado(id);

      const pendentes = await this.prisma.falta_energia_eventos.findMany({
        where: { status: 'ENVIANDO' },
        orderBy: { updated_at: 'asc' },
        take: 20,
      });
      for (const ev of pendentes) {
        // Espera crescente entre tentativas: 0, 1, 2, 4, 8 min.
        const espera = ev.tentativas ? 60_000 * 2 ** (ev.tentativas - 1) : 0;
        if (Date.now() - ev.updated_at.getTime() >= espera) await this.enviar(ev.id);
      }
    } catch (e) {
      this.logger.error(`[falta-energia] tick: ${(e as Error).message}`);
    } finally {
      this.rodando = false;
    }
  }

  /** AGUARDANDO → chamado aberto → ENVIANDO (ou SEM_DADOS). Trava pelo update condicional. */
  async abrirChamado(eventoId: string): Promise<void> {
    const travou = await this.prisma.falta_energia_eventos.updateMany({
      where: { id: eventoId, status: 'AGUARDANDO', chamado_id: null },
      data: { status: 'ENVIANDO' },
    });
    if (!travou.count) return;
    const ev = (await this.prisma.falta_energia_eventos.findUnique({ where: { id: eventoId } }))!;
    const inst = await this.instalacaoDoEvento(ev);
    const pend = pendenciasParaRobo(inst);
    const conc = inst.concessionariaNome?.trim() || 'Concessionária';

    let chamado: { id: string; numero: number };
    try {
      chamado = (await this.chamados.abrir(
        {
          tipo: 'EXTERNO',
          orgao: conc.slice(0, 120),
          titulo: `Falta de energia — ${inst.planta.nome}${inst.unidade ? ` / ${inst.unidade.nome}` : ''}`.slice(0, 200),
          descricao: [
            `Falta de energia ${ev.origem === 'TON' ? `avisada pela TON${inst.equipamento ? ` ${inst.equipamento.nome}` : ''}` : `avisada por ${ev.autor_nome ?? 'usuário'}`} às ${horaBr(ev.inicio_em)}.`,
            `UC: ${normalizarUc(inst.uc) ?? 'não cadastrada'}.`,
            pend.length ? '' : `O NexON vai abrir o protocolo na ${conc} pelo WhatsApp e registrar aqui.`,
          ].filter(Boolean).join(' '),
          motivo: 'FALTA_ENERGIA',
          prioridade: 'ALTA',
          planta_id: inst.plantaId,
          ...(inst.unidade ? { unidade_id: inst.unidade.id } : {}),
          ...(inst.equipamento ? { equipamento_id: inst.equipamento.id } : {}),
          ocorrencia_em: ev.inicio_em.toISOString(),
        },
        undefined,
      )) as { id: string; numero: number };
    } catch (e) {
      const erro = (e as Error).message;
      this.logger.error(`[falta-energia] abrir chamado do evento ${ev.id}: ${erro}`);
      await this.prisma.falta_energia_eventos.update({
        where: { id: ev.id },
        data: { status: 'AGUARDANDO', tentativas: { increment: 1 }, ultimo_erro: `Abrir chamado: ${erro}`.slice(0, 500) },
      });
      return;
    }

    if (pend.length) {
      await this.prisma.falta_energia_eventos.update({
        where: { id: ev.id },
        data: { status: 'SEM_DADOS', chamado_id: chamado.id, uc: normalizarUc(inst.uc), concessionaria: inst.concessionariaNome, ultimo_erro: `Falta: ${pend.join(', ')}`.slice(0, 500) },
      });
      await this.nota(chamado.id, `Não abri na concessionária sozinho porque falta: ${pend.join(', ')}. Complete o cadastro e use "Reenviar", ou abra na mão e registre o protocolo aqui.`);
      await this.auditar('falta_energia_falhou', { ...ev, chamado_id: chamado.id }, inst, {
        resultado: 'erro',
        mensagem: `Chamado #${chamado.numero} de falta de energia aberto sem robô — ${inst.planta.nome}: falta ${pend.join(', ')}`,
        extra: { chamado: chamado, pendencias: pend },
      });
      return;
    }

    const token = randomBytes(24).toString('hex');
    await this.prisma.falta_energia_eventos.update({
      where: { id: ev.id },
      data: {
        chamado_id: chamado.id,
        uc: normalizarUc(inst.uc),
        concessionaria: inst.concessionariaNome,
        callback_token_hash: sha256(token),
      },
    });
    this.tokens.set(ev.id, token);
    await this.enviar(ev.id);
  }

  /** Token em claro só vive em memória até a entrega (no banco fica o hash). */
  private readonly tokens = new Map<string, string>();

  /** ENVIANDO → NO_ROBO (ou retentativa / FALHOU). */
  async enviar(eventoId: string): Promise<void> {
    const ev = await this.prisma.falta_energia_eventos.findUnique({ where: { id: eventoId } });
    if (!ev || ev.status !== 'ENVIANDO' || !ev.chamado_id) return;
    const inst = await this.instalacaoDoEvento(ev);

    // Sem o token em memória (API reiniciou ou reenvio), gera outro: o hash antigo deixa de valer.
    let token = this.tokens.get(ev.id);
    if (!token) {
      token = randomBytes(24).toString('hex');
      await this.prisma.falta_energia_eventos.update({ where: { id: ev.id }, data: { callback_token_hash: sha256(token) } });
    }
    const payload = montarPayloadWhatsaupus({
      eventoId: ev.id,
      dados: inst,
      inicio: ev.inicio_em,
      equipamentoNome: inst.equipamento?.nome ?? null,
      callbackUrl: `${baseCallback()}/falta-energia/whatsaupus/${token}`,
    });

    try {
      const { base, apiKey } = await this.credenciaisWhatsaupus();
      const res = await fetch(`${base}/api/v1/webhook/nexon/falta-energia`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000),
      });
      const texto = await res.text();
      if (!res.ok) throw new Error(`WhatsAupus HTTP ${res.status}: ${texto.slice(0, 200)}`);
      const corpo = JSON.parse(texto || '{}') as { complaintId?: string; status?: string; deduped?: boolean };
      this.tokens.delete(ev.id);
      await this.prisma.falta_energia_eventos.update({
        where: { id: ev.id },
        data: { status: 'NO_ROBO', whatsaupus_id: corpo.complaintId?.slice(0, 40) ?? null, tentativas: { increment: 1 }, ultimo_erro: null },
      });
      await this.nota(ev.chamado_id, `Enviado ao WhatsApp da ${ev.concessionaria ?? 'concessionária'} (UC ${payload.uc}, ${payload.cliente.nome ?? 'cliente'}). Aguardando o protocolo.`);
      await this.auditar('falta_energia_enviada', ev, inst, {
        mensagem: `Falta de energia enviada ao robô da ${ev.concessionaria ?? 'concessionária'} — ${inst.planta.nome}, UC ${payload.uc}`,
        extra: {
          whatsaupus_id: corpo.complaintId ?? null,
          deduplicado: !!corpo.deduped,
          enviado: { uc: payload.uc, cliente: payload.cliente.nome ?? null, telefone: payload.cliente.telefone, endereco: payload.endereco },
        },
      });
    } catch (e) {
      const erro = (e as Error).message.slice(0, 500);
      const tentativas = ev.tentativas + 1;
      const desiste = tentativas >= MAX_TENTATIVAS;
      await this.prisma.falta_energia_eventos.update({
        where: { id: ev.id },
        data: { tentativas, ultimo_erro: erro, ...(desiste ? { status: 'FALHOU' } : {}) },
      });
      this.logger.warn(`[falta-energia] evento ${ev.id} tentativa ${tentativas}: ${erro}`);
      if (desiste) {
        this.tokens.delete(ev.id);
        await this.nota(ev.chamado_id, `Não consegui enviar ao WhatsApp da concessionária depois de ${tentativas} tentativas (${erro}). Abra na mão (62 3243-2020 ou 0800 062 0196) e registre o protocolo aqui.`);
        await this.auditar('falta_energia_falhou', ev, inst, {
          resultado: 'erro',
          mensagem: `Falta de energia não entregue ao WhatsAupus — ${inst.planta.nome}, UC ${ev.uc ?? '-'}: ${erro}`,
          extra: { tentativas, erro },
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Falta e retorno
  // ---------------------------------------------------------------------------

  private async registrarFalta(inst: Instalacao, em: Date, origem: 'TON' | 'MANUAL', payload: unknown) {
    const chave = chaveDoEvento(inst.unidade?.id, inst.plantaId);
    const aberto = await this.eventoAberto(chave);
    if (aberto) {
      await this.prisma.falta_energia_eventos.update({ where: { id: aberto.id }, data: { avisos: { increment: 1 } } });
      return;
    }
    const ev = await this.prisma.falta_energia_eventos.create({
      data: {
        id: novoId26(),
        equipamento_id: inst.equipamento?.id ?? null,
        unidade_id: inst.unidade?.id ?? null,
        planta_id: inst.plantaId,
        chave,
        origem,
        status: 'AGUARDANDO',
        inicio_em: em,
        uc: normalizarUc(inst.uc),
        concessionaria: inst.concessionariaNome,
        payload_ton: (payload ?? null) as any,
        autor_nome: 'NexON (automático)',
      },
    });
    await this.auditar('falta_energia_aviso', ev, inst, {
      mensagem: `TON ${inst.equipamento?.nome ?? ''} avisou falta de energia — ${inst.planta.nome}${inst.unidade ? ` / ${inst.unidade.nome}` : ''}, UC ${ev.uc ?? 'sem UC'}`,
      extra: { confirmar_em_min: minutosConfirmacao(), payload_ton: payload ?? null },
    });
  }

  private async registrarRetorno(inst: Instalacao, em: Date, payload: unknown) {
    const aberto = await this.eventoAberto(chaveDoEvento(inst.unidade?.id, inst.plantaId));
    if (!aberto) return;
    const fim = em < aberto.inicio_em ? new Date() : em;
    const cancelou = aberto.status === 'AGUARDANDO';
    await this.prisma.falta_energia_eventos.update({
      where: { id: aberto.id },
      data: { fim_em: fim, ...(cancelou ? { status: 'CANCELADO' } : {}) },
    });
    const texto = `Energia voltou às ${horaBr(fim)} (TON ${inst.equipamento?.nome ?? ''}), depois de ${duracao(aberto.inicio_em, fim)} sem energia.`;
    if (aberto.chamado_id) {
      await this.passo(`resolver chamado ${aberto.chamado_id}`, () =>
        this.chamados.mudarStatus(aberto.chamado_id!, { status: 'RESOLVIDO', texto, quando: fim.toISOString() }),
      );
    }
    await this.auditar('falta_energia_retorno', { ...aberto, fim_em: fim }, inst, {
      mensagem: `${cancelou ? 'Piscada: energia voltou antes de abrir chamado' : 'Energia voltou'} — ${inst.planta.nome}, UC ${aberto.uc ?? '-'}, ${duracao(aberto.inicio_em, fim)}`,
      extra: { cancelado: cancelou, duracao_min: Math.round((fim.getTime() - aberto.inicio_em.getTime()) / 60_000), payload_ton: payload ?? null },
    });
  }

  private eventoAberto(chave: string) {
    return this.prisma.falta_energia_eventos.findFirst({
      where: {
        chave,
        fim_em: null,
        status: { not: 'CANCELADO' },
        inicio_em: { gte: new Date(Date.now() - JANELA_AGRUPAR_MS) },
      },
      orderBy: { inicio_em: 'desc' },
    });
  }

  // ---------------------------------------------------------------------------
  // Cadastro: TON → unidade (UC, concessionária) → planta (endereço) → proprietário
  // ---------------------------------------------------------------------------

  private async instalacaoDaTon(tonId: string): Promise<Instalacao | null> {
    const e = await this.prisma.equipamentos.findFirst({
      where: { id: tonId },
      select: { id: true, nome: true, planta_id: true, unidade_id: true },
    });
    if (!e) return null;
    return this.montarInstalacao(t(e.unidade_id), t(e.planta_id), { id: e.id.trim(), nome: e.nome });
  }

  private instalacaoDaUnidade(unidadeId: string) {
    return this.montarInstalacao(unidadeId, null, null);
  }

  private async instalacaoDoEvento(ev: NonNullable<Evento>): Promise<Instalacao> {
    const eq = ev.equipamento_id
      ? await this.prisma.equipamentos.findFirst({ where: { id: ev.equipamento_id }, select: { id: true, nome: true } })
      : null;
    const inst = await this.montarInstalacao(ev.unidade_id, ev.planta_id, eq ? { id: eq.id.trim(), nome: eq.nome } : null);
    if (!inst) throw new Error(`Planta ${ev.planta_id} do evento ${ev.id} não existe mais`);
    return inst;
  }

  private async montarInstalacao(
    unidadeId: string | null,
    plantaId: string | null,
    equipamento: { id: string; nome: string } | null,
  ): Promise<Instalacao | null> {
    const unidade = unidadeId
      ? await this.prisma.unidades.findFirst({
          where: { id: unidadeId, deleted_at: null },
          select: { id: true, nome: true, planta_id: true, numero_uc: true, estado: true, concessionaria: { select: { nome: true, estado: true } } },
        })
      : null;
    const pid = t(unidade?.planta_id) ?? plantaId;
    if (!pid) return null;
    const planta = await this.prisma.plantas.findFirst({
      where: { id: pid },
      select: { id: true, nome: true, logradouro: true, bairro: true, cidade: true, uf: true, cep: true, numero_uc: true, proprietario_id: true },
    });
    if (!planta) return null;
    const dono = planta.proprietario_id
      ? await this.prisma.usuarios.findFirst({
          where: { id: planta.proprietario_id },
          select: { id: true, nome: true, cpf_cnpj: true, telefone: true },
        })
      : null;
    return {
      equipamento,
      unidade: unidade ? { id: unidade.id.trim(), nome: unidade.nome } : null,
      plantaId: planta.id.trim(),
      proprietarioId: t(dono?.id),
      uc: unidade?.numero_uc || planta.numero_uc || null,
      concessionariaNome: unidade?.concessionaria?.nome ?? null,
      concessionariaUf: unidade?.concessionaria?.estado ?? null,
      planta: {
        nome: planta.nome,
        logradouro: planta.logradouro,
        bairro: planta.bairro,
        cidade: planta.cidade,
        uf: planta.uf || unidade?.estado || null,
        cep: planta.cep,
      },
      proprietario: dono ? { nome: dono.nome, cpfCnpj: dono.cpf_cnpj, telefone: dono.telefone } : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Apoio
  // ---------------------------------------------------------------------------

  /** Credencial do WhatsAupus: a mesma chave externa do envio de notificações (bdo.configuracoes). */
  private async credenciaisWhatsaupus(): Promise<{ base: string; apiKey: string }> {
    const rows = await this.prisma.$queryRaw<Array<{ chave: string; valor: string | null }>>`
      SELECT chave, valor FROM bdo.configuracoes WHERE chave IN ('whatsapp_base_url', 'whatsapp_api_key')
    `;
    const v = (k: string) => rows.find((r) => r.chave === k)?.valor?.trim() || null;
    const base = (process.env.WHATSAUPUS_URL || v('whatsapp_base_url') || 'https://wpp.aupusenergia.com.br').replace(/\/$/, '');
    const apiKey = process.env.WHATSAUPUS_API_KEY || v('whatsapp_api_key');
    if (!apiKey) throw new Error('Chave do WhatsAupus não configurada (bdo.configuracoes.whatsapp_api_key)');
    return { base, apiKey };
  }

  private async nota(chamadoId: string, texto: string, user?: Usuario, cliente?: ClienteInfo) {
    await this.passo(`nota no chamado ${chamadoId}`, () => this.chamados.adicionarNota(chamadoId, { texto }, user, cliente));
  }

  /** Passo que não pode derrubar o fluxo (linha do tempo do chamado): loga e segue. */
  private async passo(nome: string, f: () => Promise<unknown>) {
    try {
      await f();
    } catch (e) {
      this.logger.warn(`[falta-energia] ${nome}: ${(e as Error).message}`);
    }
  }

  private apresentar(ev: NonNullable<Evento>) {
    const { callback_token_hash: _h, payload_ton: _p, ...resto } = ev;
    return { ...resto, status_rotulo: STATUS_EVENTO_ROTULO[ev.status as StatusEvento] ?? ev.status };
  }

  /**
   * Trilha em auditoria_acessos. Mensagem sempre com planta e UC (e protocolo quando há) para a
   * busca; objeto = o evento; detalhes com ids, chamado, TON e status.
   */
  private async auditar(
    acao: AcaoAuditoria,
    ev: { id: string; status: string; origem: string; chamado_id: string | null; uc: string | null; protocolo?: string | null; inicio_em: Date; fim_em?: Date | null; concessionaria: string | null },
    inst: Instalacao,
    o: { mensagem: string; user?: Usuario; cliente?: ClienteInfo; resultado?: 'ok' | 'erro'; extra?: Record<string, unknown> },
  ) {
    try {
      await this.auditoria.registrar({
        autorId: t(o.user?.id),
        autorNome: o.user?.nome ?? 'NexON (automático)',
        alvoUsuarioId: inst.proprietarioId,
        alvoNome: inst.proprietario?.nome ?? null,
        acao,
        mensagem: o.mensagem,
        plantaIds: [inst.plantaId],
        unidadeIds: inst.unidade ? [inst.unidade.id] : [],
        dispositivo: o.cliente?.dispositivo ?? null,
        objetoTipo: 'falta_energia',
        objetoId: ev.id,
        resultado: o.resultado ?? 'ok',
        detalhes: {
          evento: {
            id: ev.id,
            status: ev.status,
            origem: ev.origem,
            uc: ev.uc,
            concessionaria: ev.concessionaria,
            protocolo: ev.protocolo ?? null,
            inicio_em: ev.inicio_em,
            fim_em: ev.fim_em ?? null,
          },
          chamado_id: ev.chamado_id,
          ton: inst.equipamento,
          unidade: inst.unidade,
          planta: { id: inst.plantaId, nome: inst.planta.nome },
          ...(o.extra ?? {}),
          ip: o.cliente?.ip ?? null,
          user_agent: o.cliente?.userAgent ?? null,
        },
      });
    } catch (e) {
      this.logger.warn(`[auditoria] ${acao} não registrado (${ev.id}): ${(e as Error).message}`);
    }
  }
}

/** Base pública da API para o WhatsAupus chamar de volta (com /api/v1). */
export function baseCallback(): string {
  return (process.env.NEXON_API_PUBLIC_URL || 'https://aupus-nexon-api.aupusenergia.com.br/api/v1').replace(/\/$/, '');
}
