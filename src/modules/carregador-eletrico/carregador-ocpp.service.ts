import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { EstacaoOcpp } from '../ocpp/ocpp-conexao';
import {
  Chamada,
  destravarConector,
  IdTagInfo,
  iniciarRemoto,
  lerConfiguracao,
  lerParametros,
  lerPerfis,
  limparPerfilCorrente,
  Medicao,
  mudarConfiguracao,
  mudarDisponibilidade,
  ParametroOcpp,
  pararRemoto,
  pedirMensagem,
  perfilCorrenteMaxima,
  PropositoPerfil,
  reiniciar,
  statusDa,
} from '../ocpp/ocpp-protocolo';
import { ErroOcpp, OcppService, OuvinteOcpp } from '../ocpp/ocpp.service';
import {
  chaveDaFalha,
  descreverFalha,
  estadoDoStatus,
  grupoDoMorador,
  limiteAtingido,
  motivoFinal,
  potenciaMediaW,
  textoMotivoFim,
} from './carregador-ocpp.regras';
import { CarregadorOcppRepositorio, EstacaoCadastro, SessaoCarregador } from './carregador-ocpp.repositorio';
import { hojeSP, situacaoValidade, somarDias } from './carregador.util';

export interface RespostaComando {
  /** `status` da resposta do carregador (Accepted, Rejected, NotSupported...). */
  resposta: string;
  ms: number;
}

/** Recarga liberada no NexON espera este tempo pelo início no carregador (carro conectado). */
const PRAZO_INICIO_MS = 3 * 60_000;
/** Depois de pedir a parada, espera isto antes de pedir de novo. */
const REPETIR_PARADA_MS = 60_000;
/** Conector livre há este tempo com recarga aberta = o fim não chegou: fecha com a última leitura. */
const ORFA_LIVRE_MS = 2 * 60_000;
const ORFA_OFFLINE_MS = 24 * 3_600_000;
/** Recarga com limite de energia e sem nenhuma leitura depois disto: avisa na trilha. */
const SEM_LEITURA_MS = 10 * 60_000;
/** Quantas vezes insiste em parar uma transação sem autorização (uma por tique do vigia). */
const TENTATIVAS_PARADA_FORCADA = 20;

const kwh = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v.toFixed(3).replace('.', ',')} kWh`);

/**
 * Ponte entre a central OCPP e o carregador do condomínio: o que o carregador diz vira
 * estado, falha, leitura e recarga (`carregador_sessoes`); o que o NexON pede vira chamada
 * OCPP. Sem usuário aqui: permissão e auditoria ficam em quem chama
 * (CarregadorEletricoService e CarregadorGestaoService).
 *
 * Regras que valem para todo carregador OCPP:
 *  - recarga liberada no NexON nasce "aguardando" e só mede depois do StartTransaction;
 *  - a recarga é sempre achada pelo carregador E pela transação: o número da transação
 *    sozinho não basta (um carregador não mexe na recarga de outro);
 *  - cartão não autorizado não carrega: a central manda parar, e insiste;
 *  - limite de tempo e de energia é do NexON (o OCPP 1.6 não tem a mensagem): ao atingir,
 *    manda RemoteStopTransaction e a recarga fecha quando o carregador confirma;
 *  - o fim da recarga é sempre o StopTransaction (a leitura final é a do carregador).
 */
@Injectable()
export class CarregadorOcppService implements OuvinteOcpp, OnModuleInit {
  private readonly logger = new Logger('CarregadorOCPP');
  /** Última leitura do registrador por carregador: potência média e energia do intervalo. */
  private readonly ultima = new Map<string, { ts: number; energiaWh: number }>();
  private readonly estados = new Map<string, string>();
  private readonly tarefas = new Set<Promise<unknown>>();
  private readonly aoEncerrar: Array<() => void> = [];
  /** Transações sem autorização que a central mandou parar e ainda não pararam (por carregador). */
  private readonly paradasForcadas = new Map<string, { equipamentoId: string; transactionId: number; tentativas: number }>();
  /** Recargas já avisadas de que o limite de energia está sem leitura. */
  private readonly avisadasSemLeitura = new Set<string>();
  private vigiando = false;
  prazoInicioMs = PRAZO_INICIO_MS;

  constructor(
    private readonly repo: CarregadorOcppRepositorio,
    private readonly ocpp: OcppService,
  ) {}

  onModuleInit(): void {
    this.ocpp.registrarOuvinte(this);
  }

  /** Avisa quando uma recarga fecha (o serviço do carregador revê as validades). */
  quandoEncerrar(fn: () => void): void {
    this.aoEncerrar.push(fn);
  }

  estacao(equipamentoId: string): Promise<EstacaoCadastro | null> {
    return this.repo.estacaoDoEquipamento(equipamentoId);
  }

  conectado(est: { chargePointId: string }): boolean {
    return this.ocpp.conectado(est.chargePointId);
  }

  /** Tarefa que não pode segurar a resposta ao carregador (inclusive chamadas de volta a ele). */
  private depois(fn: () => Promise<unknown>): void {
    const p: Promise<unknown> = new Promise((r) => setImmediate(r))
      .then(fn)
      .catch((e) => this.logger.warn(`tarefa falhou: ${e?.message || e}`))
      .finally(() => this.tarefas.delete(p));
    this.tarefas.add(p);
  }

  /** Espera as tarefas pendentes (testes). */
  async ocioso(): Promise<void> {
    while (this.tarefas.size) await Promise.all([...this.tarefas]);
  }

  // ===== o que o carregador diz ================================================
  async aoBoot(e: EstacaoOcpp): Promise<void> {
    // Só leitura: o que o próprio carregador declara suportar (perfis do OCPP).
    this.depois(async () => {
      const { parametros } = lerParametros(await this.ocpp.chamar(e.chargePointId, lerConfiguracao()));
      const perfis = lerPerfis(parametros);
      if (perfis.length) await this.repo.gravarPerfis(e.id, perfis);
      // Sem leitura periódica não há curva nem limite de energia: avisa em vez de mudar o carregador sozinho.
      const intervalo = parametros.find((x) => x.chave.toLowerCase() === 'metervaluesampleinterval');
      if (e.equipamentoId && intervalo && Number(intervalo.valor) === 0) {
        await this.repo.trilha(e.equipamentoId,
          'O carregador está sem leitura periódica (MeterValueSampleInterval = 0): a curva e o limite de energia não funcionam. Ajuste em Configuração › Parâmetros do equipamento.',
          'carregador.sem_leitura', { severidade: 'WARN', status: 'evento' });
      }
    });
  }

  async aoStatus(e: EstacaoOcpp, p: { connectorId: number; status: string; errorCode: string; vendorErrorCode: string | null; info: string | null; quando: Date }): Promise<void> {
    const eid = e.equipamentoId;
    if (!eid) return;
    if (p.connectorId !== 0 && p.connectorId !== e.conector) return; // outro conector da estação
    const est = await this.repo.estacaoDoEquipamento(eid);
    if (!est) return;
    // Conector 0 é a estação inteira: só rebaixa (indisponível, falha) ou tira uma falha dela;
    // "Available" da estação não apaga o "Charging" do conector.
    if (p.connectorId === 0 && p.status === 'Available' && p.errorCode === 'NoError'
      && est.status && !['Unavailable', 'Faulted'].includes(est.status) && !est.falhaDesde) return;

    const falha = descreverFalha(p);
    const anterior = descreverFalha({ status: est.status, errorCode: est.errorCode, vendorErrorCode: est.vendorErrorCode, info: est.info });
    await this.repo.gravarStatus(est.id, {
      status: p.status, errorCode: p.errorCode, vendorErrorCode: p.vendorErrorCode, info: p.info, quando: p.quando,
      falhaDesde: falha ? est.falhaDesde ?? p.quando : null,
    });
    const estado = estadoDoStatus(p.status);
    this.estados.set(eid, estado);
    await this.repo.config(eid);
    await this.repo.gravarEstado(eid, estado);

    if (chaveDaFalha(falha) !== chaveDaFalha(anterior)) {
      if (anterior) {
        await this.repo.resolverFalhas(eid);
        if (!falha) await this.repo.trilha(eid, `Falha normalizada · ${anterior.codigo ? `${anterior.codigo} · ` : ''}${anterior.titulo}`, 'carregador.falha_normalizada');
      }
      if (falha) {
        const texto = `Falha no carregador · ${falha.codigo ? `${falha.codigo} · ` : ''}${falha.titulo}`;
        await this.repo.abrirFalha(eid, falha, texto, { vendor_error_code: p.vendorErrorCode, info: p.info, status: p.status, solucao: falha.solucao });
        await this.repo.trilha(eid, texto, 'carregador.falha', { severidade: falha.severidade === 'BAIXA' ? 'WARN' : 'ERROR', status: 'evento' });
      }
    }
    if (p.status === 'Preparing') this.depois(() => this.iniciarSozinho(est));
  }

  /** "Iniciar sozinho ao conectar o carro": o carro foi conectado e ninguém liberou. */
  private async iniciarSozinho(est: EstacaoCadastro): Promise<void> {
    const cfg = await this.repo.config(est.equipamentoId);
    if (!cfg.inicioAutomatico || !est.disponivel) return;
    if (await this.repo.sessaoAtiva(est.equipamentoId)) return;
    const idTag = 'NEXON-AUTO';
    try {
      const r = statusDa(await this.ocpp.chamar(est.chargePointId, iniciarRemoto(idTag, est.conector)));
      if (r !== 'Accepted') await this.repo.trilha(est.equipamentoId, `Início automático recusado pelo carregador (${r || 'sem resposta'})`, 'carregador.inicio_automatico', { severidade: 'WARN', status: 'erro' });
    } catch (e: any) {
      await this.repo.trilha(est.equipamentoId, `Início automático não enviado: ${e?.message || e}`, 'carregador.inicio_automatico', { severidade: 'WARN', status: 'erro' });
    }
  }

  /**
   * Quem pode carregar: a tag de uma recarga liberada no NexON (inclusive a que volta
   * depois de uma queda de energia), o cartão de um morador ativo e dentro da validade (na
   * planta do carregador) ou, com o início automático ligado, qualquer um.
   *
   * `parentIdTag` junta a tag da recarga e o cartão do mesmo morador: é o que deixa o cartão
   * dele parar no carregador a recarga que foi liberada pelo NexON.
   */
  async autorizar(e: EstacaoOcpp, idTag: string): Promise<IdTagInfo> {
    const eid = e.equipamentoId;
    const tag = String(idTag ?? '').trim().toUpperCase();
    if (!eid || !tag) return { status: 'Invalid' };
    const grupo = (moradorId: string | null) => (moradorId ? { parentIdTag: grupoDoMorador(moradorId) } : {});
    const ativa = await this.repo.sessaoAtiva(eid);
    if (ativa?.idTag && ativa.idTag.toUpperCase() === tag) return { status: 'Accepted', ...grupo(ativa.moradorId) };
    const m = await this.repo.moradorPorTag(e.plantaId, tag);
    if (m) {
      if (!m.ativo) return { status: 'Blocked' };
      if (situacaoValidade(m.validade, hojeSP()) === 'vencido') return { status: 'Expired' };
      // Vale até o fim do último dia (00:00 de Brasília do dia seguinte = 03:00 UTC).
      return { status: 'Accepted', ...(m.validade ? { expiryDate: `${somarDias(m.validade, 1)}T03:00:00.000Z` } : {}), ...grupo(m.id) };
    }
    const retomada = await this.repo.sessaoRetomavel(eid, tag);
    if (retomada) return { status: 'Accepted', ...grupo(retomada.moradorId) };
    const cfg = await this.repo.config(eid);
    return cfg.inicioAutomatico ? { status: 'Accepted' } : { status: 'Invalid' };
  }

  async aoIniciar(e: EstacaoOcpp, p: { transactionId: number; connectorId: number; idTag: string; meterStartWh: number; quando: Date; autorizacao: IdTagInfo; repetida: boolean }): Promise<void> {
    const eid = e.equipamentoId;
    if (!eid) return;
    if (p.connectorId !== e.conector) {
      // Outro conector da estação não é este equipamento: fica só no registro bruto.
      this.logger.warn(`[${e.chargePointId}] StartTransaction #${p.transactionId} no conector ${p.connectorId} (o carregador é o ${e.conector}): ignorada`);
      return;
    }
    if (await this.repo.sessaoPorTransacao(eid, p.transactionId)) return; // StartTransaction repetido
    const tag = p.idTag.toUpperCase();
    const kwhInicio = p.meterStartWh / 1000;
    this.ultima.set(eid, { ts: p.quando.getTime(), energiaWh: p.meterStartWh });
    const ativa = await this.repo.sessaoAtiva(eid);

    if (ativa && ativa.transactionId === null && ativa.idTag?.toUpperCase() === tag) {
      // Recarga liberada no NexON: o carregador confirmou que começou.
      await this.repo.anexarTransacao(ativa.id, p.transactionId, kwhInicio, p.quando);
      await this.repo.trilha(eid, `Recarga começou no carregador · ${ativa.moradorNome ?? '—'}`, 'carregador.iniciada', { status: 'evento', tecnico: `StartTransaction #${p.transactionId}` });
      return;
    }
    if (ativa) {
      // Sobrou uma recarga aberta e o carregador começou outra.
      if (ativa.transactionId === null) await this.repo.cancelar(ativa.id);
      else await this.repo.encerrar(ativa.id, { fim: p.quando, kwhFim: null, motivo: 'sem_confirmacao' });
    }
    if (p.autorizacao.status !== 'Accepted') {
      await this.repo.trilha(eid, `Cartão recusado (${p.autorizacao.status}) · tag ${tag}: recarga não liberada`, 'carregador.cartao_recusado', { severidade: 'WARN', status: 'evento', tecnico: `StartTransaction #${p.transactionId}` });
      // Não deixa carregar sem autorização, mesmo que o carregador não pare sozinho: manda
      // parar agora e o vigia insiste até o StopTransaction chegar.
      this.paradasForcadas.set(e.chargePointId, { equipamentoId: eid, transactionId: p.transactionId, tentativas: 0 });
      this.depois(() => this.forcarParada(e.chargePointId));
      return;
    }
    const morador = await this.repo.moradorPorTag(e.plantaId, tag);
    // Mesma tag de uma recarga que caiu (queda de energia, reinício): é a continuação dela.
    const retomada = morador ? null : await this.repo.sessaoRetomavel(eid, tag);
    const cfg = await this.repo.config(eid);
    await this.repo.criarSessao({
      equipamentoId: eid, plantaId: e.plantaId,
      moradorId: morador?.id ?? retomada?.moradorId ?? null,
      moradorNome: morador?.nome ?? retomada?.moradorNome ?? 'Sem identificação',
      inicio: p.quando, kwhInicio,
      liberadoPor: morador ? 'tag' : retomada ? retomada.liberadoPor : 'automatico',
      liberadoPorUser: morador ? 'cartão no carregador' : retomada ? 'retomada após interrupção' : 'início automático',
      tarifaKwh: cfg.tarifaKwh, socInicio: null, transactionId: p.transactionId, idTag: tag,
      limiteTempoMin: retomada ? retomada.limiteTempoMin : cfg.limiteTempoMin,
      limiteEnergiaKwh: retomada ? retomada.limiteEnergiaKwh : cfg.limiteEnergiaKwh,
    });
    const texto = morador ? `Recarga iniciada pelo cartão · ${morador.nome}`
      : retomada ? `Recarga retomada pelo carregador · ${retomada.moradorNome ?? '—'}`
      : 'Recarga iniciada sem identificação (início automático)';
    await this.repo.trilha(eid, texto, 'carregador.iniciar', { status: 'evento', tecnico: `StartTransaction #${p.transactionId}` });
  }

  /** Manda parar a transação que começou sem autorização. Uma tentativa por chamada. */
  private async forcarParada(chargePointId: string): Promise<void> {
    const f = this.paradasForcadas.get(chargePointId);
    if (!f) return;
    f.tentativas += 1;
    try {
      await this.ocpp.chamar(chargePointId, pararRemoto(f.transactionId));
    } catch { /* offline ou sem resposta: o vigia tenta de novo */ }
    if (f.tentativas >= TENTATIVAS_PARADA_FORCADA && this.paradasForcadas.get(chargePointId) === f) {
      this.paradasForcadas.delete(chargePointId);
      await this.repo.trilha(f.equipamentoId, `O carregador não parou a recarga sem autorização (transação ${f.transactionId}) depois de ${f.tentativas} pedidos`,
        'carregador.cartao_recusado', { severidade: 'ERROR', status: 'erro' });
    }
  }

  async aoMedicoes(e: EstacaoOcpp, p: { transactionId: number | null; connectorId: number; medicoes: Array<Medicao & { quando: Date }> }): Promise<void> {
    const eid = e.equipamentoId;
    if (!eid || !p.medicoes.length) return;
    if (p.connectorId !== 0 && p.connectorId !== e.conector) return;
    let sessao: SessaoCarregador | null = p.transactionId !== null ? await this.repo.sessaoPorTransacao(eid, p.transactionId) : await this.repo.sessaoAtiva(eid);
    if (sessao?.status === 'encerrada') {
      // Fechada sem a confirmação do carregador e ele segue medindo: a recarga não acabou.
      if (sessao.motivoFim === 'sem_confirmacao' && !(await this.repo.sessaoAtiva(eid))) {
        await this.repo.reabrir(sessao.id);
        await this.repo.trilha(eid, `Recarga reaberta: o carregador continua medindo · ${sessao.moradorNome ?? '—'}`, 'carregador.reaberta', { status: 'evento', severidade: 'WARN' });
        sessao = { ...sessao, status: 'ativa', motivoFim: null };
      } else {
        sessao = null;
      }
    }
    const estado = this.estados.get(eid) ?? estadoDoStatus((await this.repo.estacaoDoEquipamento(eid))?.status);
    this.estados.set(eid, estado);

    for (const m of [...p.medicoes].sort((a, b) => a.quando.getTime() - b.quando.getTime())) {
      const ts = m.quando.getTime();
      const anterior = this.ultima.get(eid);
      let potenciaW = m.potenciaW;
      let energiaIntervaloKwh: number | null = null;
      if (m.energiaWh !== null) {
        const media = potenciaMediaW(anterior, { ts, energiaWh: m.energiaWh });
        if (media !== null && anterior) energiaIntervaloKwh = Math.round((m.energiaWh - anterior.energiaWh)) / 1000;
        if (potenciaW === null) potenciaW = media;
        if (!anterior || ts >= anterior.ts) this.ultima.set(eid, { ts, energiaWh: m.energiaWh });
      }
      const registradorKwh = m.energiaWh === null ? null : m.energiaWh / 1000;
      const kwhSessao = sessao && sessao.kwhInicio !== null && registradorKwh !== null
        ? Math.max(Math.round((registradorKwh - sessao.kwhInicio) * 1000) / 1000, 0)
        : sessao?.kwhTotal ?? null;
      const potenciaKw = potenciaW === null ? null : Math.round(potenciaW) / 1000;
      const leitura = {
        potencia_kw: potenciaKw, corrente_a: m.correnteA, tensao_v: m.tensaoV, temperatura_c: m.temperaturaC,
        energia_sessao_kwh: kwhSessao, lido_em: m.quando.toISOString(),
      };
      await this.repo.gravarLeitura({ estacaoId: e.id, equipamentoId: eid, quando: m.quando, leitura, kwhRegistrador: registradorKwh, soc: m.soc });
      if (sessao && registradorKwh !== null) await this.repo.atualizarEnergia(sessao.id, registradorKwh);
      // Série do equipamento (dados/atual, histórico, resumo diário). `Pt` em W como os apps leem.
      await this.repo.gravarDado(eid, m.quando, {
        ...(potenciaW === null ? {} : { Pt: Math.round(potenciaW) }),
        potencia_kw: potenciaKw, status: estado, estado, energia_sessao_kwh: kwhSessao, energia_total_kwh: registradorKwh,
        corrente_a: m.correnteA, tensao_v: m.tensaoV, temperatura_c: m.temperaturaC, soc: m.soc,
        corrente_ofertada_a: m.correnteOfertadaA, fases: m.fases, fonte: 'ocpp',
      }, potenciaKw, energiaIntervaloKwh);
    }
    if (sessao) this.depois(() => this.vigiar());
  }

  async aoParar(e: EstacaoOcpp, p: { transactionId: number; meterStopWh: number; quando: Date; motivo: string; repetida: boolean; conhecida: boolean }): Promise<void> {
    const eid = e.equipamentoId;
    if (!eid) return;
    if (this.paradasForcadas.get(e.chargePointId)?.transactionId === p.transactionId) this.paradasForcadas.delete(e.chargePointId);
    // Transação que não é deste carregador (fila antiga de outra plataforma, número de outro): nada a fechar.
    if (!p.conhecida) return;
    const s = await this.repo.sessaoPorTransacao(eid, p.transactionId);
    if (!s) return;
    // Já fechada: só reabre a conta se tinha sido fechada sem a confirmação do carregador.
    if (s.status === 'encerrada' && s.motivoFim !== 'sem_confirmacao') return;
    const motivo = motivoFinal(s.status === 'ativa' ? s.motivoFim : null, p.motivo);
    const kwhFim = p.meterStopWh / 1000;
    await this.repo.encerrar(s.id, { fim: p.quando, kwhFim, motivo });
    this.ultima.delete(eid);
    this.avisadasSemLeitura.delete(s.id);
    const estado = this.estados.get(eid) ?? 'finalizando';
    const total = s.kwhInicio === null ? null : Math.max(Math.round((kwhFim - s.kwhInicio) * 1000) / 1000, 0);
    await this.repo.gravarLeitura({
      estacaoId: e.id, equipamentoId: eid, quando: p.quando, kwhRegistrador: kwhFim, soc: null,
      leitura: { potencia_kw: 0, corrente_a: null, tensao_v: null, temperatura_c: null, energia_sessao_kwh: total, lido_em: p.quando.toISOString() },
    });
    await this.repo.gravarDado(eid, p.quando, { Pt: 0, potencia_kw: 0, status: estado, estado, energia_sessao_kwh: total, energia_total_kwh: kwhFim, fonte: 'ocpp' }, 0, null);
    await this.repo.trilha(eid, `Recarga encerrada · ${s.moradorNome ?? '—'} · ${kwh(total)} · ${textoMotivoFim(motivo) ?? motivo}`,
      'carregador.encerrada', { status: 'evento', tecnico: `StopTransaction #${p.transactionId} (${p.motivo})` });
    this.aoEncerrar.forEach((fn) => {
      try { fn(); } catch { /* aviso é cortesia */ }
    });
  }

  // ===== o vigia: prazo de início, limites e recarga que ficou aberta ==========
  @Interval(20_000)
  async vigiar(): Promise<void> {
    if (this.vigiando) return;
    this.vigiando = true;
    try {
      for (const cp of [...this.paradasForcadas.keys()]) await this.forcarParada(cp);
      const agora = new Date();
      for (const s of await this.repo.sessoesAtivasOcpp()) {
        const idadeMs = agora.getTime() - s.inicio.getTime();
        if (s.transactionId === null) {
          if (idadeMs > this.prazoInicioMs) {
            await this.repo.cancelar(s.id);
            await this.repo.trilha(s.equipamentoId, `Recarga não começou · ${s.moradorNome ?? '—'}: o carro não foi conectado em ${Math.round(this.prazoInicioMs / 60_000)} min`,
              'carregador.nao_iniciou', { severidade: 'WARN', status: 'evento' });
          }
          continue;
        }
        const limite = limiteAtingido(s, agora);
        const jaPedida = s.paradaPedidaEm && agora.getTime() - s.paradaPedidaEm.getTime() < REPETIR_PARADA_MS;
        if (limite && !jaPedida && this.ocpp.conectado(s.chargePointId)) {
          const primeira = !s.paradaPedidaEm;
          await this.repo.pedirParada(s.id, s.motivoFim ?? limite);
          const texto = limite === 'limite_tempo' ? `limite de tempo (${s.limiteTempoMin} min)` : `limite de energia (${String(s.limiteEnergiaKwh).replace('.', ',')} kWh)`;
          try {
            const r = statusDa(await this.ocpp.chamar(s.chargePointId, pararRemoto(s.transactionId)));
            if (primeira) await this.repo.trilha(s.equipamentoId, `Parada pedida ao carregador por ${texto} · ${s.moradorNome ?? '—'} (${r || 'sem resposta'})`,
              'carregador.limite', { status: r === 'Accepted' ? 'ok' : 'erro', severidade: r === 'Accepted' ? 'INFO' : 'WARN', tecnico: `RemoteStopTransaction #${s.transactionId}` });
          } catch (e: any) {
            if (primeira) await this.repo.trilha(s.equipamentoId, `Parada por ${texto} não enviada: ${e?.message || e}`, 'carregador.limite', { status: 'erro', severidade: 'WARN' });
          }
          continue;
        }
        // Limite de energia depende da leitura: sem nenhuma desde o início, o limite não dispara.
        const semLeitura = s.limiteEnergiaKwh !== null && idadeMs > SEM_LEITURA_MS && (!s.leituraEm || s.leituraEm.getTime() < s.inicio.getTime());
        if (semLeitura && !this.avisadasSemLeitura.has(s.id)) {
          this.avisadasSemLeitura.add(s.id);
          await this.repo.trilha(s.equipamentoId, `Recarga com limite de energia e sem leitura do carregador há ${Math.round(SEM_LEITURA_MS / 60_000)} min · ${s.moradorNome ?? '—'}: o limite não dispara sem leitura. Confira o parâmetro MeterValueSampleInterval.`,
            'carregador.sem_leitura', { severidade: 'WARN', status: 'evento' });
        }
        // Conector livre depois do início, há um tempo, e sem leitura nova desde então: o fim não chegou.
        // Leitura depois do "livre" quer dizer que a transação segue viva (o status é que ficou velho).
        const livre = s.statusEstacao === 'Available' && s.statusEm && agora.getTime() - s.statusEm.getTime() > ORFA_LIVRE_MS
          && s.statusEm.getTime() > s.inicio.getTime() && (!s.leituraEm || s.leituraEm.getTime() <= s.statusEm.getTime());
        // Sem conexão desde quando? A queda mais recente, nunca antes da última conexão.
        const ultimoContato = Math.max(s.ultimaDesconexao?.getTime() ?? 0, s.ultimaConexao?.getTime() ?? 0);
        const sumiu = !this.ocpp.conectado(s.chargePointId) && ultimoContato > 0 && agora.getTime() - ultimoContato > ORFA_OFFLINE_MS;
        if (livre || sumiu) {
          await this.repo.encerrar(s.id, { fim: livre ? s.statusEm! : agora, kwhFim: null, motivo: 'sem_confirmacao' });
          await this.repo.trilha(s.equipamentoId, `Recarga fechada sem a confirmação do carregador · ${s.moradorNome ?? '—'} (${livre ? 'conector livre' : 'sem comunicação há 24 h'})`,
            'carregador.encerrada', { severidade: 'WARN', status: 'evento' });
        }
      }
    } catch (e: any) {
      this.logger.warn(`vigia: ${e?.message || e}`);
    } finally {
      this.vigiando = false;
    }
  }

  // ===== o que o NexON pede ao carregador ======================================
  private async chamar(est: { chargePointId: string }, c: Chamada): Promise<{ payload: Record<string, any>; ms: number }> {
    const t0 = Date.now();
    const payload = await this.ocpp.chamar(est.chargePointId, c);
    return { payload, ms: Date.now() - t0 };
  }

  private async comando(est: { chargePointId: string }, c: Chamada): Promise<RespostaComando> {
    const { payload, ms } = await this.chamar(est, c);
    return { resposta: statusDa(payload), ms };
  }

  iniciarRemoto(est: EstacaoCadastro, idTag: string): Promise<RespostaComando> {
    return this.comando(est, iniciarRemoto(idTag, est.conector));
  }

  pararRemoto(est: EstacaoCadastro, transactionId: number): Promise<RespostaComando> {
    return this.comando(est, pararRemoto(transactionId));
  }

  /**
   * Corrente máxima. Tenta o perfil padrão das recargas do conector e, se o carregador
   * recusar, o perfil da estação inteira; `null` tira o limite. Devolve cada tentativa
   * com a resposta do carregador (vai para a auditoria).
   */
  async aplicarCorrente(est: EstacaoCadastro, limiteA: number | null): Promise<{ aceito: boolean; tentativas: Array<{ pedido: string; resposta: string }>; ms: number }> {
    const t0 = Date.now();
    const tentativas: Array<{ pedido: string; resposta: string }> = [];
    const tentar = async (pedido: string, c: Chamada): Promise<string> => {
      let resposta: string;
      try {
        resposta = statusDa(await this.ocpp.chamar(est.chargePointId, c));
      } catch (e) {
        // CALLERROR (NotSupported, NotImplemented) é resposta do carregador; offline e timeout sobem.
        if (!(e instanceof ErroOcpp) || e.tipo !== 'erro_carregador') throw e;
        resposta = e.codigo ?? 'Erro';
      }
      tentativas.push({ pedido, resposta });
      return resposta;
    };
    let aceito = false;
    if (limiteA === null) {
      const r = await tentar('ClearChargingProfile', limparPerfilCorrente());
      aceito = r === 'Accepted' || r === 'Unknown'; // Unknown = não havia perfil
    } else {
      for (const proposito of ['TxDefaultProfile', 'ChargePointMaxProfile'] as PropositoPerfil[]) {
        const r = await tentar(`SetChargingProfile ${proposito} ${limiteA} A`, perfilCorrenteMaxima({ conector: est.conector, limiteA, proposito }));
        if (r === 'Accepted') { aceito = true; break; }
      }
    }
    return { aceito, tentativas, ms: Date.now() - t0 };
  }

  async disponibilidade(est: EstacaoCadastro, disponivel: boolean): Promise<RespostaComando> {
    const r = await this.comando(est, mudarDisponibilidade(0, disponivel ? 'Operative' : 'Inoperative'));
    // Scheduled = aceito, vale ao fim da recarga em andamento.
    if (r.resposta === 'Accepted' || r.resposta === 'Scheduled') await this.repo.gravarDisponivel(est.id, disponivel);
    return r;
  }

  destravar(est: EstacaoCadastro): Promise<RespostaComando> {
    return this.comando(est, destravarConector(est.conector));
  }

  reiniciar(est: EstacaoCadastro): Promise<RespostaComando> {
    return this.comando(est, reiniciar('Soft'));
  }

  /** Pede o estado e a leitura na hora (perfil RemoteTrigger; quem não tem responde NotImplemented). */
  async atualizar(est: EstacaoCadastro): Promise<RespostaComando> {
    const r = await this.comando(est, pedirMensagem('StatusNotification', est.conector));
    await this.comando(est, pedirMensagem('MeterValues', est.conector)).catch(() => undefined);
    return r;
  }

  async parametros(est: EstacaoCadastro): Promise<{ parametros: ParametroOcpp[]; desconhecidas: string[] }> {
    const r = lerParametros((await this.chamar(est, lerConfiguracao())).payload);
    const perfis = lerPerfis(r.parametros);
    if (perfis.length) await this.repo.gravarPerfis(est.id, perfis);
    return r;
  }

  mudarParametro(est: EstacaoCadastro, chave: string, valor: string): Promise<RespostaComando> {
    return this.comando(est, mudarConfiguracao(chave, valor));
  }

  /** Cadastro mudou (vínculo, chave): a central relê e a conexão antiga cai. */
  async cadastroMudou(identidadeAntiga?: string | null): Promise<void> {
    await this.ocpp.recarregarCadastro();
    if (identidadeAntiga) this.ocpp.derrubar(identidadeAntiga);
  }

  tentativasRecusadas() {
    return this.ocpp.tentativasRecusadas();
  }
}
