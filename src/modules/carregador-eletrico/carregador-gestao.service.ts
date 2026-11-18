import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import type { ScopedUser } from '@/core';
import type { ClienteInfo } from '@/core/common/cliente-info';
import { MSG_SOMENTE_LEITURA } from '../../core/modules/auth/papeis';
import { baseOcpp, gerarChave, hashChave, identidadeValida, urlsDeConexao } from '../ocpp/ocpp-conexao';
import { AcaoCarregador, CarregadorAuditoriaService } from './carregador-auditoria.service';
import { CarregadorEletricoService, erroDoCarregador, limitesParaTela } from './carregador-eletrico.service';
import {
  correnteDe,
  LIMITE_ENERGIA_MAX,
  LIMITE_ENERGIA_MIN,
  LIMITE_TEMPO_MAX,
  LIMITE_TEMPO_MIN,
  limiteEnergiaDe,
  limiteTempoDe,
  parametroSecreto,
  PodeNoCarregador,
  podeNoCarregador,
  semSegredo,
} from './carregador-ocpp.regras';
import { CarregadorOcppRepositorio, ContextoCarregador, EstacaoCadastro } from './carregador-ocpp.repositorio';
import { CarregadorOcppService, RespostaComando } from './carregador-ocpp.service';

export type ComandoCarregador = 'bloquear' | 'liberar' | 'destravar' | 'reiniciar' | 'atualizar';

interface Alvo { ctx: ContextoCarregador; est: EstacaoCadastro | null }

const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z') : null);
const texto = (v: number | null, sufixo: string) => (v === null ? 'sem limite' : `${String(v).replace('.', ',')} ${sufixo}`);

/** O que cada comando manda ao carregador, quem pode e o que a tela ouve de volta. */
const COMANDOS: Record<ComandoCarregador, { capacidade: keyof PodeNoCarregador; ocpp: string; titulo: string; aceitas: string[]; mensagem: (r: string) => string }> = {
  bloquear: {
    capacidade: 'bloquear', ocpp: 'ChangeAvailability Inoperative', titulo: 'Carregador bloqueado', aceitas: ['Accepted', 'Scheduled'],
    mensagem: (r) => (r === 'Scheduled' ? 'Carregador será bloqueado ao fim da recarga em andamento.' : 'Carregador bloqueado.'),
  },
  liberar: {
    capacidade: 'bloquear', ocpp: 'ChangeAvailability Operative', titulo: 'Carregador liberado', aceitas: ['Accepted', 'Scheduled'],
    mensagem: () => 'Carregador liberado.',
  },
  destravar: {
    capacidade: 'bloquear', ocpp: 'UnlockConnector', titulo: 'Conector destravado', aceitas: ['Unlocked'],
    mensagem: () => 'Conector destravado.',
  },
  atualizar: {
    capacidade: 'bloquear', ocpp: 'TriggerMessage', titulo: 'Leitura pedida ao carregador', aceitas: ['Accepted'],
    mensagem: () => 'Leitura pedida ao carregador.',
  },
  reiniciar: {
    capacidade: 'tecnico', ocpp: 'Reset Soft', titulo: 'Carregador reiniciado', aceitas: ['Accepted'],
    mensagem: () => 'Carregador reiniciando. A conexão volta em instantes.',
  },
};

const RECUSA: Record<string, string> = {
  Rejected: 'o carregador recusou',
  NotSupported: 'este carregador não tem essa função',
  NotImplemented: 'este carregador não tem essa função',
  UnlockFailed: 'o carregador não conseguiu destravar',
};

/**
 * Gestão do carregador OCPP para quem usa: limites de uso, corrente máxima, comandos,
 * conexão (vínculo e chave) e parâmetros do equipamento. Toda rota confere escopo e papel
 * (ADR 0002), manda o comando pela ponte e grava a trilha do carregador e o audit log,
 * inclusive quando o carregador recusa ou não responde. O 403 é gravado pelo interceptor global.
 */
@Injectable()
export class CarregadorGestaoService {
  constructor(
    private readonly carregador: CarregadorEletricoService,
    private readonly ocpp: CarregadorOcppService,
    private readonly repo: CarregadorOcppRepositorio,
    private readonly auditoria: CarregadorAuditoriaService,
  ) {}

  private async alvo(equipamentoId: string, user: ScopedUser | undefined, capacidade: keyof PodeNoCarregador): Promise<Alvo & { eid: string; plantaId: string | null }> {
    const eid = equipamentoId.trim();
    const { papel, plantaId } = await this.carregador.acesso(eid, user);
    if (user && !podeNoCarregador(papel)[capacidade]) throw new ForbiddenException(MSG_SOMENTE_LEITURA);
    const ctx = await this.repo.contexto(eid);
    if (!ctx) throw new NotFoundException('Carregador não encontrado');
    return { eid, plantaId, ctx, est: await this.repo.estacaoDoEquipamento(eid) };
  }

  private exigirOcpp(est: EstacaoCadastro | null): EstacaoCadastro {
    if (!est) throw new BadRequestException('Este carregador não está conectado por OCPP.');
    return est;
  }

  private registrar(acao: AcaoCarregador, a: Alvo, mensagem: string, user: ScopedUser | undefined, cliente: ClienteInfo | undefined, resultado: 'ok' | 'erro', extra: Record<string, unknown>) {
    return this.auditoria.registrar(acao, {
      mensagem, user: user as any, cliente, contexto: a.ctx, resultado,
      extra: { charge_point_id: a.est?.chargePointId ?? null, ...extra },
    });
  }

  // ===== limites de uso e corrente máxima ======================================
  /**
   * `PUT /:id/config` (parte dos limites). Tempo, energia e início automático: proprietário
   * e analistas. Corrente máxima: só analistas, e vale quando o carregador aceita o perfil.
   */
  async salvarLimites(equipamentoId: string, body: any, user?: ScopedUser, cliente?: ClienteInfo): Promise<{ limites: ReturnType<typeof limitesParaTela> }> {
    const b = body ?? {};
    const mexeUso = ['limite_tempo_min', 'limite_energia_kwh', 'inicio_automatico'].some((k) => b[k] !== undefined);
    const mexeCorrente = b.limite_corrente_a !== undefined;
    const a = await this.alvo(equipamentoId, user, mexeCorrente ? 'tecnico' : 'limites');
    const est = this.exigirOcpp(a.est);
    const antes = await this.repo.config(a.eid);

    if (mexeUso) {
      const tempo = b.limite_tempo_min === undefined ? antes.limiteTempoMin : limiteTempoDe(b.limite_tempo_min);
      if (tempo === undefined) throw new BadRequestException(`Limite de tempo inválido (${LIMITE_TEMPO_MIN} a ${LIMITE_TEMPO_MAX} min, ou vazio para tirar).`);
      const energia = b.limite_energia_kwh === undefined ? antes.limiteEnergiaKwh : limiteEnergiaDe(b.limite_energia_kwh);
      if (energia === undefined) throw new BadRequestException(`Limite de energia inválido (${LIMITE_ENERGIA_MIN} a ${LIMITE_ENERGIA_MAX} kWh, ou vazio para tirar).`);
      const auto = b.inicio_automatico === undefined ? antes.inicioAutomatico : b.inicio_automatico === true;
      await this.repo.salvarLimitesDeUso(a.eid, { limiteTempoMin: tempo, limiteEnergiaKwh: energia, inicioAutomatico: auto });
      const mudou = [
        tempo !== antes.limiteTempoMin ? `tempo ${texto(antes.limiteTempoMin, 'min')} → ${texto(tempo, 'min')}` : null,
        energia !== antes.limiteEnergiaKwh ? `energia ${texto(antes.limiteEnergiaKwh, 'kWh')} → ${texto(energia, 'kWh')}` : null,
        auto !== antes.inicioAutomatico ? `início automático ${antes.inicioAutomatico ? 'ligado' : 'desligado'} → ${auto ? 'ligado' : 'desligado'}` : null,
      ].filter(Boolean);
      if (mudou.length) {
        const msg = `Limites de uso alterados: ${mudou.join(' · ')}`;
        await this.carregador.trilha(a.eid, `${msg} (vale para recargas iniciadas a partir de agora)`, 'carregador.limites', user);
        await this.registrar('carregador_config', a, msg, user, cliente, 'ok', {
          antes: { limite_tempo_min: antes.limiteTempoMin, limite_energia_kwh: antes.limiteEnergiaKwh, inicio_automatico: antes.inicioAutomatico },
          depois: { limite_tempo_min: tempo, limite_energia_kwh: energia, inicio_automatico: auto },
        });
      }
    }

    if (mexeCorrente) {
      const corrente = correnteDe(b.limite_corrente_a, antes.correnteMaxA);
      if (corrente === undefined) throw new BadRequestException(`Corrente inválida (6 a ${antes.correnteMaxA} A, número inteiro, ou vazio para tirar).`);
      const descr = `Corrente máxima ${texto(antes.limiteCorrenteA, 'A')} → ${texto(corrente, 'A')}`;
      const extra = { campo: 'limite_corrente_a', antes: antes.limiteCorrenteA, depois: corrente };
      let r: Awaited<ReturnType<CarregadorOcppService['aplicarCorrente']>>;
      try {
        r = await this.ocpp.aplicarCorrente(est, corrente);
      } catch (e) {
        const erro = erroDoCarregador(e);
        await this.registrar('carregador_config', a, `${descr} não aplicada: ${erro.message}`, user, cliente, 'erro', extra);
        throw erro;
      }
      if (!r.aceito) {
        await this.repo.marcarCorrenteNaoSuportada(a.eid);
        const resposta = r.tentativas.map((x) => x.resposta).join(', ');
        await this.carregador.trilha(a.eid, `${descr} recusada pelo carregador (${resposta})`, 'carregador.corrente', user);
        await this.registrar('carregador_config', a, `${descr} recusada pelo carregador`, user, cliente, 'erro', { ...extra, tentativas: r.tentativas, latencia_ms: r.ms });
        throw new ConflictException(`O carregador recusou o limite de corrente (resposta: ${resposta}).`);
      }
      await this.repo.salvarCorrente(a.eid, corrente, corrente === null ? antes.correnteSuportada : true);
      await this.carregador.trilha(a.eid, descr, 'carregador.corrente', user);
      await this.registrar('carregador_config', a, descr, user, cliente, 'ok', { ...extra, tentativas: r.tentativas, latencia_ms: r.ms });
    }
    return { limites: limitesParaTela(await this.repo.config(a.eid)) };
  }

  // ===== comandos ==============================================================
  async comando(equipamentoId: string, nome: unknown, user?: ScopedUser, cliente?: ClienteInfo): Promise<{ ok: true; resposta: string; mensagem: string }> {
    const def = COMANDOS[String(nome) as ComandoCarregador];
    if (!def) throw new BadRequestException('Comando desconhecido.');
    const comando = String(nome) as ComandoCarregador;
    const a = await this.alvo(equipamentoId, user, def.capacidade);
    const est = this.exigirOcpp(a.est);
    const extra = { comando, comando_ocpp: def.ocpp };
    let r: RespostaComando;
    try {
      if (comando === 'bloquear') r = await this.ocpp.disponibilidade(est, false);
      else if (comando === 'liberar') r = await this.ocpp.disponibilidade(est, true);
      else if (comando === 'destravar') r = await this.ocpp.destravar(est);
      else if (comando === 'reiniciar') r = await this.ocpp.reiniciar(est);
      else r = await this.ocpp.atualizar(est);
    } catch (e) {
      const erro = erroDoCarregador(e);
      await this.carregador.trilha(a.eid, `${def.titulo}: não enviado (${erro.message})`, `carregador.${comando}`, user);
      await this.registrar('carregador_comando', a, `Comando ${comando} não executado: ${erro.message}`, user, cliente, 'erro', extra);
      throw erro;
    }
    if (!def.aceitas.includes(r.resposta)) {
      const motivo = RECUSA[r.resposta] ?? 'o carregador recusou';
      await this.carregador.trilha(a.eid, `${def.titulo}: recusado (${r.resposta || 'sem resposta'})`, `carregador.${comando}`, user);
      await this.registrar('carregador_comando', a, `Comando ${comando} recusado pelo carregador (${r.resposta || 'sem resposta'})`, user, cliente, 'erro', { ...extra, resposta: r.resposta, latencia_ms: r.ms });
      throw new ConflictException(`Comando não executado: ${motivo} (resposta: ${r.resposta || 'vazia'}).`);
    }
    await this.carregador.trilha(a.eid, def.titulo, `carregador.${comando}`, user);
    await this.registrar('carregador_comando', a, def.titulo, user, cliente, 'ok', { ...extra, resposta: r.resposta, latencia_ms: r.ms });
    return { ok: true, resposta: r.resposta, mensagem: def.mensagem(r.resposta) };
  }

  // ===== conexão OCPP ==========================================================
  private base(): string {
    return baseOcpp(process.env.OCPP_PUBLIC_URL || process.env.IOT_ARTIFACTS_PUBLIC_BASE_URL);
  }

  async conexao(equipamentoId: string, user?: ScopedUser) {
    const a = await this.alvo(equipamentoId, user, 'tecnico');
    const e = a.est;
    return {
      vinculado: !!e,
      charge_point_id: e?.chargePointId ?? null,
      conectado: e ? this.ocpp.conectado(e) : false,
      ultima_conexao: iso(e?.ultimaConexao), ultimo_heartbeat: iso(e?.ultimoHeartbeat), ultimo_boot: iso(e?.ultimoBoot),
      fabricante: e?.vendor ?? null, modelo: e?.model ?? null, numero_serie: e?.serial ?? null, firmware: e?.firmware ?? null,
      perfis: e?.perfis ?? [], ip: e?.ip ?? null, chave_gerada_em: iso(e?.chaveGeradaEm),
      url_base: this.base(),
      recusadas: this.ocpp.tentativasRecusadas(),
    };
  }

  /** Liga o carregador a uma identidade OCPP. No primeiro vínculo gera a chave e a mostra uma vez. */
  async vincular(equipamentoId: string, body: any, user?: ScopedUser, cliente?: ClienteInfo) {
    const a = await this.alvo(equipamentoId, user, 'tecnico');
    const identidade = identidadeValida(body?.charge_point_id);
    if (!identidade) throw new BadRequestException('Identidade inválida: use o número de série do carregador (letras, números, ponto, hífen; até 64).');
    if (await this.repo.identidadeEmUso(identidade, a.eid)) throw new ConflictException('Esta identidade já está ligada a outro carregador.');
    const anterior = a.est?.chargePointId ?? null;
    if (anterior === identidade) return { charge_point_id: identidade }; // nada mudou
    // Carregador comandado pela TON mede e fecha a recarga pelo MQTT: os dois juntos brigam pela mesma recarga.
    if (!a.est && a.ctx.mqtt) {
      throw new BadRequestException('Este carregador é comandado pela TON (MQTT). Desligue o MQTT do equipamento antes de vincular por OCPP.');
    }
    if (anterior && anterior !== identidade && (await this.repo.sessaoAtiva(a.eid))) {
      throw new BadRequestException('Há recarga em andamento: troque a identidade depois que ela terminar.');
    }
    const chave = a.est ? null : gerarChave();
    await this.repo.vincular({ equipamentoId: a.eid, plantaId: a.plantaId, identidade, chaveHash: chave ? hashChave(chave) : null });
    await this.repo.config(a.eid);
    await this.ocpp.cadastroMudou(anterior && anterior !== identidade ? anterior : null);
    const msg = anterior ? `Identidade OCPP alterada: ${anterior} → ${identidade}` : `Carregador vinculado por OCPP · identidade ${identidade}`;
    await this.carregador.trilha(a.eid, msg, 'carregador.ocpp_vinculo', user);
    await this.registrar('carregador_ocpp', a, msg, user, cliente, 'ok', { operacao: anterior ? 'identidade' : 'vinculo', antes: anterior, depois: identidade, chave_gerada: !!chave });
    return { charge_point_id: identidade, ...(chave ? { chave, ...urlsDeConexao(this.base(), chave, identidade) } : {}) };
  }

  /** Chave nova: a anterior deixa de valer e a conexão atual cai. */
  async novaChave(equipamentoId: string, user?: ScopedUser, cliente?: ClienteInfo) {
    const a = await this.alvo(equipamentoId, user, 'tecnico');
    const est = this.exigirOcpp(a.est);
    const chave = gerarChave();
    await this.repo.trocarChave(est.id, hashChave(chave));
    await this.ocpp.cadastroMudou(est.chargePointId);
    await this.carregador.trilha(a.eid, 'Chave de conexão OCPP trocada (a anterior deixou de valer)', 'carregador.ocpp_chave', user);
    await this.registrar('carregador_ocpp', a, 'Chave de conexão OCPP trocada', user, cliente, 'ok', { operacao: 'chave' });
    return { chave, ...urlsDeConexao(this.base(), chave, est.chargePointId) };
  }

  async desvincular(equipamentoId: string, user?: ScopedUser, cliente?: ClienteInfo): Promise<{ ok: true }> {
    const a = await this.alvo(equipamentoId, user, 'tecnico');
    const est = this.exigirOcpp(a.est);
    if (await this.repo.sessaoAtiva(a.eid)) throw new BadRequestException('Há recarga em andamento: desvincule depois que ela terminar.');
    await this.repo.desvincular(est.id);
    await this.ocpp.cadastroMudou(est.chargePointId);
    await this.carregador.trilha(a.eid, `Carregador desvinculado do OCPP · identidade ${est.chargePointId}`, 'carregador.ocpp_vinculo', user);
    await this.registrar('carregador_ocpp', a, `Carregador desvinculado do OCPP · identidade ${est.chargePointId}`, user, cliente, 'ok', { operacao: 'desvinculo' });
    return { ok: true };
  }

  // ===== parâmetros do equipamento =============================================
  /** Lista de configuração que o próprio carregador devolve (GetConfiguration). Só leitura. */
  async parametros(equipamentoId: string, user?: ScopedUser) {
    const a = await this.alvo(equipamentoId, user, 'tecnico');
    try {
      return await this.ocpp.parametros(this.exigirOcpp(a.est));
    } catch (e) {
      throw erroDoCarregador(e);
    }
  }

  async mudarParametro(equipamentoId: string, body: any, user?: ScopedUser, cliente?: ClienteInfo): Promise<{ resposta: string }> {
    const a = await this.alvo(equipamentoId, user, 'tecnico');
    const est = this.exigirOcpp(a.est);
    const chave = String(body?.chave ?? '').trim();
    const valor = String(body?.valor ?? '');
    if (!chave || chave.length > 50) throw new BadRequestException('Informe o parâmetro (até 50 caracteres).');
    if (valor.length > 500) throw new BadRequestException('Valor passa de 500 caracteres.');
    // A chave de conexão não passa por aqui: troca só por "Gerar nova chave" (fica fora do log).
    if (chave.toLowerCase() === 'authorizationkey') throw new BadRequestException('A chave de conexão é trocada em "Gerar nova chave".');
    // O valor pode carregar segredo (URL com chave, senha): não vai inteiro para a trilha nem para o audit log.
    const visivel = parametroSecreto(chave) ? '•••' : semSegredo(valor);
    const extra = { operacao: 'parametro', parametro: chave, valor: visivel, comando_ocpp: 'ChangeConfiguration' };
    let r: RespostaComando;
    try {
      r = await this.ocpp.mudarParametro(est, chave, valor);
    } catch (e) {
      const erro: HttpException = erroDoCarregador(e);
      await this.registrar('carregador_ocpp', a, `Parâmetro ${chave} não alterado: ${erro.message}`, user, cliente, 'erro', extra);
      throw erro;
    }
    const ok = r.resposta === 'Accepted' || r.resposta === 'RebootRequired';
    const msg = `Parâmetro ${chave} = ${visivel.slice(0, 80)} (${r.resposta || 'sem resposta'})`;
    await this.carregador.trilha(a.eid, msg, 'carregador.ocpp_parametro', user);
    await this.registrar('carregador_ocpp', a, msg, user, cliente, ok ? 'ok' : 'erro', { ...extra, resposta: r.resposta, latencia_ms: r.ms });
    return { resposta: r.resposta };
  }
}
