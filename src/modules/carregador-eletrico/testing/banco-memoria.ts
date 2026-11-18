import { ForbiddenException } from '@nestjs/common';
import type { EstacaoOcpp } from '../../ocpp/ocpp-conexao';
import type { OcppRepositorio, TransacaoOcpp } from '../../ocpp/ocpp.repositorio';
import { CORRENTE_MAX_PADRAO_A } from '../carregador-ocpp.regras';
import type { CarregadorOcppRepositorio, ConfigCarregador, EstacaoCadastro, SessaoCarregador } from '../carregador-ocpp.repositorio';

/**
 * Banco em memória dos testes do carregador OCPP: as duas camadas de banco (central OCPP e
 * ponte do carregador) sobre as mesmas tabelas, mais o Prisma e o escopo falsos que o
 * CarregadorEletricoService usa. Mesmo comportamento do SQL de produção, sem Postgres.
 */
const GLOBAIS = ['super_admin', 'admin', 'analista', 'gerente', 'analista_automacao', 'analista_operacao'];

interface Estacao extends EstacaoCadastro { chaveHash: string | null; deletedAt: Date | null }
interface Sessao extends SessaoCarregador { fim: Date | null; kwhFim: number | null; tarifaKwh: number | null; liberadoPorUser: string }

export class BancoMemoria {
  private n = 0;
  private tx = 0;
  equipamentos: Array<{ id: string; nome: string; unidade: { id: string; nome: string }; planta: { id: string; nome: string }; mqtt?: boolean }> = [];
  estacoes: Estacao[] = [];
  transacoes: Array<TransacaoOcpp & { cp: string; inicio: Date; fim: Date | null; meterStopWh: number | null; motivo: string | null }> = [];
  medicoes: any[] = [];
  configs = new Map<string, ConfigCarregador & { ultimoEstado: string | null; ultimaLeituraKwh: number | null }>();
  sessoes: Sessao[] = [];
  moradores: Array<{ id: string; nome: string; apartamento?: string; tagUid: string | null; plantaId: string; ativo: boolean; validade: string | null; usuarioId?: string }> = [];
  dados: Array<{ equipamentoId: string; quando: Date; dados: any; potenciaKw: number | null; energiaKwh: number | null }> = [];
  trilhas: Array<{ equipamentoId: string; mensagem: string; semantico: string; usuarioId: string | null; status?: string; tecnico?: string | null }> = [];
  alarmes: Array<{ equipamentoId: string; codigo: string | null; ocpp: string; mensagem: string; severidade: string; resolvido: boolean }> = [];
  auditoria: any[] = [];
  /** Plantas de cada proprietário e carregadores liberados a cada operador. */
  donos = new Map<string, string[]>();
  operadores = new Map<string, string[]>();

  id(): string {
    return `id-${++this.n}`;
  }

  novoEquipamento(id: string, nome: string, plantaId = 'pl-1'): void {
    this.equipamentos.push({ id, nome, unidade: { id: `un-${plantaId}`, nome: `Eletroposto ${plantaId}` }, planta: { id: plantaId, nome: `Planta ${plantaId}` } });
  }

  novaEstacao(p: { equipamentoId: string; identidade: string; chaveHash: string | null; plantaId?: string }): Estacao {
    const e: Estacao = {
      id: this.id(), chargePointId: p.identidade, equipamentoId: p.equipamentoId, plantaId: p.plantaId ?? 'pl-1', conector: 1,
      conectado: false, status: null, errorCode: null, vendorErrorCode: null, info: null, statusEm: null, falhaDesde: null, perfis: [],
      disponivel: true, ultimaConexao: null, ultimaDesconexao: null, ultimoHeartbeat: null, ultimoBoot: null, vendor: null, model: null,
      serial: null, firmware: null, ip: null, chaveGeradaEm: p.chaveHash ? new Date() : null, temChave: !!p.chaveHash, leitura: null,
      leituraEm: null, chaveHash: p.chaveHash, deletedAt: null,
    };
    this.estacoes.push(e);
    return e;
  }

  private estacaoPorId(id: string): Estacao {
    return this.estacoes.find((e) => e.id === id)!;
  }

  private cfg(eid: string) {
    let c = this.configs.get(eid);
    if (!c) {
      c = {
        tarifaKwh: null, potenciaKw: null, limiteTempoMin: null, limiteEnergiaKwh: null, limiteCorrenteA: null,
        correnteMaxA: CORRENTE_MAX_PADRAO_A, correnteSuportada: null, inicioAutomatico: false, ultimoSoc: null, ultimoEstado: null, ultimaLeituraKwh: null,
      };
      this.configs.set(eid, c);
    }
    return c;
  }

  // ---- central OCPP -----------------------------------------------------------
  repoOcpp(): OcppRepositorio {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- os objetos abaixo têm `this` próprio
    const b = this;
    const repo = {
      async listarEstacoes(): Promise<EstacaoOcpp[]> {
        return b.estacoes.filter((e) => !e.deletedAt).map((e) => ({
          id: e.id, chargePointId: e.chargePointId, equipamentoId: e.equipamentoId, plantaId: e.plantaId, conector: e.conector, chaveHash: e.chaveHash,
        }));
      },
      async marcarTodasDesconectadas() {
        b.estacoes.filter((e) => e.conectado).forEach((e) => Object.assign(e, { conectado: false, ultimaDesconexao: new Date() }));
      },
      async conectou(id: string, ip: string | null) { Object.assign(b.estacaoPorId(id), { conectado: true, ultimaConexao: new Date(), ip }); },
      async desconectou(id: string) { Object.assign(b.estacaoPorId(id), { conectado: false, ultimaDesconexao: new Date() }); },
      async boot(id: string, p: any) { Object.assign(b.estacaoPorId(id), { vendor: p.vendor, model: p.model, serial: p.serial, firmware: p.firmware, ultimoBoot: new Date(), conectado: true }); },
      async heartbeat(id: string) { b.estacaoPorId(id).ultimoHeartbeat = new Date(); },
      async transacaoIgual(cp: string, connectorId: number, idTag: string, meterStartWh: number, inicio: Date) {
        const t = b.transacoes.find((x) => x.cp === cp && x.connectorId === connectorId && x.idTag === idTag && x.meterStartWh === meterStartWh && x.inicio.getTime() === inicio.getTime());
        return t ? t.transactionId : null;
      },
      async novaTransacao(p: any) {
        const transactionId = ++b.tx;
        b.transacoes.push({ transactionId, status: 'ativa', connectorId: p.connectorId, idTag: p.idTag, meterStartWh: p.meterStartWh, cp: p.cp, inicio: p.inicio, fim: null, meterStopWh: null, motivo: null });
        return transactionId;
      },
      async transacao(cp: string, transactionId: number) {
        return b.transacoes.find((x) => x.cp === cp && x.transactionId === transactionId) ?? null;
      },
      async encerrarTransacao(cp: string, transactionId: number, p: any) {
        const t = b.transacoes.find((x) => x.cp === cp && x.transactionId === transactionId);
        if (t) Object.assign(t, { status: 'encerrada', meterStopWh: p.meterStopWh, fim: p.fim, motivo: p.motivo });
      },
      async gravarMedicao(p: any) { b.medicoes.push(p); },
    };
    return repo as unknown as OcppRepositorio;
  }

  // ---- ponte do carregador ----------------------------------------------------
  repoCarregador(): CarregadorOcppRepositorio {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- os objetos abaixo têm `this` próprio
    const b = this;
    const repo = {
      async estacaoDoEquipamento(eid: string): Promise<EstacaoCadastro | null> {
        const e = b.estacoes.find((x) => x.equipamentoId === eid.trim() && !x.deletedAt);
        return e ? { ...e, temChave: !!e.chaveHash } : null;
      },
      async identidadeEmUso(identidade: string, eid: string) {
        return b.estacoes.some((e) => !e.deletedAt && e.chargePointId.toLowerCase() === identidade.toLowerCase() && e.equipamentoId !== eid.trim());
      },
      async vincular(p: any) {
        const e = b.estacoes.find((x) => x.equipamentoId === p.equipamentoId.trim() && !x.deletedAt);
        if (e) {
          b.transacoes.filter((t) => t.cp === e.chargePointId).forEach((t) => { t.cp = p.identidade; });
          Object.assign(e, { chargePointId: p.identidade, plantaId: p.plantaId });
        }
        else b.novaEstacao({ equipamentoId: p.equipamentoId.trim(), identidade: p.identidade, chaveHash: p.chaveHash, plantaId: p.plantaId });
      },
      async trocarChave(id: string, chaveHash: string) { Object.assign(b.estacaoPorId(id), { chaveHash, chaveGeradaEm: new Date() }); },
      async desvincular(id: string) {
        const e = b.estacaoPorId(id);
        const lapide = `${e.chargePointId}#${e.id}`;
        b.transacoes.filter((t) => t.cp === e.chargePointId).forEach((t) => { t.cp = lapide; });
        Object.assign(e, { deletedAt: new Date(), conectado: false, chaveHash: null, chargePointId: lapide });
      },
      async gravarStatus(id: string, p: any) {
        Object.assign(b.estacaoPorId(id), { status: p.status, errorCode: p.errorCode, vendorErrorCode: p.vendorErrorCode, info: p.info, statusEm: p.quando, falhaDesde: p.falhaDesde });
      },
      async gravarPerfis(id: string, perfis: string[]) { b.estacaoPorId(id).perfis = perfis; },
      async gravarDisponivel(id: string, disponivel: boolean) { b.estacaoPorId(id).disponivel = disponivel; },
      async contexto(eid: string) {
        const e = b.equipamentos.find((x) => x.id === eid.trim());
        return e ? { id: e.id, nome: e.nome, unidade: e.unidade, planta: e.planta, mqtt: !!e.mqtt } : null;
      },
      async config(eid: string): Promise<ConfigCarregador> { return { ...b.cfg(eid.trim()) }; },
      async salvarLimitesDeUso(eid: string, p: any) { Object.assign(b.cfg(eid.trim()), p); },
      async salvarCorrente(eid: string, limiteA: number | null, suportada: boolean | null) { Object.assign(b.cfg(eid.trim()), { limiteCorrenteA: limiteA, correnteSuportada: suportada }); },
      async marcarCorrenteNaoSuportada(eid: string) { b.cfg(eid.trim()).correnteSuportada = false; },
      async gravarEstado(eid: string, estado: string) { b.cfg(eid.trim()).ultimoEstado = estado; },
      async gravarLeitura(p: any) {
        Object.assign(b.estacaoPorId(p.estacaoId), { leitura: p.leitura, leituraEm: p.quando });
        if (p.kwhRegistrador !== null) b.cfg(p.equipamentoId.trim()).ultimaLeituraKwh = p.kwhRegistrador;
        if (p.soc !== null) b.cfg(p.equipamentoId.trim()).ultimoSoc = p.soc;
      },
      async gravarDado(equipamentoId: string, quando: Date, dados: any, potenciaKw: number | null, energiaKwh: number | null) {
        b.dados.push({ equipamentoId, quando, dados, potenciaKw, energiaKwh });
      },
      async sessaoAtiva(eid: string) {
        const s = b.sessoes.filter((x) => x.equipamentoId === eid.trim() && x.status === 'ativa').sort((a, c) => c.inicio.getTime() - a.inicio.getTime())[0];
        return s ? { ...s } : null;
      },
      async sessaoPorTransacao(eid: string, transactionId: number) {
        const s = b.sessoes.find((x) => x.equipamentoId === eid.trim() && x.transactionId === transactionId);
        return s ? { ...s } : null;
      },
      async sessaoRetomavel(eid: string, tag: string) {
        // Só a última recarga com a tag conta.
        const s = b.sessoes
          .filter((x) => x.equipamentoId === eid.trim() && (x.idTag ?? '').toUpperCase() === tag.trim().toUpperCase())
          .sort((a, c) => c.inicio.getTime() - a.inicio.getTime() || (c.transactionId ?? 0) - (a.transactionId ?? 0))[0];
        const vale = !!s && s.status === 'encerrada' && !!s.fim && Date.now() - s.fim.getTime() < 24 * 3_600_000
          && ['queda_energia', 'reinicio', 'sem_confirmacao'].includes(s.motivoFim ?? '');
        return vale ? { ...s } : null;
      },
      async reabrir(id: string) {
        const s = b.sessoes.find((x) => x.id === id && x.status === 'encerrada' && x.motivoFim === 'sem_confirmacao');
        if (s) Object.assign(s, { status: 'ativa', fim: null, motivoFim: null, paradaPedidaEm: null });
      },
      async sessoesAtivasOcpp() {
        return b.sessoes.filter((s) => s.status === 'ativa').flatMap((s) => {
          const e = b.estacoes.find((x) => x.equipamentoId === s.equipamentoId && !x.deletedAt);
          return e ? [{
            ...s, chargePointId: e.chargePointId, statusEstacao: e.status, statusEm: e.statusEm, conectado: e.conectado,
            ultimaDesconexao: e.ultimaDesconexao, ultimaConexao: e.ultimaConexao, leituraEm: e.leituraEm,
          }] : [];
        });
      },
      async criarSessao(p: any) {
        const id = b.id();
        b.sessoes.push({
          id, equipamentoId: p.equipamentoId.trim(), plantaId: p.plantaId, moradorId: p.moradorId, moradorNome: p.moradorNome, inicio: p.inicio,
          kwhInicio: p.kwhInicio, kwhTotal: p.kwhInicio === null ? null : 0, status: 'ativa', transactionId: p.transactionId, idTag: p.idTag,
          limiteTempoMin: p.limiteTempoMin, limiteEnergiaKwh: p.limiteEnergiaKwh, motivoFim: null, paradaPedidaEm: null, liberadoPor: p.liberadoPor,
          fim: null, kwhFim: p.kwhInicio, tarifaKwh: p.tarifaKwh, liberadoPorUser: p.liberadoPorUser,
        });
        return id;
      },
      async anexarTransacao(id: string, transactionId: number, kwhInicio: number, inicio: Date) {
        Object.assign(b.sessoes.find((s) => s.id === id)!, { transactionId, kwhInicio, kwhFim: kwhInicio, kwhTotal: 0, inicio });
      },
      async atualizarEnergia(id: string, kwhRegistrador: number) {
        const s = b.sessoes.find((x) => x.id === id && x.status === 'ativa');
        if (!s) return;
        s.kwhFim = kwhRegistrador;
        if (s.kwhInicio !== null) s.kwhTotal = Math.max(Math.round((kwhRegistrador - s.kwhInicio) * 1000) / 1000, 0);
      },
      async encerrar(id: string, p: { fim: Date; kwhFim: number | null; motivo: string }) {
        const s = b.sessoes.find((x) => x.id === id)!;
        const fim = p.kwhFim ?? s.kwhFim;
        s.kwhFim = fim;
        if (fim !== null && s.kwhInicio !== null) s.kwhTotal = Math.max(Math.round((fim - s.kwhInicio) * 1000) / 1000, 0);
        Object.assign(s, { fim: p.fim, motivoFim: p.motivo, status: 'encerrada' });
      },
      async cancelar(id: string) {
        b.sessoes = b.sessoes.filter((s) => !(s.id === id && s.transactionId === null && s.status === 'ativa'));
      },
      async pedirParada(id: string, motivo: string) { Object.assign(b.sessoes.find((s) => s.id === id)!, { motivoFim: motivo, paradaPedidaEm: new Date() }); },
      async moradorPorTag(plantaId: string | null, tag: string) {
        if (!plantaId) return null; // carregador sem planta não autoriza cartão
        const m = b.moradores.filter((x) => (x.tagUid ?? '').toUpperCase() === tag.trim().toUpperCase() && x.plantaId === plantaId)
          .sort((a, c) => Number(c.ativo) - Number(a.ativo))[0];
        return m ? { id: m.id, nome: m.nome, ativo: m.ativo, validade: m.validade } : null;
      },
      async trilha(equipamentoId: string, mensagem: string, semantico: string, extra: any = {}) {
        b.trilhas.push({ equipamentoId, mensagem, semantico, usuarioId: extra.usuarioId ?? null, status: extra.status, tecnico: extra.tecnico ?? null });
      },
      async abrirFalha(equipamentoId: string, f: any, mensagem: string) {
        b.alarmes.push({ equipamentoId, codigo: f.codigo, ocpp: f.ocpp, mensagem, severidade: f.severidade, resolvido: false });
      },
      async resolverFalhas(equipamentoId: string) {
        b.alarmes.filter((a) => a.equipamentoId === equipamentoId).forEach((a) => { a.resolvido = true; });
      },
    };
    return repo as unknown as CarregadorOcppRepositorio;
  }

  // ---- Prisma do CarregadorEletricoService (só as consultas que ele faz inline) ----
  prisma(): any {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- os objetos abaixo têm `this` próprio
    const b = this;
    const plantaDe = (eid: string) => b.equipamentos.find((e) => e.id === String(eid).trim())?.planta.id ?? null;
    const linhaSessao = (s: Sessao) => ({
      id: s.id, equipamento_id: s.equipamentoId, morador_nome: s.moradorNome, morador_id: s.moradorId, status: s.status, kwh_total: s.kwhTotal,
      tarifa_kwh: s.tarifaKwh, soc_inicio: null, inicio: 'DD/MM HH:MI', fim: s.fim ? 'DD/MM HH:MI' : null,
      inicio_iso: s.inicio.toISOString(), fim_iso: s.fim ? s.fim.toISOString() : null, ocioso_inicio: null, ocioso_por_nome: null, ocioso_min: 0,
      duracao_min: Math.max(Math.floor(((s.fim ?? new Date()).getTime() - s.inicio.getTime()) / 60000), 0),
      limite_tempo_min: s.limiteTempoMin, limite_energia_kwh: s.limiteEnergiaKwh, liberado_por: s.liberadoPor, liberado_por_user: s.liberadoPorUser,
      ocpp_transaction_id: s.transactionId, motivo_fim: s.motivoFim, planta_id: s.plantaId,
    });
    return {
      $queryRaw: async (partes: TemplateStringsArray, ...v: any[]) => {
        const q = partes.join('?').replace(/\s+/g, ' ');
        if (q.includes('pg_try_advisory_lock')) return [{ ok: false }];
        if (q.includes('SELECT TRIM(u.planta_id) AS planta_id')) return [{ planta_id: plantaDe(v[0]) }];
        if (q.includes('LEFT JOIN usuarios u ON TRIM(u.id) =')) {
          const m = b.moradores.find((x) => x.usuarioId === v[0]);
          return m ? [{ id: m.id, nome: m.nome, apartamento: m.apartamento ?? null, planta_id: m.plantaId, validade: m.validade, ativo: m.ativo }] : [];
        }
        if (q.includes('FROM moradores WHERE id=')) {
          const m = b.moradores.find((x) => x.id === String(v[0]).trim());
          return m ? [{ id: m.id, nome: m.nome, ativo: m.ativo, tag_uid: m.tagUid, validade: m.validade }] : [];
        }
        if (q.includes('SELECT morador_id FROM carregador_sessoes WHERE id=')) {
          return b.sessoes.filter((s) => s.id === String(v[0]).trim()).map((s) => ({ morador_id: s.moradorId }));
        }
        if (q.includes('SELECT * FROM carregador_config')) {
          const c = b.configs.get(String(v[0]).trim());
          return c ? [{ tarifa_kwh: c.tarifaKwh, potencia_kw: c.potenciaKw, ultimo_estado: c.ultimoEstado, ultima_leitura_kwh: c.ultimaLeituraKwh, fonte_kwh: 'ocpp', ultimo_soc: null }] : [];
        }
        if (q.includes('FROM carregador_sessoes s LEFT JOIN carregador_config c')) {
          const [eid, , so] = [v[0], v[1], v[2]];
          return b.sessoes
            .filter((s) => (eid == null || s.equipamentoId === eid) && (so == null || s.moradorId === so))
            .sort((a, c) => Number(c.status === 'ativa') - Number(a.status === 'ativa') || c.inicio.getTime() - a.inicio.getTime())
            .map(linhaSessao);
        }
        if (q.includes('FROM carregador_sessoes WHERE TRIM(equipamento_id)=') && q.includes("status='ativa'")) {
          return b.sessoes.filter((s) => s.equipamentoId === String(v[0]).trim() && s.status === 'ativa').map(linhaSessao);
        }
        if (q.includes('SELECT tarifa_kwh FROM carregador_config')) {
          const c = b.configs.get(String(v[0]).trim());
          return c ? [{ tarifa_kwh: c.tarifaKwh }] : [];
        }
        return [];
      },
      $executeRaw: async (partes: TemplateStringsArray, ...v: any[]) => {
        const q = partes.join('?').replace(/\s+/g, ' ');
        if (q.includes('UPDATE carregador_config SET tarifa_kwh=')) b.cfg(String(v[1]).trim()).tarifaKwh = v[0];
        else if (q.includes('INSERT INTO carregador_config (id, equipamento_id, tarifa_kwh)')) b.cfg(String(v[1]).trim()).tarifaKwh = v[2];
        return 1;
      },
      logs_mqtt: {
        create: async ({ data }: any) => {
          b.trilhas.push({ equipamentoId: data.equipamento_id, mensagem: data.mensagem, semantico: data.comando_semantico, usuarioId: data.usuario_id ?? null, status: data.status });
          return { id: b.id() };
        },
      },
    };
  }

  // ---- escopo (ADR 0002) ------------------------------------------------------
  escopo(): any {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- os objetos abaixo têm `this` próprio
    const b = this;
    const global = (u: any) => GLOBAIS.includes(String(u?.role ?? ''));
    const plantas = (u: any) => b.donos.get(String(u?.id ?? '')) ?? [];
    return {
      async assertEntityInScope(tipo: string, id: string, user: any) {
        if (!user || global(user)) return;
        const eq = b.equipamentos.find((e) => e.id === String(id).trim());
        if (tipo !== 'equipamento' || !eq) throw new ForbiddenException('Fora do escopo');
        if (user.role === 'operador') {
          if (!(b.operadores.get(String(user.id)) ?? []).includes(eq.id)) throw new ForbiddenException('Fora do escopo');
          return;
        }
        if (!plantas(user).includes(eq.planta.id)) throw new ForbiddenException('Fora do escopo');
      },
      async getScope(user: any) { return !user || global(user) ? null : plantas(user); },
      isScoped: (e: unknown) => Array.isArray(e),
      async getEquipamentosScope(user: any) { return user?.role === 'operador' ? b.operadores.get(String(user.id)) ?? [] : null; },
      async podeVerValores() { return true; },
    };
  }

  /** AuditoriaAcessosService falso: guarda o registro como iria para `auditoria_acessos`. */
  auditoriaAcessos(): any {
    return { registrar: async (r: any) => { this.auditoria.push(r); } };
  }
}
