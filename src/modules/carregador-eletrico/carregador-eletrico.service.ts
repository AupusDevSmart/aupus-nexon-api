import { Injectable, Logger, ForbiddenException, NotFoundException, BadRequestException, ConflictException, GatewayTimeoutException, HttpException, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { randomBytes } from 'node:crypto';
import { MailService } from '../../core/mail/mail.service';
import {
  dataBR,
  hojeSP,
  moradorVeValoresDa,
  papelCarregador,
  PapelCarregador,
  podeExportarRecargas,
  podeGerirMoradores,
  situacaoValidade,
  somarDias,
  tarifaValida,
  validadeDe,
} from './carregador.util';
import { MSG_SOMENTE_LEITURA } from '../../core/modules/auth/papeis';
import { PrismaService, PermissionScopeService, ScopedUser } from '@/core';
import { MqttService } from '../../shared/mqtt/mqtt.service';
import type { ClienteInfo } from '@/core/common/cliente-info';
import { ErroOcpp } from '../ocpp/ocpp.service';
import { CORRENTE_MIN_A } from '../ocpp/ocpp-protocolo';
import { CarregadorAuditoriaService } from './carregador-auditoria.service';
import { CarregadorOcppRepositorio, ConfigCarregador, EstacaoCadastro } from './carregador-ocpp.repositorio';
import { CarregadorOcppService } from './carregador-ocpp.service';
import {
  descreverFalha,
  estadoDoStatus,
  gerarIdTag,
  limiteDaRecarga,
  limiteEnergiaDe,
  limiteTempoDe,
  LIMITE_ENERGIA_MAX,
  LIMITE_ENERGIA_MIN,
  LIMITE_TEMPO_MAX,
  LIMITE_TEMPO_MIN,
  origemDaRecarga,
  podeNoCarregador,
  textoMotivoFim,
} from './carregador-ocpp.regras';

/** Erro da chamada ao carregador → resposta HTTP com mensagem de tela. */
export function erroDoCarregador(e: unknown): HttpException {
  if (e instanceof HttpException) return e;
  if (e instanceof ErroOcpp) {
    if (e.tipo === 'offline') return new BadRequestException('Carregador sem comunicação. Confira a internet do local e tente de novo.');
    if (e.tipo === 'timeout') return new GatewayTimeoutException('O carregador não respondeu ao comando. Tente de novo.');
    return new ConflictException(`O carregador não aceitou o comando (${e.codigo ?? 'erro'}).`);
  }
  return new BadRequestException(e instanceof Error ? e.message : 'Falha ao falar com o carregador.');
}

/** Limites do carregador no formato da tela (`/estado` e resposta do `PUT /config`). */
export function limitesParaTela(cfg: ConfigCarregador) {
  return {
    tempo_min: cfg.limiteTempoMin,
    energia_kwh: cfg.limiteEnergiaKwh,
    inicio_automatico: cfg.inicioAutomatico,
    corrente_a: cfg.limiteCorrenteA,
    corrente_min_a: CORRENTE_MIN_A,
    corrente_max_a: cfg.correnteMaxA,
    corrente_suportada: cfg.correnteSuportada,
  };
}

const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z') : null);

/**
 * Carregador Elétrico (EV) — recarga por morador em condomínio.
 *
 * Fluxo: porteiro libera a recarga no nome do morador (ou tag identifica sozinha) →
 * a TON habilita o contator e mede kWh (medidor Modbus OU o próprio carregador no
 * broker) → ao DESCONECTAR, a TON/carregador corta o fornecimento e encerra a sessão.
 * Ociosidade: só conta a partir do momento em que OUTRO morador "pede a vaga" (o
 * porteiro registra no NexON). Export mensal: morador · kWh · ocioso · R$.
 *
 * Owner-scoped por planta. Ingestão MQTT (kWh + fim de sessão) fica no MqttService.
 */
const TODOS_PAPEIS: PapelCarregador[] = ['analista', 'proprietario', 'operador', 'morador'];
const PAPEIS_GEREM_MORADOR = TODOS_PAPEIS.filter(podeGerirMoradores);
const PAPEIS_EXPORTAM = TODOS_PAPEIS.filter(podeExportarRecargas);

@Injectable()
export class CarregadorEletricoService {
  private readonly logger = new Logger(CarregadorEletricoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: PermissionScopeService,
    private readonly mqtt: MqttService,
    private readonly mail: MailService,
    // Carregador ligado por OCPP (NEXON-130). Opcionais: sem eles vale só o fluxo da TON.
    @Optional() private readonly ocpp?: CarregadorOcppService,
    @Optional() private readonly repoOcpp?: CarregadorOcppRepositorio,
    @Optional() private readonly auditoria?: CarregadorAuditoriaService,
  ) {
    // Acesso que venceu durante a recarga expira assim que ela fecha.
    this.ocpp?.quandoEncerrar(() => void this.cuidarValidades());
  }

  /** Estação OCPP do carregador, ou null: aí o carregador é o da TON (MQTT). */
  private async estacaoOcpp(eid: string): Promise<EstacaoCadastro | null> {
    if (!this.ocpp || !this.repoOcpp) return null;
    return this.ocpp.estacao(eid);
  }

  /**
   * Confere o acesso ao carregador (escopo; morador pela planta) e devolve o perfil.
   * Usado pelas rotas de gestão (limites, comandos, conexão OCPP).
   */
  async acesso(equipamentoId: string, user?: ScopedUser): Promise<{ papel: PapelCarregador; morador: any | null; plantaId: string | null }> {
    const eid = equipamentoId.trim();
    const plantaId = await this.plantaDoCarregador(eid);
    const p = user ? await this.papel(user) : { papel: 'analista' as PapelCarregador, morador: null };
    await this.assertCarregador(eid, plantaId, user, p);
    return { ...p, plantaId };
  }

  private quem(user: ScopedUser | undefined, padrao: string): string {
    return String((user as any)?.nome || (user as any)?.name || (user as any)?.email || padrao);
  }

  // ===== Perfil (analista | proprietario | morador) =====
  /** Morador ligado ao usuário logado (moradores.usuario_id ou e-mail igual ao do usuário). */
  async moradorDoUsuario(user?: ScopedUser): Promise<any | null> {
    const uid = (user as any)?.id ? String((user as any).id).trim() : null;
    if (!uid) return null;
    const r = await this.prisma.$queryRaw<any[]>`
      SELECT m.id, m.nome, m.apartamento, m.planta_id, to_char(m.validade,'YYYY-MM-DD') AS validade, m.ativo
      FROM moradores m
      LEFT JOIN usuarios u ON TRIM(u.id) = ${uid}
      WHERE m.deleted_at IS NULL
        AND (TRIM(m.usuario_id) = ${uid} OR (m.email IS NOT NULL AND u.email IS NOT NULL AND lower(m.email) = lower(u.email)))
      ORDER BY m.ativo DESC LIMIT 1`.catch(() => []);
    return r[0] ?? null;
  }
  async papel(user?: ScopedUser): Promise<{ papel: PapelCarregador; morador: any | null }> {
    const role = (user as any)?.role ?? (user as any)?.roles?.[0];
    const morador = await this.moradorDoUsuario(user);
    return { papel: papelCarregador(typeof role === 'object' ? role?.name : role, !!morador), morador };
  }
  private async exigirPapel(user: ScopedUser | undefined, aceitos: PapelCarregador[], msg: string) {
    if (!user) return;
    const { papel } = await this.papel(user);
    if (!aceitos.includes(papel)) throw new ForbiddenException(msg);
  }

  /**
   * Acesso ao carregador para operar (liberar, parar, pedir vaga, estado).
   * Morador: o carregador tem de ser da planta dele (o vínculo é o cadastro de
   * morador, não o escopo do NexON). Demais: escopo do equipamento, que no
   * operador também exige o equipamento liberado (NEXON-20, 6.2).
   */
  private async assertCarregador(eid: string, plantaId: string | null, user: ScopedUser | undefined, p?: { papel: PapelCarregador; morador: any | null }) {
    if (!user) return;
    const perfil = p ?? (await this.papel(user));
    if (perfil.papel === 'morador') {
      const minha = String(perfil.morador?.planta_id ?? '').trim();
      if (!minha || minha !== String(plantaId ?? '').trim()) throw new ForbiddenException('Fora do escopo');
      return;
    }
    await this.scope.assertEntityInScope('equipamento', eid, user);
  }

  /**
   * Valores (R$/kWh, kWh das recargas) por linha (seção 6.4): operador só com "Ver
   * valores em R$" no carregador; morador só das próprias recargas. Os demais veem tudo.
   */
  private async ocultarValores<T extends Record<string, any>>(rows: T[], user: ScopedUser | undefined, p: { papel: PapelCarregador; morador: any | null } | null): Promise<T[]> {
    if (!user || !p || (p.papel !== 'operador' && p.papel !== 'morador')) return rows;
    const veRs = new Map<string, boolean>();
    const out: T[] = [];
    for (const r of rows) {
      const eq = String(r.equipamento_id ?? r.id ?? '').trim();
      let ve = true;
      if (p.papel === 'operador') {
        if (!veRs.has(eq)) veRs.set(eq, await this.scope.podeVerValores(eq, user));
        ve = veRs.get(eq)!;
      } else if ('morador_id' in r) {
        ve = moradorVeValoresDa(p.papel, p.morador?.id, r.morador_id);
      }
      out.push(ve ? r : ({ ...r, tarifa_kwh: null, ...(p.papel === 'morador' && 'kwh_total' in r ? { kwh_total: null } : {}) } as T));
    }
    return out;
  }

  /** Trilha de morador (planta): grava em cada carregador da planta. */
  private async trilhaPlanta(plantaId: string | null, mensagem: string, semantico: string, user?: ScopedUser) {
    if (!plantaId) return;
    const cars = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT TRIM(e.id) AS id FROM equipamentos e JOIN unidades u ON TRIM(u.id)=TRIM(e.unidade_id)
      LEFT JOIN tipos_equipamentos te ON TRIM(te.id)=TRIM(e.tipo_equipamento_id)
      WHERE TRIM(u.planta_id)=${plantaId.trim()} AND e.deleted_at IS NULL
        AND (e.tipo_equipamento ILIKE '%carregador%' OR te.codigo ILIKE '%CARREGADOR%')`.catch(() => []);
    for (const c of cars) await this.trilha(c.id, mensagem, semantico, user);
  }

  // ===== Configuração do carregador (valor do kWh) =====
  async salvarConfig(equipamentoId: string, body: any, user?: ScopedUser, cliente?: ClienteInfo): Promise<any> {
    const eid = equipamentoId.trim();
    await this.assertPlantaNoEscopo(user, (await this.plantaDoCarregador(eid)) || '');
    // Valor do kWh = configuração técnica (PER-33a): Admin e analistas.
    await this.exigirPapel(user, ['analista'], MSG_SOMENTE_LEITURA);
    const tarifa = tarifaValida(body?.tarifa_kwh);
    if (tarifa == null) throw new BadRequestException('Valor do kWh fora da faixa (R$ 0,30 a R$ 5,00).');
    const atual = (await this.prisma.$queryRaw<any[]>`SELECT tarifa_kwh FROM carregador_config WHERE TRIM(equipamento_id)=${eid} LIMIT 1`)[0];
    if (atual) {
      await this.prisma.$executeRaw`UPDATE carregador_config SET tarifa_kwh=${tarifa}, updated_at=now() WHERE TRIM(equipamento_id)=${eid}`;
    } else {
      await this.prisma.$executeRaw`INSERT INTO carregador_config (id, equipamento_id, tarifa_kwh) VALUES (${this.genId()}, ${eid}, ${tarifa})`;
    }
    const antes = atual?.tarifa_kwh != null ? Number(atual.tarifa_kwh).toFixed(2).replace('.', ',') : '—';
    await this.trilha(eid, `Valor do kWh alterado: R$ ${antes} → R$ ${tarifa.toFixed(2).replace('.', ',')} (vale para recargas iniciadas a partir de agora)`, 'carregador.tarifa', user);
    await this.auditar('carregador_config', eid, `Valor do kWh alterado: R$ ${antes} → R$ ${tarifa.toFixed(2).replace('.', ',')}`, user, cliente, 'ok',
      { campo: 'tarifa_kwh', antes: atual?.tarifa_kwh != null ? Number(atual.tarifa_kwh) : null, depois: tarifa });
    return { tarifa_kwh: tarifa };
  }

  private genId(): string { return randomBytes(13).toString('hex'); }

  /**
   * Trilha de comando (logs_mqtt tipo='comando'): quem liberou, parou ou pediu a vaga.
   * Aparece em Registros do carregador e na busca de logs. Nunca lança.
   */
  async trilha(equipamentoId: string, mensagem: string, semantico: string, user?: ScopedUser): Promise<void> {
    try {
      await this.prisma.logs_mqtt.create({
        data: {
          tipo: 'comando',
          equipamento_id: equipamentoId.trim(),
          mensagem: mensagem.slice(0, 500),
          severidade: 'INFO',
          status: 'enviado',
          usuario_id: (user as any)?.id ? String((user as any).id).trim() : null,
          comando_semantico: semantico,
        },
      });
    } catch (e) {
      this.logger.warn(`[carregador] trilha não gravada: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * Plantas visíveis (null = admin). Para escopados, registro SEM planta_id não
   * entra em lista nem export: não dá para provar que é dele.
   */
  private async plantasDoUsuario(user?: ScopedUser): Promise<string[] | null> {
    if (!user) return null;
    const escopo = await this.scope.getScope(user);
    return this.scope.isScoped(escopo) ? escopo : null;
  }
  private async assertPlantaNoEscopo(user: ScopedUser | undefined, plantaId: string) {
    if (!user || !plantaId) return;
    const escopo = await this.scope.getScope(user);
    if (this.scope.isScoped(escopo) && !escopo.includes(plantaId.trim())) {
      throw new ForbiddenException('Fora do escopo');
    }
  }
  private async plantaDoCarregador(id: string): Promise<string | null> {
    const r = await this.prisma.$queryRaw<Array<{ planta_id: string }>>`
      SELECT TRIM(u.planta_id) AS planta_id
      FROM equipamentos e JOIN unidades u ON TRIM(u.id) = TRIM(e.unidade_id)
      WHERE TRIM(e.id) = ${id.trim()} LIMIT 1`;
    return r[0]?.planta_id ?? null;
  }

  // ===== Carregadores (equipamentos do tipo carregador) =====
  async listarCarregadores(user?: ScopedUser): Promise<any[]> {
    const plantas = await this.plantasDoUsuario(user);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT TRIM(e.id) AS id, TRIM(e.nome) AS nome, TRIM(e.unidade_id) AS unidade_id,
             TRIM(u.planta_id) AS planta_id, TRIM(u.nome) AS unidade_nome,
             c.fonte_kwh, c.tarifa_kwh, c.potencia_kw, c.ultimo_estado, c.ultima_leitura_kwh, c.ultima_leitura
      FROM equipamentos e
      JOIN unidades u ON TRIM(u.id) = TRIM(e.unidade_id)
      LEFT JOIN carregador_config c ON TRIM(c.equipamento_id) = TRIM(e.id)
      LEFT JOIN tipos_equipamentos te ON TRIM(te.id) = TRIM(e.tipo_equipamento_id)
      WHERE e.deleted_at IS NULL
        AND (e.tipo_equipamento ILIKE '%carregador%' OR te.codigo ILIKE '%CARREGADOR%' OR te.nome ILIKE '%carregador%')
      ORDER BY e.nome`;
    let vis = plantas ? rows.filter((r) => !!r.planta_id && plantas.includes(String(r.planta_id).trim())) : rows;
    // Operador: só os carregadores liberados a ele.
    const eqs = await this.scope.getEquipamentosScope(user);
    if (eqs) vis = vis.filter((r) => eqs.includes(String(r.id).trim()));
    return this.ocultarValores(vis, user, user ? await this.papel(user) : null);
  }

  // ===== Moradores =====
  async listarMoradores(user?: ScopedUser, plantaId?: string): Promise<any[]> {
    const plantas = await this.plantasDoUsuario(user);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT id, nome, apartamento, tag_uid, planta_id, unidade_id, ativo, email,
             to_char(validade,'YYYY-MM-DD') AS validade, aviso_validade_em,
             (SELECT COUNT(*) FROM carregador_sessoes s WHERE s.morador_id = moradores.id AND s.status='ativa')::int > 0 AS em_recarga,
             to_char(updated_at,'YYYY-MM-DD HH24:MI') AS updated_at
      FROM moradores
      WHERE deleted_at IS NULL AND (${plantaId ?? null}::text IS NULL OR planta_id = ${plantaId ?? null})
      ORDER BY ativo DESC, nome`;
    return plantas ? rows.filter((r) => !!r.planta_id && plantas.includes(String(r.planta_id).trim())) : rows;
  }

  async salvarMorador(body: any, user?: ScopedUser): Promise<any> {
    const nome = String(body.nome || '').trim();
    if (!nome) throw new BadRequestException('Nome do morador obrigatório');
    const plantaId = body.planta_id ? String(body.planta_id).trim() : null;
    await this.assertPlantaNoEscopo(user, plantaId || '');
    await this.exigirPapel(user, PAPEIS_GEREM_MORADOR, 'Só o proprietário ou o analista cadastram moradores.');
    const tag = body.tag_uid ? String(body.tag_uid).trim().toUpperCase() : null;
    const validade = validadeDe(body.validade);
    if (validade === undefined) throw new BadRequestException('Validade inválida (use dd/mm/aaaa).');
    const email = body.email ? String(body.email).trim().toLowerCase() : null;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new BadRequestException('E-mail do morador inválido.');
    const hoje = hojeSP();
    const id = body.id ? String(body.id).trim() : this.genId();
    const antes = body.id
      ? (await this.prisma.$queryRaw<any[]>`SELECT id, ativo, to_char(validade,'YYYY-MM-DD') AS validade FROM moradores WHERE id=${id} AND deleted_at IS NULL LIMIT 1`)[0]
      : undefined;
    const emRecarga = antes ? await this.emRecarga(id) : false;
    // Com recarga em andamento não dá para desativar nem deixar vencer: expira ao fim da recarga.
    if (emRecarga && (body.ativo === false || (validade && validade < hoje))) {
      throw new BadRequestException('Não é possível desativar o morador: há recarga em andamento. O acesso só pode vencer ou ser desativado depois do fim da recarga.');
    }
    if (!antes && validade && validade < hoje) throw new BadRequestException('A validade não pode estar no passado.');
    const ativo = body.ativo !== false && !(validade && validade < hoje);
    if (antes) {
      await this.prisma.$executeRaw`
        UPDATE moradores SET nome=${nome}, apartamento=${body.apartamento ?? null}, tag_uid=${tag}, email=${email},
          validade=${validade}::date, aviso_validade_em = CASE WHEN validade IS DISTINCT FROM ${validade}::date THEN NULL ELSE aviso_validade_em END,
          planta_id=${plantaId}, unidade_id=${body.unidade_id ?? null}, ativo=${ativo}, updated_at=now()
        WHERE id=${id}`;
    } else {
      await this.prisma.$executeRaw`
        INSERT INTO moradores (id, nome, apartamento, tag_uid, planta_id, unidade_id, ativo, email, validade)
        VALUES (${id}, ${nome}, ${body.apartamento ?? null}, ${tag}, ${plantaId}, ${body.unidade_id ?? null}, ${ativo}, ${email}, ${validade}::date)`;
    }
    await this.vincularUsuario(id, email);
    await this.trilhaPlanta(plantaId,
      `${antes ? 'Morador alterado' : 'Morador autorizado'} · ${body.apartamento ? `${body.apartamento} · ` : ''}${nome} · validade ${validade ? dataBR(validade) : 'sem validade'}${ativo ? '' : ' · inativo'}`,
      antes ? 'carregador.morador_alterado' : 'carregador.morador_autorizado', user);
    // Re-sincroniza a whitelist de tags dos carregadores da planta.
    if (plantaId) await this.publicarWhitelistPlanta(plantaId);
    return { id };
  }

  async removerMorador(id: string, user?: ScopedUser): Promise<{ ok: boolean }> {
    const r = await this.prisma.$queryRaw<any[]>`SELECT planta_id, nome, apartamento FROM moradores WHERE id=${id.trim()} AND deleted_at IS NULL LIMIT 1`;
    if (!r.length) return { ok: true };
    await this.assertPlantaNoEscopo(user, r[0].planta_id || '');
    await this.exigirPapel(user, PAPEIS_GEREM_MORADOR, 'Só o proprietário ou o analista removem moradores.');
    // PER-28: com recarga em andamento não remove (o acesso cai ao fim da recarga).
    if (await this.emRecarga(id.trim())) {
      throw new BadRequestException('Não é possível remover o morador: há recarga em andamento. Tente de novo depois do fim da recarga.');
    }
    await this.prisma.$executeRaw`UPDATE moradores SET deleted_at=now(), ativo=false WHERE id=${id.trim()}`;
    await this.trilhaPlanta(r[0].planta_id ? String(r[0].planta_id).trim() : null,
      `Morador removido · ${r[0].apartamento ? `${r[0].apartamento} · ` : ''}${r[0].nome}`, 'carregador.morador_removido', user);
    if (r[0].planta_id) await this.publicarWhitelistPlanta(String(r[0].planta_id).trim());
    return { ok: true };
  }

  private async emRecarga(moradorId: string): Promise<boolean> {
    const r = await this.prisma.$queryRaw<any[]>`SELECT 1 FROM carregador_sessoes WHERE morador_id=${moradorId} AND status='ativa' LIMIT 1`;
    return r.length > 0;
  }

  /** Liga o morador ao usuário do NexON com o mesmo e-mail (perfil Morador). */
  private async vincularUsuario(moradorId: string, email: string | null) {
    await this.prisma.$executeRaw`
      UPDATE moradores SET usuario_id = (SELECT id FROM usuarios WHERE lower(email) = lower(${email}) AND deleted_at IS NULL LIMIT 1)
      WHERE id = ${moradorId}`.catch(() => undefined);
  }

  /**
   * Validade do acesso (de hora em hora):
   *  - vence amanhã (ou hoje) e sem aviso → e-mail ao morador e ao proprietário da planta;
   *  - vencido → desativa e tira a tag da whitelist; com recarga em andamento espera ela acabar.
   * Tudo na trilha dos carregadores da planta.
   */
  @Interval(60 * 60 * 1000)
  async cuidarValidades(): Promise<void> {
    if (process.env.CARREGADOR_VALIDADE === 'off') return;
    const lock = await this.prisma.$queryRaw<Array<{ ok: boolean }>>`SELECT pg_try_advisory_lock(5150002) AS ok`.catch(() => [{ ok: false }]);
    if (!lock[0]?.ok) return;
    try {
      const hoje = hojeSP();
      const rows = await this.prisma.$queryRaw<any[]>`
        SELECT m.id, m.nome, m.apartamento, m.email, TRIM(m.planta_id) AS planta_id, to_char(m.validade,'YYYY-MM-DD') AS validade, m.aviso_validade_em,
               p.nome AS planta_nome, u.email AS dono_email, u.nome AS dono_nome
        FROM moradores m
        LEFT JOIN plantas p ON TRIM(p.id) = TRIM(m.planta_id)
        LEFT JOIN usuarios u ON u.id = p.proprietario_id
        WHERE m.deleted_at IS NULL AND m.ativo AND m.validade IS NOT NULL AND m.validade <= ${somarDias(hoje, 1)}::date`;
      for (const m of rows) {
        const sit = situacaoValidade(m.validade, hoje);
        if (sit === 'vencido') {
          if (await this.emRecarga(m.id)) continue; // expira logo após o fim da recarga
          await this.prisma.$executeRaw`UPDATE moradores SET ativo=false, updated_at=now() WHERE id=${m.id}`;
          if (m.planta_id) await this.publicarWhitelistPlanta(m.planta_id);
          await this.trilhaPlanta(m.planta_id, `Acesso vencido e desativado · ${m.apartamento ? `${m.apartamento} · ` : ''}${m.nome} (validade ${dataBR(m.validade)})`, 'carregador.morador_vencido');
        } else if (sit === 'vence_amanha' && !m.aviso_validade_em) {
          const assunto = `Acesso ao carregador vence em ${dataBR(m.validade)}`;
          const corpo = (quem: string) => `<p>Olá, ${quem}.</p><p>O acesso de <b>${m.nome}</b>${m.apartamento ? ` (${m.apartamento})` : ''} ao carregador de veículo elétrico${m.planta_nome ? ` de <b>${m.planta_nome}</b>` : ''} vale até <b>${dataBR(m.validade)}</b>.</p><p>Para renovar, o proprietário altera a validade no NexON (Carregador › Configuração › Moradores autorizados).</p>`;
          const env: string[] = [];
          if (m.email && (await this.mail.sendAviso(m.email, assunto, corpo(m.nome)))) env.push('morador');
          if (m.dono_email && (await this.mail.sendAviso(m.dono_email, assunto, corpo(m.dono_nome ?? 'proprietário')))) env.push('proprietário');
          await this.prisma.$executeRaw`UPDATE moradores SET aviso_validade_em=now() WHERE id=${m.id}`;
          await this.trilhaPlanta(m.planta_id, `Aviso de vencimento · ${m.nome} · validade ${dataBR(m.validade)} · ${env.length ? `e-mail para ${env.join(' e ')}` : 'sem e-mail enviado (sem endereço ou SMTP)'}`, 'carregador.aviso_validade');
        }
      }
    } catch (e) {
      this.logger.warn(`[carregador] validades: ${e instanceof Error ? e.message : e}`);
    } finally {
      await this.prisma.$queryRaw`SELECT pg_advisory_unlock(5150002)`.catch(() => undefined);
    }
  }

  // ===== Whitelist de tags → TON (modo automático) =====
  private async publicarWhitelistPlanta(plantaId: string): Promise<void> {
    const cars = await this.prisma.$queryRaw<Array<{ topico: string }>>`
      SELECT TRIM(e.topico_mqtt) AS topico
      FROM equipamentos e JOIN unidades u ON TRIM(u.id)=TRIM(e.unidade_id)
      LEFT JOIN tipos_equipamentos te ON TRIM(te.id)=TRIM(e.tipo_equipamento_id)
      WHERE u.planta_id=${plantaId} AND e.mqtt_habilitado=true AND COALESCE(e.topico_mqtt,'')<>''
        AND (e.tipo_equipamento ILIKE '%carregador%' OR te.codigo ILIKE '%CARREGADOR%')`;
    if (!cars.length) return;
    const tags = (await this.prisma.$queryRaw<Array<{ tag_uid: string }>>`
      SELECT DISTINCT tag_uid FROM moradores WHERE ativo=true AND deleted_at IS NULL AND planta_id=${plantaId} AND COALESCE(tag_uid,'')<>''`
    ).map((r) => r.tag_uid);
    for (const c of cars) {
      const base = c.topico?.replace(/\/+$/, '');
      if (!base) continue;
      try { await this.mqtt.publish(`${base}/cmd/tag_sync`, JSON.stringify({ uids: tags }), { retain: true } as any); }
      catch (e) { this.logger.warn(`[carregador] whitelist não enviada: ${e instanceof Error ? e.message : e}`); }
    }
  }

  // ===== Sessão: liberar (porteiro) =====
  async liberarRecarga(
    equipamentoId: string, moradorId: string, user?: ScopedUser,
    opts: { limiteTempoMin?: unknown; limiteEnergiaKwh?: unknown; cliente?: ClienteInfo } = {},
  ): Promise<any> {
    const eid = equipamentoId.trim();
    const plantaId = await this.plantaDoCarregador(eid);
    const p = await this.papel(user);
    await this.assertCarregador(eid, plantaId, user, p);
    const alvo = p.papel === 'morador' ? String(p.morador?.id ?? '') : moradorId.trim();
    const mor = (await this.prisma.$queryRaw<any[]>`
      SELECT id, nome, ativo, tag_uid, to_char(validade,'YYYY-MM-DD') AS validade FROM moradores WHERE id=${alvo} AND deleted_at IS NULL LIMIT 1`)[0];
    if (!mor) throw new NotFoundException('Morador não encontrado');
    if (!mor.ativo || situacaoValidade(mor.validade, hojeSP()) === 'vencido') {
      throw new BadRequestException(`O acesso de ${mor.nome} ao carregador está ${mor.ativo ? `vencido desde ${dataBR(mor.validade)}` : 'desativado'}.`);
    }

    // Já existe sessão ativa? não abre outra.
    const ativa = (await this.prisma.$queryRaw<any[]>`SELECT id FROM carregador_sessoes WHERE TRIM(equipamento_id)=${eid} AND status='ativa' LIMIT 1`)[0];
    if (ativa) throw new BadRequestException('Já existe uma sessão ativa nesta vaga. Encerre a atual (desconecte o carro) antes.');

    const quem = this.quem(user, 'porteiro');
    const est = await this.estacaoOcpp(eid);
    if (est) return this.liberarPorOcpp(est, { eid, plantaId, mor, quem, porMorador: p.papel === 'morador', user, opts });

    const cfg = (await this.prisma.$queryRaw<any[]>`SELECT ultima_leitura_kwh, tarifa_kwh, ultimo_soc FROM carregador_config WHERE TRIM(equipamento_id)=${eid} LIMIT 1`)[0];
    const kwhInicio = cfg?.ultima_leitura_kwh ?? null;
    const id = this.genId();
    // O valor do kWh fica gravado na recarga: mudar a tarifa depois não recalcula recarga fechada.
    await this.prisma.$executeRaw`
      INSERT INTO carregador_sessoes (id, equipamento_id, planta_id, morador_id, morador_nome, inicio, kwh_inicio, liberado_por, liberado_por_user, status, tarifa_kwh, soc_inicio)
      VALUES (${id}, ${eid}, ${plantaId}, ${mor.id}, ${mor.nome}, now(), ${kwhInicio}, ${p.papel === 'morador' ? 'morador' : 'porteiro'}, ${quem}, 'ativa', ${cfg?.tarifa_kwh ?? null}, ${cfg?.ultimo_soc ?? null})`;
    await this.enviarComando(eid, { carregador: 'habilitar', sessao: id, morador: mor.nome });
    await this.trilha(eid, `Recarga iniciada · ${mor.nome} · por ${quem}`, 'carregador.iniciar', user);
    await this.auditar('carregador_comando', eid, `Recarga iniciada · ${mor.nome}`, user, opts.cliente, 'ok', { comando: 'iniciar', via: 'ton', sessao: id, morador: { id: String(mor.id).trim(), nome: mor.nome } });
    return { id, morador: mor.nome };
  }

  /**
   * Iniciar em carregador OCPP: a recarga nasce "aguardando" com a tag (só dela) que o carregador
   * vai devolver, e só então sai o RemoteStartTransaction (ele pode pedir a autorização
   * da tag antes de responder). Recusa ou falha no envio desfaz a recarga.
   */
  private async liberarPorOcpp(
    est: EstacaoCadastro,
    a: { eid: string; plantaId: string | null; mor: any; quem: string; porMorador: boolean; user?: ScopedUser; opts: { limiteTempoMin?: unknown; limiteEnergiaKwh?: unknown; cliente?: ClienteInfo } },
  ): Promise<any> {
    const { eid, mor, quem, user, opts } = a;
    const morador = { id: String(mor.id).trim(), nome: mor.nome };
    const falhar = async (erro: HttpException, extra: Record<string, unknown> = {}): Promise<never> => {
      await this.auditar('carregador_comando', eid, `Recarga não iniciada · ${mor.nome}: ${erro.message}`, user, opts.cliente, 'erro',
        { comando: 'iniciar', via: 'ocpp', charge_point_id: est.chargePointId, morador, ...extra });
      throw erro;
    };
    const tempo = limiteTempoDe(opts.limiteTempoMin);
    if (tempo === undefined) throw new BadRequestException(`Limite de tempo inválido (${LIMITE_TEMPO_MIN} a ${LIMITE_TEMPO_MAX} min).`);
    const energia = limiteEnergiaDe(opts.limiteEnergiaKwh);
    if (energia === undefined) throw new BadRequestException(`Limite de energia inválido (${LIMITE_ENERGIA_MIN} a ${LIMITE_ENERGIA_MAX} kWh).`);
    if (!this.ocpp!.conectado(est)) await falhar(erroDoCarregador(new ErroOcpp('offline', '')));
    if (!est.disponivel) await falhar(new BadRequestException('Carregador bloqueado. Libere o carregador antes de iniciar.'));
    const falha = descreverFalha(est);
    if (est.status === 'Faulted') await falhar(new BadRequestException(`Carregador em falha${falha ? `: ${falha.titulo}` : ''}.`), { falha });

    const cfg = await this.repoOcpp!.config(eid);
    const limiteTempoMin = limiteDaRecarga(tempo, cfg.limiteTempoMin);
    const limiteEnergiaKwh = limiteDaRecarga(energia, cfg.limiteEnergiaKwh);
    // Tag descartável, nunca o cartão do morador: recarga cancelada não deixa uma autorização
    // válida no carregador. O cartão dele ainda para a recarga (mesmo grupo, ver `autorizar`).
    const idTag = gerarIdTag();
    const id = await this.repoOcpp!.criarSessao({
      equipamentoId: eid, plantaId: a.plantaId, moradorId: morador.id, moradorNome: mor.nome, inicio: new Date(), kwhInicio: null,
      liberadoPor: a.porMorador ? 'morador' : 'porteiro', liberadoPorUser: quem, tarifaKwh: cfg.tarifaKwh, socInicio: null,
      transactionId: null, idTag, limiteTempoMin, limiteEnergiaKwh,
    });
    const limites = { tempo_min: limiteTempoMin, energia_kwh: limiteEnergiaKwh };
    let r: { resposta: string; ms: number };
    try {
      r = await this.ocpp!.iniciarRemoto(est, idTag);
    } catch (e) {
      await this.repoOcpp!.cancelar(id);
      return falhar(erroDoCarregador(e), { comando_ocpp: 'RemoteStartTransaction', limites });
    }
    if (r.resposta !== 'Accepted') {
      await this.repoOcpp!.cancelar(id);
      return falhar(
        new ConflictException(`O carregador recusou o início (resposta: ${r.resposta || 'vazia'}). Confira se o carro está conectado e se não há outra recarga em andamento.`),
        { comando_ocpp: 'RemoteStartTransaction', resposta: r.resposta, latencia_ms: r.ms, limites },
      );
    }
    const textoLimite = [limiteTempoMin ? `${limiteTempoMin} min` : null, limiteEnergiaKwh ? `${String(limiteEnergiaKwh).replace('.', ',')} kWh` : null].filter(Boolean).join(' · ');
    await this.trilha(eid, `Recarga liberada · ${mor.nome} · por ${quem}${textoLimite ? ` · limite ${textoLimite}` : ''}`, 'carregador.iniciar', user);
    await this.auditar('carregador_comando', eid, `Recarga iniciada · ${mor.nome}`, user, opts.cliente, 'ok',
      { comando: 'iniciar', via: 'ocpp', charge_point_id: est.chargePointId, comando_ocpp: 'RemoteStartTransaction', resposta: r.resposta, latencia_ms: r.ms, sessao: id, morador, limites });
    return { id, morador: mor.nome, aguardando_inicio: true };
  }

  /** Audit log (auditoria_acessos) com carregador, instalação e planta. Nunca lança. */
  private async auditar(
    acao: 'carregador_comando' | 'carregador_config' | 'carregador_ocpp', eid: string, mensagem: string,
    user: ScopedUser | undefined, cliente: ClienteInfo | undefined, resultado: 'ok' | 'erro', extra: Record<string, unknown>,
  ): Promise<void> {
    if (!this.auditoria || !this.repoOcpp) return;
    const contexto = await this.repoOcpp.contexto(eid).catch(() => null);
    await this.auditoria.registrar(acao, { mensagem, user: user as any, cliente, contexto, resultado, extra });
  }

  // ===== Pedir a vaga (marca início do ocioso da sessão que ocupa) =====
  async pedirVaga(equipamentoId: string, moradorId: string, user?: ScopedUser): Promise<any> {
    const eid = equipamentoId.trim();
    const plantaId = await this.plantaDoCarregador(eid);
    await this.assertCarregador(eid, plantaId, user);
    const mor = (await this.prisma.$queryRaw<any[]>`SELECT id, nome FROM moradores WHERE id=${moradorId.trim()} AND deleted_at IS NULL LIMIT 1`)[0];
    if (!mor) throw new NotFoundException('Morador (solicitante) não encontrado');
    const ativa = (await this.prisma.$queryRaw<any[]>`SELECT id, ocioso_inicio FROM carregador_sessoes WHERE TRIM(equipamento_id)=${eid} AND status='ativa' LIMIT 1`)[0];
    // Registra o pedido sempre (log).
    await this.prisma.$executeRaw`
      INSERT INTO carregador_pedidos_vaga (id, equipamento_id, sessao_id, morador_id, morador_nome)
      VALUES (${this.genId()}, ${eid}, ${ativa?.id ?? null}, ${mor.id}, ${mor.nome})`;
    // Só marca o início do ocioso se há sessão ocupando E ainda não foi marcado.
    if (ativa && !ativa.ocioso_inicio) {
      await this.prisma.$executeRaw`
        UPDATE carregador_sessoes SET ocioso_inicio=now(), ocioso_por_morador_id=${mor.id}, ocioso_por_nome=${mor.nome}, updated_at=now()
        WHERE id=${ativa.id}`;
    }
    await this.trilha(eid, `Vaga pedida · ${mor.nome}`, 'carregador.pedir_vaga', user);
    return { ok: true, ocioso_iniciado: !!(ativa && !ativa.ocioso_inicio) };
  }

  // ===== Parar recarga pela tela (corta o contator e fecha a sessão) =====
  async pararRecarga(equipamentoId: string, user?: ScopedUser, cliente?: ClienteInfo): Promise<any> {
    const eid = equipamentoId.trim();
    const plantaId = await this.plantaDoCarregador(eid);
    const p = await this.papel(user);
    await this.assertCarregador(eid, plantaId, user, p);
    const ativa = (await this.prisma.$queryRaw<any[]>`
      SELECT id, morador_nome FROM carregador_sessoes WHERE TRIM(equipamento_id)=${eid} AND status='ativa' ORDER BY inicio DESC LIMIT 1`)[0];
    if (!ativa) throw new BadRequestException('Não há recarga em andamento neste carregador.');
    // PER-32: morador só para a própria; proprietário, analistas e operador param qualquer uma.
    if (user && p.papel === 'morador') {
      const dono = (await this.prisma.$queryRaw<any[]>`SELECT morador_id FROM carregador_sessoes WHERE id=${ativa.id}`)[0];
      if (String(dono?.morador_id ?? '').trim() !== String(p.morador?.id ?? '').trim()) throw new ForbiddenException('Só quem está carregando pode parar a recarga.');
    }
    const quem = this.quem(user, 'usuário');
    const est = await this.estacaoOcpp(eid);
    if (est) return this.pararPorOcpp(est, eid, ativa, quem, user, cliente);
    const cfg = (await this.prisma.$queryRaw<any[]>`SELECT ultima_leitura_kwh FROM carregador_config WHERE TRIM(equipamento_id)=${eid} LIMIT 1`)[0];
    const r = await this.encerrarSessao(eid, cfg?.ultima_leitura_kwh ?? null, 'parado_no_nexon');
    await this.trilha(eid, `Recarga parada · ${ativa.morador_nome ?? '—'} · por ${quem}`, 'carregador.parar', user);
    await this.auditar('carregador_comando', eid, `Recarga parada · ${ativa.morador_nome ?? '—'}`, user, cliente, 'ok', { comando: 'parar', via: 'ton', sessao: String(ativa.id).trim() });
    return r;
  }

  /**
   * Parar em carregador OCPP: manda RemoteStopTransaction e a recarga fecha quando o
   * carregador confirma, com a leitura final dele. Recarga que ainda aguardava o início
   * é só cancelada.
   */
  private async pararPorOcpp(est: EstacaoCadastro, eid: string, ativa: any, quem: string, user?: ScopedUser, cliente?: ClienteInfo): Promise<any> {
    const s = await this.repoOcpp!.sessaoAtiva(eid);
    const nome = ativa.morador_nome ?? '—';
    const base = { comando: 'parar', via: 'ocpp', charge_point_id: est.chargePointId, sessao: String(ativa.id).trim() };
    if (!s || s.transactionId === null) {
      if (s) await this.repoOcpp!.cancelar(s.id);
      await this.trilha(eid, `Recarga cancelada antes de começar · ${nome} · por ${quem}`, 'carregador.parar', user);
      await this.auditar('carregador_comando', eid, `Recarga cancelada antes de começar · ${nome}`, user, cliente, 'ok', base);
      return { ok: true, sessao: String(ativa.id).trim(), cancelada: true };
    }
    const extra = { ...base, comando_ocpp: 'RemoteStopTransaction', transaction_id: s.transactionId };
    let r: { resposta: string; ms: number };
    try {
      r = await this.ocpp!.pararRemoto(est, s.transactionId);
    } catch (e) {
      const erro = erroDoCarregador(e);
      await this.auditar('carregador_comando', eid, `Recarga não parada · ${nome}: ${erro.message}`, user, cliente, 'erro', extra);
      throw erro;
    }
    if (r.resposta !== 'Accepted') {
      const erro = new ConflictException(`O carregador recusou a parada (resposta: ${r.resposta || 'vazia'}).`);
      await this.auditar('carregador_comando', eid, `Recarga não parada · ${nome}: ${erro.message}`, user, cliente, 'erro', { ...extra, resposta: r.resposta, latencia_ms: r.ms });
      throw erro;
    }
    await this.repoOcpp!.pedirParada(s.id, 'parado_no_nexon');
    await this.trilha(eid, `Recarga parada · ${nome} · por ${quem}`, 'carregador.parar', user);
    await this.auditar('carregador_comando', eid, `Recarga parada · ${nome}`, user, cliente, 'ok', { ...extra, resposta: r.resposta, latencia_ms: r.ms });
    return { ok: true, sessao: s.id, aguardando_carregador: true };
  }

  // ===== Encerrar sessão (chamado pela ingestão MQTT ao desconectar) =====
  async encerrarSessao(equipamentoId: string, kwhFinal?: number | null, motivo = 'desconectado'): Promise<any> {
    const eid = equipamentoId.trim();
    const ativa = (await this.prisma.$queryRaw<any[]>`
      SELECT id, kwh_inicio, ocioso_inicio FROM carregador_sessoes WHERE TRIM(equipamento_id)=${eid} AND status='ativa' ORDER BY inicio DESC LIMIT 1`)[0];
    if (!ativa) return { ok: false, motivo: 'sem sessão ativa' };
    const kwhFim = (kwhFinal ?? null);
    // kwh_total = fim − inicio (se ambos existem). ocioso_min = fim(agora) − ocioso_inicio.
    await this.prisma.$executeRaw`
      UPDATE carregador_sessoes
      SET fim=now(), kwh_fim=${kwhFim},
          kwh_total = CASE WHEN ${kwhFim}::numeric IS NOT NULL AND kwh_inicio IS NOT NULL THEN GREATEST(${kwhFim}::numeric - kwh_inicio, 0) ELSE kwh_total END,
          ocioso_min = CASE WHEN ocioso_inicio IS NOT NULL THEN GREATEST(EXTRACT(EPOCH FROM (now() - ocioso_inicio))/60, 0)::int ELSE 0 END,
          motivo_fim=${motivo.slice(0, 24)}, status='encerrada', updated_at=now()
      WHERE id=${ativa.id}`;
    // Corta o fornecimento (garantia — a TON já cortou no hardware).
    await this.enviarComando(eid, { carregador: 'desabilitar', motivo });
    // Acesso vencido durante a recarga: expira agora.
    void this.cuidarValidades();
    return { ok: true, sessao: ativa.id };
  }

  // ===== Ingestão de energia (kWh acumulado) — chamado pelo MqttService =====
  async ingerirEnergia(equipamentoId: string, kwhAcumulado: number, estado?: string): Promise<void> {
    const eid = equipamentoId.trim();
    const existe = (await this.prisma.$queryRaw<any[]>`SELECT 1 FROM carregador_config WHERE TRIM(equipamento_id)=${eid} LIMIT 1`).length > 0;
    if (existe) {
      await this.prisma.$executeRaw`
        UPDATE carregador_config SET ultima_leitura_kwh=${kwhAcumulado}, ultimo_estado=${estado ?? null}, ultima_leitura=now(), updated_at=now()
        WHERE TRIM(equipamento_id)=${eid}`;
    } else {
      await this.prisma.$executeRaw`
        INSERT INTO carregador_config (id, equipamento_id, ultima_leitura_kwh, ultimo_estado, ultima_leitura)
        VALUES (${this.genId()}, ${eid}, ${kwhAcumulado}, ${estado ?? null}, now())`;
    }
    // Atualiza o kWh corrente da sessão ativa (fim provisório).
    await this.prisma.$executeRaw`
      UPDATE carregador_sessoes
      SET kwh_fim=${kwhAcumulado},
          kwh_total = CASE WHEN kwh_inicio IS NOT NULL THEN GREATEST(${kwhAcumulado}::numeric - kwh_inicio, 0) ELSE kwh_total END,
          updated_at=now()
      WHERE TRIM(equipamento_id)=${eid} AND status='ativa'`;
  }

  // ===== Sessões (lista: ativas + histórico) =====
  async listarSessoes(user?: ScopedUser, equipamentoId?: string, limite = 100): Promise<any[]> {
    const p = user ? await this.papel(user) : null;
    // Morador: as próprias recargas (filtro abaixo), sem depender do escopo do NexON.
    const plantas = p?.papel === 'morador' ? null : await this.plantasDoUsuario(user);
    const eqs = p?.papel === 'morador' ? null : await this.scope.getEquipamentosScope(user);
    const so = p?.papel === 'morador' ? String(p.morador?.id ?? '-') : null;
    // Escopo (planta e, para operador, carregador liberado) vai no SQL, antes do
    // LIMIT: filtrar depois devolvia a lista curta ou vazia.
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT s.id, TRIM(s.equipamento_id) AS equipamento_id, s.morador_nome, s.status, TRIM(s.morador_id) AS morador_id,
             s.kwh_total, s.ocioso_min, s.liberado_por, s.liberado_por_user, s.ocioso_por_nome, s.planta_id,
             COALESCE(s.tarifa_kwh, c.tarifa_kwh) AS tarifa_kwh,
             to_char((s.inicio AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') AS inicio,
             to_char((s.fim AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') AS fim,
             to_char(s.inicio,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS inicio_iso, to_char(s.fim,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS fim_iso,
             GREATEST(EXTRACT(EPOCH FROM (COALESCE(s.fim, now()::timestamp) - s.inicio))/60, 0)::int AS duracao_min,
             s.motivo_fim
      FROM carregador_sessoes s
      LEFT JOIN carregador_config c ON TRIM(c.equipamento_id)=TRIM(s.equipamento_id)
      WHERE (${equipamentoId ?? null}::text IS NULL OR TRIM(s.equipamento_id) = ${equipamentoId ?? null})
        AND (${so}::text IS NULL OR TRIM(s.morador_id) = ${so})
        AND (${plantas === null}::boolean OR TRIM(s.planta_id) = ANY(${plantas ?? []}::text[]))
        AND (${eqs === null}::boolean OR TRIM(s.equipamento_id) = ANY(${eqs ?? []}::text[]))
      ORDER BY (s.status='ativa') DESC, s.inicio DESC
      LIMIT ${Math.min(Number(limite) || 100, 500)}`;
    const comOrigem = rows.map((r) => ({ ...r, motivo_fim_texto: textoMotivoFim(r.motivo_fim), origem: origemDaRecarga(r.liberado_por) }));
    return this.ocultarValores(comOrigem, user, p);
  }

  async getEstado(equipamentoId: string, user?: ScopedUser): Promise<any> {
    const eid = equipamentoId.trim();
    const plantaId = await this.plantaDoCarregador(eid);
    const p = user ? await this.papel(user) : { papel: 'analista' as PapelCarregador, morador: null };
    await this.assertCarregador(eid, plantaId, user, p);
    const cfg = (await this.prisma.$queryRaw<any[]>`SELECT * FROM carregador_config WHERE TRIM(equipamento_id)=${eid} LIMIT 1`)[0] ?? null;
    const ativa = (await this.prisma.$queryRaw<any[]>`
      SELECT id, morador_nome, TRIM(morador_id) AS morador_id, kwh_total, tarifa_kwh, soc_inicio,
             to_char((inicio AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') AS inicio,
             to_char(inicio,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS inicio_iso, ocioso_inicio, ocioso_por_nome,
             GREATEST(EXTRACT(EPOCH FROM (now()::timestamp - inicio))/60, 0)::int AS duracao_min,
             limite_tempo_min, limite_energia_kwh, liberado_por, ocpp_transaction_id
      FROM carregador_sessoes WHERE TRIM(equipamento_id)=${eid} AND status='ativa' ORDER BY inicio DESC LIMIT 1`)[0] ?? null;
    const ultimas = await this.listarSessoes(user, eid, 8);
    // Valores: operador sem "Ver R$" não vê R$/kWh; morador não vê os da recarga de outro.
    const veTarifa = p.papel !== 'operador' || !user || (await this.scope.podeVerValores(eid, user));
    const est = await this.estacaoOcpp(eid);
    const conectado = est ? this.ocpp!.conectado(est) : false;
    const ativaTela = ativa
      ? (({ liberado_por, ocpp_transaction_id, limite_tempo_min, limite_energia_kwh, ...resto }) => ({
          ...resto,
          aguardando_inicio: !!est && ocpp_transaction_id == null,
          origem: origemDaRecarga(liberado_por),
          limite_tempo_min: limite_tempo_min == null ? null : Number(limite_tempo_min),
          limite_energia_kwh: limite_energia_kwh == null ? null : Number(limite_energia_kwh),
        }))(ativa)
      : null;
    const [ativaVis] = ativaTela ? await this.ocultarValores([{ ...ativaTela, equipamento_id: eid }], user, p) : [null];
    const falha = est ? descreverFalha(est) : null;
    const ultimaComunicacao = est
      ? [est.ultimaConexao, est.ultimoHeartbeat, est.statusEm, est.leituraEm].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null
      : null;
    const ocpp = est
      ? {
          ocpp: { conectado, ultima_comunicacao: iso(ultimaComunicacao), disponivel: est.disponivel, fabricante: est.vendor, modelo: est.model },
          leitura: est.leitura ?? null,
          falha: falha ? { codigo: falha.codigo, ocpp: falha.ocpp, titulo: falha.titulo, solucao: falha.solucao, desde: iso(est.falhaDesde) } : null,
          limites: limitesParaTela(await this.repoOcpp!.config(eid)),
        }
      : { ocpp: null, leitura: null, falha: null, limites: null };
    return {
      ...ocpp,
      pode: podeNoCarregador(p.papel),
      papel: p.papel,
      meu_morador: p.morador ? { id: String(p.morador.id).trim(), nome: p.morador.nome, apartamento: p.morador.apartamento, validade: p.morador.validade, ativo: p.morador.ativo } : null,
      soc: cfg?.ultimo_soc != null && cfg?.ultimo_soc_em && Date.now() - new Date(cfg.ultimo_soc_em).getTime() < 30 * 60000 ? Number(cfg.ultimo_soc) : null,
      capacidade_bateria_kwh: cfg?.capacidade_bateria_kwh ?? null,
      potencia_kw: cfg?.potencia_kw ?? null,
      // OCPP: o estado é o do carregador agora; sem conexão, o último estado não vale mais.
      estado: est ? (conectado ? estadoDoStatus(est.status) : 'sem_comunicacao') : cfg?.ultimo_estado ?? 'desconhecido',
      fonte_kwh: est ? 'ocpp' : cfg?.fonte_kwh ?? 'ton',
      tarifa_kwh: veTarifa ? cfg?.tarifa_kwh ?? null : null,
      ultima_leitura_kwh: cfg?.ultima_leitura_kwh ?? null,
      ultima_leitura: cfg?.ultima_leitura ?? null,
      sessao_ativa: ativaVis ? (({ equipamento_id: _e, ...resto }) => resto)(ativaVis) : null,
      sessoes: ultimas,
    };
  }

  // ===== Export mensal (morador · kWh · ocioso · R$) =====
  async exportarMensal(mesAno: string, user?: ScopedUser, plantaId?: string): Promise<{ csv: string; linhas: any[]; detalhe: any[] }> {
    // PER-38: exportar recargas só proprietário, analistas e Admin (operador e morador não).
    await this.exigirPapel(user, PAPEIS_EXPORTAM, 'Exportação só para o proprietário ou o analista.');
    const m = /^\d{4}-\d{2}$/.test(mesAno) ? mesAno : null;
    if (!m) throw new BadRequestException("Mês inválido (use 'YYYY-MM')");
    await this.assertPlantaNoEscopo(user, plantaId || '');
    const plantas = await this.plantasDoUsuario(user);
    const inicioMes = `${m}-01`;
    // Recarga entra no mês em que COMEÇOU; a em andamento fica para depois de encerrada.
    // Valor = kWh × R$/kWh gravado na recarga (fallback: o do carregador).
    const det = await this.prisma.$queryRaw<any[]>`
      SELECT COALESCE(m.apartamento, '') AS apartamento, s.morador_nome AS morador, TRIM(e.nome) AS vaga,
             to_char((s.inicio AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY HH24:MI') AS inicio,
             to_char((s.fim AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY HH24:MI') AS fim,
             GREATEST(EXTRACT(EPOCH FROM (s.fim - s.inicio))/60, 0)::int AS duracao_min,
             ROUND(COALESCE(s.kwh_total,0)::numeric, 3) AS kwh, COALESCE(s.ocioso_min,0)::int AS ocioso_min,
             COALESCE(s.tarifa_kwh, c.tarifa_kwh) AS tarifa_kwh,
             ROUND((COALESCE(s.kwh_total,0) * COALESCE(s.tarifa_kwh, c.tarifa_kwh, 0))::numeric, 2) AS valor_reais,
             TRIM(s.planta_id) AS planta_id
      FROM carregador_sessoes s
      LEFT JOIN carregador_config c ON TRIM(c.equipamento_id)=TRIM(s.equipamento_id)
      LEFT JOIN moradores m ON m.id = s.morador_id
      LEFT JOIN equipamentos e ON TRIM(e.id) = TRIM(s.equipamento_id)
      WHERE s.status='encerrada'
        AND ((s.inicio AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo') >= ${inicioMes}::date
        AND ((s.inicio AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo') < (${inicioMes}::date + interval '1 month')
        AND (${plantaId ?? null}::text IS NULL OR s.planta_id = ${plantaId ?? null})
      ORDER BY m.apartamento NULLS LAST, s.morador_nome, s.inicio`;
    const detalhe = plantas ? det.filter((r) => !!r.planta_id && plantas.includes(String(r.planta_id).trim())) : det;
    const grupos = new Map<string, any>();
    for (const r of detalhe) {
      const k = `${r.apartamento}|${r.morador ?? ''}`;
      const g = grupos.get(k) ?? { apartamento: r.apartamento || null, morador: r.morador, recargas: 0, kwh: 0, ocioso_min: 0, valor_reais: 0, planta_id: r.planta_id };
      g.recargas += 1; g.kwh += Number(r.kwh); g.ocioso_min += Number(r.ocioso_min); g.valor_reais += Number(r.valor_reais);
      grupos.set(k, g);
    }
    const linhas = [...grupos.values()].map((g) => ({ ...g, kwh: Math.round(g.kwh * 1000) / 1000, valor_reais: Math.round(g.valor_reais * 100) / 100 }));
    const br = (v: unknown) => String(v ?? '').replace('.', ',');
    const header = 'Apartamento;Morador;Recargas;kWh;Ocioso (min);Valor (R$)';
    const body = linhas.map((r) => `${r.apartamento ?? ''};${r.morador ?? '—'};${r.recargas};${br(r.kwh)};${r.ocioso_min};${br(r.valor_reais)}`).join('\n');
    return { csv: `${header}\n${body}\n`, linhas, detalhe };
  }

  // ===== Comando MQTT ao carregador (habilitar/desabilitar) =====
  private async enviarComando(equipamentoId: string, payload: Record<string, unknown>): Promise<void> {
    const eq = (await this.prisma.$queryRaw<Array<{ topico: string }>>`
      SELECT TRIM(topico_mqtt) AS topico FROM equipamentos WHERE TRIM(id)=${equipamentoId.trim()} AND mqtt_habilitado=true LIMIT 1`)[0];
    const base = eq?.topico?.replace(/\/+$/, '');
    if (!base) { this.logger.warn(`[carregador] ${equipamentoId} sem topico_mqtt — comando não enviado`); return; }
    try { await this.mqtt.publish(`${base}/cmd`, JSON.stringify(payload)); }
    catch (e) { this.logger.error(`[carregador] falha no comando: ${e instanceof Error ? e.message : e}`); }
  }

  /** Resolve o equipamento (carregador) por tópico base — usado pela ingestão MQTT. */
  async carregadorPorTopico(base: string): Promise<string | null> {
    const b = base.replace(/\/+$/, '');
    const r = (await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT TRIM(id) AS id FROM equipamentos WHERE TRIM(topico_mqtt)=${b} AND deleted_at IS NULL LIMIT 1`)[0];
    return r?.id ?? null;
  }
}
