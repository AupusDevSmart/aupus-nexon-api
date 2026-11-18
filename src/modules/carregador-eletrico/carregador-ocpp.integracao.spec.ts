import { BadRequestException, ConflictException, ForbiddenException, GatewayTimeoutException, Logger } from '@nestjs/common';
import * as http from 'http';
import { AddressInfo } from 'net';
import { hashChave } from '../ocpp/ocpp-conexao';
import { OcppService } from '../ocpp/ocpp.service';
import { CarregadorSimulado, ERRO, SILENCIO } from '../ocpp/testing/carregador-simulado';
import { CarregadorAuditoriaService } from './carregador-auditoria.service';
import { CarregadorEletricoService } from './carregador-eletrico.service';
import { CarregadorGestaoService } from './carregador-gestao.service';
import { CarregadorOcppService } from './carregador-ocpp.service';
import { BancoMemoria } from './testing/banco-memoria';

/**
 * NEXON-130 — carregador OCPP de ponta a ponta com o carregador SIMULADO: um cliente
 * WebSocket OCPP 1.6-J de verdade fala com a central (OcppService) presa a um servidor
 * HTTP; a ponte, o serviço do carregador e a gestão são os de produção; só o banco é
 * memória. Cobre o critério de pronto do card: comando de quem pode chega ao carregador e
 * gera audit log, quem não pode é recusado, e a leitura da recarga aparece no estado.
 */
const CHAVE = 'aaaabbbbccccdddd0000111122223333';
const ADMIN = { id: 'u-admin', nome: 'Admin Aupus', email: 'admin@aupus.test', role: 'admin' };
const DONO = { id: 'u-dono', nome: 'Dona Planta', email: 'dona@planta.test', role: 'proprietario' };
const OUTRO_DONO = { id: 'u-outro', nome: 'Outro Dono', role: 'proprietario' };
const OPERADOR = { id: 'u-op', nome: 'Porteiro', role: 'operador' };
const OPERADOR_SEM_ACESSO = { id: 'u-op2', nome: 'Operador de fora', role: 'operador' };
const ANA = { id: 'u-ana', nome: 'Ana', role: 'cativo' }; // moradora
const BRUNO = { id: 'u-bruno', nome: 'Bruno', role: 'cativo' }; // morador
const CLIENTE: any = { plataforma: 'Web', aparelho: null, dispositivo: 'Chrome no macOS', ip: '10.0.0.9' };

interface Ambiente {
  banco: BancoMemoria;
  ocpp: OcppService;
  ponte: CarregadorOcppService;
  carregador: CarregadorEletricoService;
  gestao: CarregadorGestaoService;
  url: string;
  /** Carregador simulado já conectado, com boot e conector livre. */
  ligar(): Promise<CarregadorSimulado>;
  assentar(): Promise<void>;
  fechar(): Promise<void>;
}

async function montar(): Promise<Ambiente> {
  const banco = new BancoMemoria();
  banco.novoEquipamento('car-1', 'CAR-01', 'pl-1');
  banco.novoEquipamento('car-2', 'CAR-02', 'pl-2');
  banco.novaEstacao({ equipamentoId: 'car-1', identidade: 'WALLBOX-1', chaveHash: hashChave(CHAVE) });
  banco.moradores.push(
    { id: 'mor-a', nome: 'Ana', apartamento: '101', tagUid: '04A1B2C3', plantaId: 'pl-1', ativo: true, validade: null, usuarioId: 'u-ana' },
    { id: 'mor-b', nome: 'Bruno', apartamento: '202', tagUid: null, plantaId: 'pl-1', ativo: true, validade: null, usuarioId: 'u-bruno' },
    { id: 'mor-c', nome: 'Carla', tagUid: 'BLOQUEADA', plantaId: 'pl-1', ativo: false, validade: null },
    { id: 'mor-d', nome: 'Davi', tagUid: 'VENCIDA', plantaId: 'pl-1', ativo: true, validade: '2020-01-01' },
  );
  banco.donos.set('u-dono', ['pl-1']);
  banco.donos.set('u-outro', ['pl-2']);
  banco.operadores.set('u-op', ['car-1']);

  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const ocpp = new OcppService(banco.repoOcpp(), { httpAdapter: { getHttpServer: () => server } } as any);
  ocpp.timeoutMs = 500;
  const repo = banco.repoCarregador();
  const ponte = new CarregadorOcppService(repo, ocpp);
  ponte.onModuleInit();
  const auditoria = new CarregadorAuditoriaService(banco.auditoriaAcessos());
  const carregador = new CarregadorEletricoService(banco.prisma(), banco.escopo(), {} as any, {} as any, ponte, repo, auditoria);
  const gestao = new CarregadorGestaoService(carregador, ponte, repo, auditoria);
  await ocpp.onApplicationBootstrap();
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ocpp`;
  const simulados: CarregadorSimulado[] = [];
  const assentar = async () => {
    await ocpp.entradaOciosa('WALLBOX-1');
    await ponte.ocioso();
  };
  return {
    banco, ocpp, ponte, carregador, gestao, url, assentar,
    async ligar() {
      const sim = new CarregadorSimulado(`${url}/${CHAVE}/WALLBOX-1`);
      simulados.push(sim);
      await sim.conectar();
      await sim.boot();
      await sim.status('Available');
      await assentar();
      return sim;
    },
    async fechar() {
      await Promise.all(simulados.map((s) => s.fechar().catch(() => undefined)));
      ocpp.onModuleDestroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe('Carregador OCPP com carregador simulado (NEXON-130)', () => {
  let a: Ambiente;
  const antes = process.env.CARREGADOR_VALIDADE;
  beforeAll(() => {
    process.env.CARREGADOR_VALIDADE = 'off';
    Logger.overrideLogger(false); // a central registra cada conexão: fora do relatório dos testes
  });
  afterAll(() => { process.env.CARREGADOR_VALIDADE = antes; });
  beforeEach(async () => { a = await montar(); });
  afterEach(async () => { await a.fechar(); });

  const estado = (user: any = ADMIN) => a.carregador.getEstado('car-1', user);
  const auditorias = (acao?: string) => a.banco.auditoria.filter((r) => !acao || r.acao === acao);
  const comandosRecebidos = (sim: CarregadorSimulado, acao: string) => sim.recebidas.filter((r) => r.acao === acao);

  // ---------------------------------------------------------------------------
  describe('conexão', () => {
    it('recusa quem não tem a chave, quem não está cadastrado e quem não fala ocpp1.6', async () => {
      await expect(new CarregadorSimulado(`${a.url}/WALLBOX-1`).conectar()).rejects.toThrow('HTTP 401');
      await expect(new CarregadorSimulado(`${a.url}/00000000000000000000000000000000/WALLBOX-1`).conectar()).rejects.toThrow('HTTP 401');
      await expect(new CarregadorSimulado(`${a.url}/${CHAVE}/SERIE-QUE-NINGUEM-CADASTROU`).conectar()).rejects.toThrow('HTTP 403');
      await expect(new CarregadorSimulado(`${a.url}/INTRUSO`).conectar()).rejects.toThrow('HTTP 404');
      await expect(new CarregadorSimulado(`${a.url}/${CHAVE}/WALLBOX-1`, { subprotocolo: null }).conectar()).rejects.toThrow('HTTP 400');
      expect(a.ocpp.conectados()).toEqual([]);
      const recusadas = a.ocpp.tentativasRecusadas();
      expect(recusadas.map((r) => r.identidade)).toEqual(['WALLBOX-1', 'INTRUSO', 'SERIE-QUE-NINGUEM-CADASTROU', 'WALLBOX-1', 'WALLBOX-1']);
      expect(recusadas[2].motivo).toContain('WALLBOX-1'); // a chave diz de qual cadastro é
      expect(JSON.stringify(recusadas)).not.toContain(CHAVE);
    });

    it('conecta com a chave na URL e também por HTTP Basic', async () => {
      const porUrl = new CarregadorSimulado(`${a.url}/${CHAVE}/WALLBOX-1`);
      await porUrl.conectar();
      expect(a.ocpp.conectado('wallbox-1')).toBe(true);
      await porUrl.fechar();
      const porBasic = new CarregadorSimulado(`${a.url}/WALLBOX-1`, { basic: { usuario: 'WALLBOX-1', senha: CHAVE } });
      await porBasic.conectar();
      await a.assentar();
      expect(a.banco.estacoes[0]).toMatchObject({ conectado: true, ip: '127.0.0.1' });
      await porBasic.fechar();
    });

    it('boot: aceita, pede heartbeat de 240 s e lê do próprio carregador o que ele suporta', async () => {
      const sim = new CarregadorSimulado(`${a.url}/${CHAVE}/WALLBOX-1`);
      await sim.conectar();
      const r = await sim.boot();
      expect(r).toMatchObject({ status: 'Accepted', interval: 240 });
      expect(Number.isNaN(Date.parse(r.currentTime))).toBe(false);
      expect(await sim.chamar('Heartbeat')).toHaveProperty('currentTime');
      await a.assentar();
      expect(comandosRecebidos(sim, 'GetConfiguration')).toHaveLength(1);
      expect(a.banco.estacoes[0]).toMatchObject({ vendor: 'CHINT', model: 'NTW-EC2A22W1-L', serial: '20260703000025', firmware: '1.0.0', perfis: ['Core', 'SmartCharging', 'RemoteTrigger'] });
      await sim.fechar();
    });

    it('carregador conectado e depois sem conexão: o estado vira "sem comunicação"', async () => {
      const sim = await a.ligar();
      expect(await estado()).toMatchObject({ estado: 'disponivel', fonte_kwh: 'ocpp', ocpp: { conectado: true, disponivel: true, fabricante: 'CHINT' } });
      await sim.fechar();
      await a.assentar();
      expect(await estado()).toMatchObject({ estado: 'sem_comunicacao', ocpp: { conectado: false } });
    });
  });

  // ---------------------------------------------------------------------------
  describe('recarga liberada no NexON', () => {
    it('iniciar, medir e parar: o comando chega ao carregador, a leitura aparece e tudo fica no audit log', async () => {
      const sim = await a.ligar();

      // 1. Quem tem permissão inicia, com limite: sai RemoteStartTransaction para o conector 1.
      const r = await a.carregador.liberarRecarga('car-1', 'mor-b', ADMIN, { limiteEnergiaKwh: 20, cliente: CLIENTE });
      expect(r).toMatchObject({ morador: 'Bruno', aguardando_inicio: true });
      const pedido = await sim.esperar('RemoteStartTransaction');
      expect(pedido.connectorId).toBe(1);
      expect(pedido.idTag).toMatch(/^NX[0-9A-F]{18}$/); // Bruno não tem cartão: tag da recarga
      expect((await estado()).sessao_ativa).toMatchObject({ morador_nome: 'Bruno', aguardando_inicio: true, origem: 'nexon', limite_energia_kwh: 20, limite_tempo_min: null });

      // 2. O carro é conectado: o carregador autoriza a tag e abre a transação.
      expect(await sim.autorizar(pedido.idTag)).toBe('Accepted');
      await sim.status('Preparing');
      const t0 = Date.now() - 180_000;
      const tx = await sim.iniciar(pedido.idTag, 1000, new Date(t0));
      expect(tx.status).toBe('Accepted');
      await sim.status('Charging');

      // 3. Leituras da recarga.
      await sim.medir(tx.transactionId, { energiaWh: 1000, potenciaW: 7150, correnteA: 31.1, tensaoV: 220, temperaturaC: 38 }, new Date(t0 + 60_000));
      await sim.medir(tx.transactionId, { energiaWh: 4250, potenciaW: 7200, correnteA: 31.4, tensaoV: 221, temperaturaC: 41 }, new Date(t0 + 120_000));
      await a.assentar();
      const e = await estado();
      expect(e).toMatchObject({
        estado: 'carregando', fonte_kwh: 'ocpp', ultima_leitura_kwh: 4.25,
        leitura: { potencia_kw: 7.2, corrente_a: 31.4, tensao_v: 221, temperatura_c: 41, energia_sessao_kwh: 3.25 },
        falha: null,
        sessao_ativa: { morador_nome: 'Bruno', kwh_total: 3.25, aguardando_inicio: false },
      });
      expect(e.sessao_ativa.duracao_min).toBeGreaterThanOrEqual(0);
      // A série do equipamento (dados/atual e histórico, que web e apps leem): Pt em W.
      const dado = a.banco.dados[a.banco.dados.length - 1];
      expect(dado).toMatchObject({ equipamentoId: 'car-1', potenciaKw: 7.2, energiaKwh: 3.25 });
      expect(dado.dados).toMatchObject({ Pt: 7200, potencia_kw: 7.2, status: 'carregando', energia_sessao_kwh: 3.25, energia_total_kwh: 4.25, fonte: 'ocpp' });

      // 4. Parar: sai RemoteStopTransaction com a transação certa; fecha quando o carregador confirma.
      const parada = await a.carregador.pararRecarga('car-1', ADMIN, CLIENTE);
      expect(parada).toMatchObject({ ok: true, aguardando_carregador: true });
      expect(await sim.esperar('RemoteStopTransaction')).toEqual({ transactionId: tx.transactionId });
      expect((await estado()).sessao_ativa).not.toBeNull();
      expect(await sim.parar(tx.transactionId, 8500, 'Remote')).toEqual({ idTagInfo: { status: 'Accepted' } });
      await sim.status('Available');
      await a.assentar();
      const fim = await estado();
      expect(fim.sessao_ativa).toBeNull();
      expect(fim.estado).toBe('disponivel');
      expect(fim.sessoes[0]).toMatchObject({ morador_nome: 'Bruno', status: 'encerrada', kwh_total: 7.5, motivo_fim: 'parado_no_nexon', motivo_fim_texto: 'Parada pelo NexON', origem: 'nexon' });
      expect(fim.leitura).toMatchObject({ potencia_kw: 0, energia_sessao_kwh: null }); // sem recarga, sem energia de recarga
      expect(a.banco.transacoes[0]).toMatchObject({ status: 'encerrada', meterStartWh: 1000, meterStopWh: 8500, motivo: 'Remote' });

      // 5. Audit log: quem, o quê, em qual carregador, com a resposta do carregador.
      const [ini, par] = auditorias('carregador_comando');
      expect(ini).toMatchObject({
        acao: 'carregador_comando', autorId: 'u-admin', autorNome: 'Admin Aupus', resultado: 'ok',
        mensagem: 'Recarga iniciada · Bruno · CAR-01 · Eletroposto pl-1 · Planta pl-1',
        objetoTipo: 'carregador', objetoId: 'car-1', plantaIds: ['pl-1'], unidadeIds: ['un-pl-1'], dispositivo: 'Chrome no macOS',
      });
      expect(ini.detalhes).toMatchObject({
        comando: 'iniciar', via: 'ocpp', charge_point_id: 'WALLBOX-1', comando_ocpp: 'RemoteStartTransaction', resposta: 'Accepted',
        morador: { id: 'mor-b', nome: 'Bruno' }, limites: { tempo_min: null, energia_kwh: 20 },
        usuario: { id: 'u-admin', nome: 'Admin Aupus', email: 'admin@aupus.test' }, cliente: { plataforma: 'Web', ip: '10.0.0.9' },
        carregador: { id: 'car-1', nome: 'CAR-01' },
      });
      expect(typeof ini.detalhes.latencia_ms).toBe('number');
      expect(par).toMatchObject({ resultado: 'ok', mensagem: 'Recarga parada · Bruno · CAR-01 · Eletroposto pl-1 · Planta pl-1' });
      expect(par.detalhes).toMatchObject({ comando: 'parar', comando_ocpp: 'RemoteStopTransaction', transaction_id: tx.transactionId, resposta: 'Accepted' });
      // Trilha do carregador (aba Registros).
      expect(a.banco.trilhas.map((t) => t.semantico)).toEqual(
        expect.arrayContaining(['carregador.iniciar', 'carregador.iniciada', 'carregador.parar', 'carregador.encerrada']),
      );
      expect(a.banco.trilhas.find((t) => t.semantico === 'carregador.encerrada')!.mensagem).toBe('Recarga encerrada · Bruno · 7,500 kWh · Parada pelo NexON');
    });

    it('a tag da recarga é descartável e do mesmo grupo do cartão do morador (o cartão dele para a recarga)', async () => {
      const sim = await a.ligar();
      await a.carregador.liberarRecarga('car-1', '', ANA, {});
      const { idTag } = await sim.esperar('RemoteStartTransaction');
      expect(idTag).toMatch(/^NX[0-9A-F]{18}$/); // nunca o cartão: cancelar não deixa autorização válida no carregador
      expect((await sim.chamar('Authorize', { idTag })).idTagInfo).toEqual({ status: 'Accepted', parentIdTag: 'MMORA' });
      expect((await sim.chamar('Authorize', { idTag: '04A1B2C3' })).idTagInfo).toEqual({ status: 'Accepted', parentIdTag: 'MMORA' });
    });

    it('sem potência no MeterValues, a potência sai da energia entre duas leituras', async () => {
      const sim = await a.ligar();
      await a.carregador.liberarRecarga('car-1', 'mor-b', DONO, {});
      const { idTag } = await sim.esperar('RemoteStartTransaction');
      const t0 = Date.now() - 180_000;
      const tx = await sim.iniciar(idTag, 0, new Date(t0));
      await sim.medir(tx.transactionId, { energiaWh: 120 }, new Date(t0 + 60_000)); // 120 Wh em 1 min = 7,2 kW
      await a.assentar();
      expect((await estado()).leitura).toMatchObject({ potencia_kw: 7.2, energia_sessao_kwh: 0.12 });
    });

    it('o carregador recusa o início: 409, a recarga é desfeita e o audit log registra o erro', async () => {
      const sim = await a.ligar();
      sim.responder('RemoteStartTransaction', () => ({ status: 'Rejected' }));
      await expect(a.carregador.liberarRecarga('car-1', 'mor-b', ADMIN, { cliente: CLIENTE })).rejects.toThrow(ConflictException);
      expect(a.banco.sessoes).toHaveLength(0);
      const [reg] = auditorias('carregador_comando');
      expect(reg).toMatchObject({ resultado: 'erro', objetoId: 'car-1' });
      expect(reg.mensagem).toContain('Recarga não iniciada · Bruno');
      expect(reg.detalhes).toMatchObject({ comando: 'iniciar', resposta: 'Rejected', comando_ocpp: 'RemoteStartTransaction' });
    });

    it('carregador sem comunicação: 400, nada é criado e o audit log registra', async () => {
      await expect(a.carregador.liberarRecarga('car-1', 'mor-b', ADMIN, {})).rejects.toThrow(BadRequestException);
      await expect(a.carregador.liberarRecarga('car-1', 'mor-b', ADMIN, {})).rejects.toThrow('Carregador sem comunicação');
      expect(a.banco.sessoes).toHaveLength(0);
      expect(auditorias('carregador_comando')[0]).toMatchObject({ resultado: 'erro' });
    });

    it('carregador não responde: 504 e a recarga é desfeita', async () => {
      const sim = await a.ligar();
      a.ocpp.timeoutMs = 120;
      sim.responder('RemoteStartTransaction', () => SILENCIO);
      await expect(a.carregador.liberarRecarga('car-1', 'mor-b', ADMIN, {})).rejects.toThrow(GatewayTimeoutException);
      expect(a.banco.sessoes).toHaveLength(0);
    });

    it('carregador bloqueado ou em falha não inicia', async () => {
      const sim = await a.ligar();
      await a.gestao.comando('car-1', 'bloquear', DONO, CLIENTE);
      await expect(a.carregador.liberarRecarga('car-1', 'mor-b', DONO, {})).rejects.toThrow('Carregador bloqueado');
      await a.gestao.comando('car-1', 'liberar', DONO, CLIENTE);
      await sim.status('Faulted', { errorCode: 'GroundFailure' });
      await a.assentar();
      await expect(a.carregador.liberarRecarga('car-1', 'mor-b', DONO, {})).rejects.toThrow('Carregador em falha: Falha de aterramento.');
      expect(comandosRecebidos(sim, 'RemoteStartTransaction')).toHaveLength(0);
    });

    it('recarga liberada que não começa em 3 min é cancelada e sai da lista', async () => {
      const sim = await a.ligar();
      await a.carregador.liberarRecarga('car-1', 'mor-b', ADMIN, {});
      await sim.esperar('RemoteStartTransaction');
      await a.ponte.vigiar();
      expect(a.banco.sessoes).toHaveLength(1); // ainda dentro do prazo
      a.ponte.prazoInicioMs = -1;
      await a.ponte.vigiar();
      expect(a.banco.sessoes).toHaveLength(0);
      expect(a.banco.trilhas.some((t) => t.semantico === 'carregador.nao_iniciou')).toBe(true);
      expect((await estado()).sessao_ativa).toBeNull();
    });

    it('parar antes de o carro ser conectado só cancela, sem mandar comando', async () => {
      const sim = await a.ligar();
      await a.carregador.liberarRecarga('car-1', 'mor-b', ADMIN, {});
      await sim.esperar('RemoteStartTransaction');
      expect(await a.carregador.pararRecarga('car-1', ADMIN, CLIENTE)).toMatchObject({ ok: true, cancelada: true });
      expect(a.banco.sessoes).toHaveLength(0);
      expect(comandosRecebidos(sim, 'RemoteStopTransaction')).toHaveLength(0);
      // Se o carregador ainda assim iniciar com a tag cancelada, a central manda parar.
      const { idTag } = sim.recebidas[sim.recebidas.length - 1].payload;
      const tx = await sim.iniciar(idTag, 0);
      expect(tx.status).toBe('Invalid');
      await a.assentar();
      expect(await sim.esperar('RemoteStopTransaction')).toEqual({ transactionId: tx.transactionId });
      expect(a.banco.sessoes).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('permissão (ADR 0002)', () => {
    it('fora do escopo recebe 403 e nenhum comando chega ao carregador', async () => {
      const sim = await a.ligar();
      for (const user of [OUTRO_DONO, OPERADOR_SEM_ACESSO]) {
        await expect(a.carregador.liberarRecarga('car-1', 'mor-b', user, {})).rejects.toThrow(ForbiddenException);
        await expect(a.carregador.pararRecarga('car-1', user)).rejects.toThrow(ForbiddenException);
        await expect(a.carregador.getEstado('car-1', user)).rejects.toThrow(ForbiddenException);
        await expect(a.gestao.comando('car-1', 'bloquear', user)).rejects.toThrow(ForbiddenException);
        await expect(a.gestao.salvarLimites('car-1', { limite_tempo_min: 60 }, user)).rejects.toThrow(ForbiddenException);
        await expect(a.gestao.conexao('car-1', user)).rejects.toThrow(ForbiddenException);
      }
      expect(sim.recebidas.filter((r) => r.acao !== 'GetConfiguration')).toHaveLength(0);
      expect(a.banco.sessoes).toHaveLength(0);
      expect(auditorias()).toHaveLength(0);
    });

    it('proprietário e operador liberado comandam; configuração técnica é só da equipe Aupus', async () => {
      const sim = await a.ligar();
      // Operador com o carregador liberado: inicia, para e bloqueia; não mexe em limite.
      await a.carregador.liberarRecarga('car-1', 'mor-b', OPERADOR, {});
      await sim.esperar('RemoteStartTransaction');
      await a.carregador.pararRecarga('car-1', OPERADOR);
      await expect(a.gestao.comando('car-1', 'atualizar', OPERADOR)).resolves.toMatchObject({ ok: true });
      await expect(a.gestao.salvarLimites('car-1', { limite_tempo_min: 60 }, OPERADOR)).rejects.toThrow(ForbiddenException);
      // Proprietário: limites de uso sim; corrente, reiniciar, conexão e parâmetros não.
      await expect(a.gestao.salvarLimites('car-1', { limite_tempo_min: 60 }, DONO)).resolves.toMatchObject({ limites: { tempo_min: 60 } });
      await expect(a.gestao.salvarLimites('car-1', { limite_corrente_a: 16 }, DONO)).rejects.toThrow(ForbiddenException);
      await expect(a.gestao.comando('car-1', 'reiniciar', DONO)).rejects.toThrow(ForbiddenException);
      await expect(a.gestao.conexao('car-1', DONO)).rejects.toThrow(ForbiddenException);
      await expect(a.gestao.novaChave('car-1', DONO)).rejects.toThrow(ForbiddenException);
      await expect(a.gestao.parametros('car-1', DONO)).rejects.toThrow(ForbiddenException);
      await expect(a.gestao.mudarParametro('car-1', { chave: 'HeartbeatInterval', valor: '60' }, DONO)).rejects.toThrow(ForbiddenException);
      expect(comandosRecebidos(sim, 'SetChargingProfile')).toHaveLength(0);
      expect(comandosRecebidos(sim, 'Reset')).toHaveLength(0);
      expect(comandosRecebidos(sim, 'ChangeConfiguration')).toHaveLength(0);
      // O que a tela recebe para esconder botão.
      expect((await estado(DONO)).pode).toEqual({ comandar: true, limites: true, bloquear: true, tecnico: false });
      expect((await estado(OPERADOR)).pode).toEqual({ comandar: true, limites: false, bloquear: true, tecnico: false });
      expect((await estado(ADMIN)).pode).toEqual({ comandar: true, limites: true, bloquear: true, tecnico: true });
    });

    it('morador só inicia para si e só para a própria recarga; não bloqueia nem mexe em limite', async () => {
      const sim = await a.ligar();
      // Ana pede no nome do Bruno: vale o dela.
      await a.carregador.liberarRecarga('car-1', 'mor-b', ANA, {});
      const { idTag } = await sim.esperar('RemoteStartTransaction');
      const tx = await sim.iniciar(idTag, 0);
      await a.assentar();
      expect(a.banco.sessoes[0]).toMatchObject({ moradorId: 'mor-a', moradorNome: 'Ana', liberadoPor: 'morador' });
      await sim.medir(tx.transactionId, { energiaWh: 2500, potenciaW: 7000 });
      await a.assentar();
      // A energia da recarga aparece para a dona dela e não para outro morador.
      expect((await estado(ANA)).leitura).toMatchObject({ potencia_kw: 7, energia_sessao_kwh: 2.5 });
      expect((await estado(BRUNO)).leitura).toMatchObject({ potencia_kw: 7, energia_sessao_kwh: null });
      await expect(a.carregador.pararRecarga('car-1', BRUNO)).rejects.toThrow('Só quem está carregando pode parar a recarga.');
      expect(comandosRecebidos(sim, 'RemoteStopTransaction')).toHaveLength(0);
      await expect(a.gestao.comando('car-1', 'bloquear', ANA)).rejects.toThrow(ForbiddenException);
      await expect(a.gestao.salvarLimites('car-1', { limite_energia_kwh: 5 }, ANA)).rejects.toThrow(ForbiddenException);
      expect((await estado(ANA)).pode).toEqual({ comandar: true, limites: false, bloquear: false, tecnico: false });
      await a.carregador.pararRecarga('car-1', ANA);
      expect(await sim.esperar('RemoteStopTransaction')).toEqual({ transactionId: tx.transactionId });
    });
  });

  // ---------------------------------------------------------------------------
  describe('limites de uso', () => {
    it('limite de energia: ao atingir, a central manda parar e a recarga fecha com esse motivo', async () => {
      const sim = await a.ligar();
      await a.gestao.salvarLimites('car-1', { limite_energia_kwh: 2 }, DONO, CLIENTE);
      await a.carregador.liberarRecarga('car-1', 'mor-b', DONO, {});
      const { idTag } = await sim.esperar('RemoteStartTransaction');
      const tx = await sim.iniciar(idTag, 500);
      await sim.medir(tx.transactionId, { energiaWh: 1500, potenciaW: 7000 });
      await a.assentar();
      expect(comandosRecebidos(sim, 'RemoteStopTransaction')).toHaveLength(0); // 1 kWh de 2
      await sim.medir(tx.transactionId, { energiaWh: 2600, potenciaW: 7000 });
      await a.assentar();
      expect(await sim.esperar('RemoteStopTransaction')).toEqual({ transactionId: tx.transactionId });
      await a.ponte.vigiar();
      expect(comandosRecebidos(sim, 'RemoteStopTransaction')).toHaveLength(1); // não repete antes de 1 min
      await sim.parar(tx.transactionId, 2610, 'Remote');
      await a.assentar();
      expect(a.banco.sessoes[0]).toMatchObject({ status: 'encerrada', motivoFim: 'limite_energia', kwhTotal: 2.11 });
      expect(a.banco.trilhas.find((t) => t.semantico === 'carregador.limite')!.mensagem).toContain('limite de energia (2 kWh)');
    });

    it('limite de tempo: o vigia manda parar quando o tempo acaba', async () => {
      const sim = await a.ligar();
      await a.carregador.liberarRecarga('car-1', 'mor-b', DONO, { limiteTempoMin: 60 });
      const { idTag } = await sim.esperar('RemoteStartTransaction');
      const tx = await sim.iniciar(idTag, 0, new Date(Date.now() - 59 * 60_000));
      await a.assentar();
      await a.ponte.vigiar();
      expect(comandosRecebidos(sim, 'RemoteStopTransaction')).toHaveLength(0);
      a.banco.sessoes[0].inicio = new Date(Date.now() - 61 * 60_000);
      await a.ponte.vigiar();
      expect(await sim.esperar('RemoteStopTransaction')).toEqual({ transactionId: tx.transactionId });
      await sim.parar(tx.transactionId, 6000, 'Remote');
      await a.assentar();
      expect(a.banco.sessoes[0]).toMatchObject({ status: 'encerrada', motivoFim: 'limite_tempo' });
    });

    it('se o carro sai antes da parada pedida, vale o motivo do carregador', async () => {
      const sim = await a.ligar();
      await a.carregador.liberarRecarga('car-1', 'mor-b', DONO, { limiteTempoMin: 5 });
      const { idTag } = await sim.esperar('RemoteStartTransaction');
      const tx = await sim.iniciar(idTag, 0);
      await a.assentar();
      a.banco.sessoes[0].inicio = new Date(Date.now() - 6 * 60_000);
      await a.ponte.vigiar();
      await sim.parar(tx.transactionId, 300, 'EVDisconnected');
      await a.assentar();
      expect(a.banco.sessoes[0].motivoFim).toBe('desconectado');
    });

    it('o limite pedido ao iniciar nunca passa do padrão do carregador; faixa inválida é recusada', async () => {
      const sim = await a.ligar();
      await a.gestao.salvarLimites('car-1', { limite_tempo_min: 120, limite_energia_kwh: 10 }, DONO, CLIENTE);
      await expect(a.carregador.liberarRecarga('car-1', 'mor-b', DONO, { limiteTempoMin: 2 })).rejects.toThrow('Limite de tempo inválido');
      await expect(a.carregador.liberarRecarga('car-1', 'mor-b', DONO, { limiteEnergiaKwh: 500 })).rejects.toThrow('Limite de energia inválido');
      await a.carregador.liberarRecarga('car-1', 'mor-b', DONO, { limiteTempoMin: 300, limiteEnergiaKwh: 4 });
      await sim.esperar('RemoteStartTransaction');
      expect(a.banco.sessoes[0]).toMatchObject({ limiteTempoMin: 120, limiteEnergiaKwh: 4 });
    });

    it('gravar limites de uso: valida, guarda o antes → depois e audita', async () => {
      await a.ligar();
      await expect(a.gestao.salvarLimites('car-1', { limite_tempo_min: 3 }, DONO)).rejects.toThrow(BadRequestException);
      await expect(a.gestao.salvarLimites('car-1', { limite_energia_kwh: 0 }, DONO)).rejects.toThrow(BadRequestException);
      const r = await a.gestao.salvarLimites('car-1', { limite_tempo_min: 90, limite_energia_kwh: '12,5', inicio_automatico: true }, DONO, CLIENTE);
      expect(r.limites).toEqual({ tempo_min: 90, energia_kwh: 12.5, inicio_automatico: true, corrente_a: null, corrente_min_a: 6, corrente_max_a: 32, corrente_suportada: null });
      expect((await estado(DONO)).limites).toEqual(r.limites);
      const [reg] = auditorias('carregador_config');
      expect(reg).toMatchObject({ autorId: 'u-dono', resultado: 'ok', objetoId: 'car-1' });
      expect(reg.mensagem).toContain('Limites de uso alterados: tempo sem limite → 90 min · energia sem limite → 12,5 kWh · início automático desligado → ligado');
      expect(reg.detalhes).toMatchObject({ antes: { limite_tempo_min: null }, depois: { limite_tempo_min: 90, limite_energia_kwh: 12.5, inicio_automatico: true } });
      // Tirar o limite.
      await a.gestao.salvarLimites('car-1', { limite_tempo_min: null }, DONO, CLIENTE);
      expect((await estado(DONO)).limites).toMatchObject({ tempo_min: null, energia_kwh: 12.5 });
    });

    it('carregador da TON (sem OCPP) não aceita limite', async () => {
      a.banco.donos.set('u-dono', ['pl-1', 'pl-2']);
      await expect(a.gestao.salvarLimites('car-2', { limite_tempo_min: 60 }, DONO)).rejects.toThrow('não está conectado por OCPP');
    });
  });

  // ---------------------------------------------------------------------------
  describe('corrente máxima', () => {
    it('manda o perfil de carga em ampères e grava quando o carregador aceita', async () => {
      const sim = await a.ligar();
      const r = await a.gestao.salvarLimites('car-1', { limite_corrente_a: 16 }, ADMIN, CLIENTE);
      expect(r.limites).toMatchObject({ corrente_a: 16, corrente_suportada: true });
      const perfil = await sim.esperar('SetChargingProfile');
      expect(perfil.connectorId).toBe(1);
      expect(perfil.csChargingProfiles).toMatchObject({ chargingProfilePurpose: 'TxDefaultProfile', chargingSchedule: { chargingRateUnit: 'A', chargingSchedulePeriod: [{ startPeriod: 0, limit: 16 }] } });
      const [reg] = auditorias('carregador_config');
      expect(reg).toMatchObject({ resultado: 'ok', autorId: 'u-admin' });
      expect(reg.mensagem).toContain('Corrente máxima sem limite → 16 A');
      expect(reg.detalhes).toMatchObject({ antes: null, depois: 16, tentativas: [{ pedido: 'SetChargingProfile TxDefaultProfile 16 A', resposta: 'Accepted' }] });
    });

    it('se o carregador recusa o perfil da recarga, tenta o da estação inteira', async () => {
      const sim = await a.ligar();
      sim.responder('SetChargingProfile', (p) => ({ status: p.csChargingProfiles.chargingProfilePurpose === 'ChargePointMaxProfile' ? 'Accepted' : 'Rejected' }));
      await a.gestao.salvarLimites('car-1', { limite_corrente_a: 10 }, ADMIN, CLIENTE);
      const enviados = comandosRecebidos(sim, 'SetChargingProfile').map((x) => [x.payload.connectorId, x.payload.csChargingProfiles.chargingProfilePurpose]);
      expect(enviados).toEqual([[1, 'TxDefaultProfile'], [0, 'ChargePointMaxProfile']]);
      expect(a.banco.configs.get('car-1')).toMatchObject({ limiteCorrenteA: 10, correnteSuportada: true });
    });

    it('carregador sem a função: 409, fica marcado como não suportado e o audit log registra', async () => {
      const sim = await a.ligar();
      sim.responder('SetChargingProfile', () => ERRO('NotSupported'));
      await expect(a.gestao.salvarLimites('car-1', { limite_corrente_a: 16 }, ADMIN, CLIENTE)).rejects.toThrow(ConflictException);
      expect(a.banco.configs.get('car-1')).toMatchObject({ limiteCorrenteA: null, correnteSuportada: false });
      expect((await estado()).limites).toMatchObject({ corrente_a: null, corrente_suportada: false });
      const [reg] = auditorias('carregador_config');
      expect(reg).toMatchObject({ resultado: 'erro' });
      expect(reg.detalhes.tentativas.map((t: any) => t.resposta)).toEqual(['NotSupported', 'NotSupported']);
    });

    it('tirar o limite limpa o perfil; faixa fora de 6 a 32 A é recusada sem falar com o carregador', async () => {
      const sim = await a.ligar();
      await a.gestao.salvarLimites('car-1', { limite_corrente_a: 16 }, ADMIN);
      await a.gestao.salvarLimites('car-1', { limite_corrente_a: null }, ADMIN);
      expect(await sim.esperar('ClearChargingProfile')).toEqual({ id: 130 });
      expect(a.banco.configs.get('car-1')!.limiteCorrenteA).toBeNull();
      const antes = sim.recebidas.length;
      await expect(a.gestao.salvarLimites('car-1', { limite_corrente_a: 5 }, ADMIN)).rejects.toThrow('Corrente inválida');
      await expect(a.gestao.salvarLimites('car-1', { limite_corrente_a: 40 }, ADMIN)).rejects.toThrow('Corrente inválida');
      expect(sim.recebidas.length).toBe(antes);
    });
  });

  // ---------------------------------------------------------------------------
  describe('cartão no carregador e início automático', () => {
    it('cartão de morador: autoriza, abre a recarga no nome dele e aplica os limites padrão', async () => {
      const sim = await a.ligar();
      await a.gestao.salvarLimites('car-1', { limite_tempo_min: 240 }, DONO);
      expect(await sim.autorizar('04a1b2c3')).toBe('Accepted');
      const tx = await sim.iniciar('04A1B2C3', 2000);
      expect(tx.status).toBe('Accepted');
      await sim.medir(tx.transactionId, { energiaWh: 3500, potenciaW: 7000 });
      await a.assentar();
      expect(a.banco.sessoes[0]).toMatchObject({ moradorId: 'mor-a', moradorNome: 'Ana', liberadoPor: 'tag', kwhTotal: 1.5, limiteTempoMin: 240, transactionId: tx.transactionId });
      expect((await estado()).sessao_ativa).toMatchObject({ morador_nome: 'Ana', origem: 'cartao', aguardando_inicio: false });
      await sim.parar(tx.transactionId, 5000, 'Local');
      await a.assentar();
      expect(a.banco.sessoes[0]).toMatchObject({ status: 'encerrada', kwhTotal: 3, motivoFim: 'parado_no_carregador' });
    });

    it('cartão desconhecido, bloqueado ou vencido não carrega: a central manda parar', async () => {
      const sim = await a.ligar();
      expect(await sim.autorizar('NAO-CADASTRADO')).toBe('Invalid');
      expect(await sim.autorizar('BLOQUEADA')).toBe('Blocked');
      expect(await sim.autorizar('VENCIDA')).toBe('Expired');
      const tx = await sim.iniciar('NAO-CADASTRADO', 0);
      expect(tx.status).toBe('Invalid');
      await a.assentar();
      expect(await sim.esperar('RemoteStopTransaction')).toEqual({ transactionId: tx.transactionId });
      expect(a.banco.sessoes).toHaveLength(0);
      expect(a.banco.trilhas.find((t) => t.semantico === 'carregador.cartao_recusado')!.mensagem).toContain('NAO-CADASTRADO');
    });

    it('morador com validade recebe a data de expiração do cartão', async () => {
      const sim = await a.ligar();
      a.banco.moradores[0].validade = '2099-12-31';
      expect((await sim.chamar('Authorize', { idTag: '04A1B2C3' })).idTagInfo).toEqual({ status: 'Accepted', expiryDate: '2100-01-01T03:00:00.000Z', parentIdTag: 'MMORA' });
    });

    it('início automático: carro conectado inicia sozinho, sem morador', async () => {
      const sim = await a.ligar();
      await sim.status('Preparing');
      await a.assentar();
      expect(comandosRecebidos(sim, 'RemoteStartTransaction')).toHaveLength(0); // desligado por padrão
      await sim.status('Available');
      await a.gestao.salvarLimites('car-1', { inicio_automatico: true }, DONO);
      await sim.status('Preparing');
      await a.assentar();
      expect(await sim.esperar('RemoteStartTransaction')).toEqual({ idTag: 'NEXON-AUTO', connectorId: 1 });
      const tx = await sim.iniciar('NEXON-AUTO', 100);
      expect(tx.status).toBe('Accepted');
      await a.assentar();
      expect(a.banco.sessoes[0]).toMatchObject({ moradorId: null, moradorNome: 'Sem identificação', liberadoPor: 'automatico' });
      expect((await estado()).sessao_ativa).toMatchObject({ origem: 'automatico' });
    });
  });

  // ---------------------------------------------------------------------------
  describe('falha e alarme', () => {
    it('falha com o código do manual: estado, descrição, alarme aberto e normalizado', async () => {
      const sim = await a.ligar();
      await sim.status('Faulted', { errorCode: 'OtherError', vendorErrorCode: 'E07', info: 'Emergency stop' });
      await a.assentar();
      const e = await estado();
      expect(e.estado).toBe('falha');
      expect(e.falha).toMatchObject({ codigo: 'E07', ocpp: 'OtherError', titulo: 'Botão de parada de emergência pressionado', solucao: 'Girar o botão de emergência no sentido indicado para liberar.' });
      expect(Number.isNaN(Date.parse(e.falha.desde))).toBe(false);
      expect(a.banco.alarmes).toEqual([{ equipamentoId: 'car-1', codigo: 'E07', ocpp: 'OtherError', mensagem: 'Falha no carregador · E07 · Botão de parada de emergência pressionado', severidade: 'CRITICA', resolvido: false }]);
      // Repetir o mesmo status não abre outro alarme.
      await sim.status('Faulted', { errorCode: 'OtherError', vendorErrorCode: 'E07' });
      await a.assentar();
      expect(a.banco.alarmes).toHaveLength(1);
      await sim.status('Available');
      await a.assentar();
      expect((await estado()).falha).toBeNull();
      expect(a.banco.alarmes[0].resolvido).toBe(true);
      expect(a.banco.trilhas.map((t) => t.semantico)).toEqual(expect.arrayContaining(['carregador.falha', 'carregador.falha_normalizada']));
    });

    it('status da estação inteira (conector 0) não apaga o estado do conector', async () => {
      const sim = await a.ligar();
      await sim.status('Charging');
      await sim.status('Available', { connectorId: 0 });
      await a.assentar();
      expect((await estado()).estado).toBe('carregando');
      await sim.status('Unavailable', { connectorId: 0 });
      await a.assentar();
      expect((await estado()).estado).toBe('indisponivel');
      await sim.status('Charging', { connectorId: 2 }); // outro conector: ignorado
      await a.assentar();
      expect((await estado()).estado).toBe('indisponivel');
    });
  });

  // ---------------------------------------------------------------------------
  describe('robustez do protocolo', () => {
    it('StartTransaction repetido devolve a mesma transação e não duplica a recarga', async () => {
      const sim = await a.ligar();
      const quando = new Date(Date.now() - 30_000);
      const t1 = await sim.iniciar('04A1B2C3', 100, quando);
      const t2 = await sim.iniciar('04A1B2C3', 100, quando);
      await a.assentar();
      expect(t2.transactionId).toBe(t1.transactionId);
      expect(a.banco.sessoes).toHaveLength(1);
      expect(a.banco.transacoes).toHaveLength(1);
    });

    it('StopTransaction repetido ou de transação desconhecida é aceito e não mexe em nada', async () => {
      const sim = await a.ligar();
      const tx = await sim.iniciar('04A1B2C3', 0);
      await sim.parar(tx.transactionId, 1000, 'Local');
      expect(await sim.parar(tx.transactionId, 9999, 'Local')).toEqual({ idTagInfo: { status: 'Accepted' } });
      expect(await sim.parar(987654, 10, 'Local')).toEqual({ idTagInfo: { status: 'Accepted' } });
      await a.assentar();
      expect(a.banco.sessoes).toHaveLength(1);
      expect(a.banco.sessoes[0]).toMatchObject({ status: 'encerrada', kwhTotal: 1 });
    });

    it('recarga que ficou aberta com o conector livre é fechada; se o fim chegar depois, a conta é corrigida', async () => {
      const sim = await a.ligar();
      const tx = await sim.iniciar('04A1B2C3', 0, new Date(Date.now() - 10 * 60_000));
      await sim.medir(tx.transactionId, { energiaWh: 800 }, new Date(Date.now() - 9 * 60_000));
      await sim.status('Available', { timestamp: new Date(Date.now() - 3 * 60_000).toISOString() });
      await a.assentar();
      await a.ponte.vigiar();
      expect(a.banco.sessoes[0]).toMatchObject({ status: 'encerrada', motivoFim: 'sem_confirmacao', kwhTotal: 0.8 });
      // O carregador segue medindo a mesma transação: a recarga não tinha acabado, reabre.
      await sim.medir(tx.transactionId, { energiaWh: 1000 });
      await a.assentar();
      expect(a.banco.sessoes[0]).toMatchObject({ status: 'ativa', motivoFim: null, kwhTotal: 1 });
      expect(a.banco.trilhas.some((t) => t.semantico === 'carregador.reaberta')).toBe(true);
      // E se o fim chega só depois de fechada de novo, a conta é corrigida com a leitura final.
      await a.ponte.vigiar();
      expect(a.banco.sessoes[0].status).toBe('ativa'); // leitura depois do "livre": a transação está viva
      a.banco.estacoes[0].leituraEm = new Date(Date.now() - 5 * 60_000); // passou o tempo sem leitura nova
      await a.ponte.vigiar();
      expect(a.banco.sessoes[0]).toMatchObject({ status: 'encerrada', motivoFim: 'sem_confirmacao' });
      await sim.parar(tx.transactionId, 1200, 'EVDisconnected');
      await a.assentar();
      expect(a.banco.sessoes[0]).toMatchObject({ status: 'encerrada', motivoFim: 'desconectado', kwhTotal: 1.2 });
    });

    it('responde com o erro OCPP certo ao que não entende e segue funcionando', async () => {
      const sim = await a.ligar();
      await expect(sim.chamar('AcaoInventada', {})).rejects.toMatchObject({ codigo: 'NotImplemented' });
      await expect(sim.chamar('StartTransaction', { connectorId: 1 })).rejects.toMatchObject({ codigo: 'OccurenceConstraintViolation' });
      await expect(sim.chamar('StatusNotification', { connectorId: 'um', errorCode: 'NoError', status: 'Available' })).rejects.toMatchObject({ codigo: 'TypeConstraintViolation' });
      expect(await sim.chamar('DataTransfer', { vendorId: 'CHINT', data: 'x' })).toEqual({ status: 'UnknownVendorId' });
      expect(await sim.chamar('FirmwareStatusNotification', { status: 'Installed' })).toEqual({});
      sim.cru('isto não é json');
      sim.cru('[3,"resposta-de-nada",{}]');
      expect(await sim.chamar('Heartbeat')).toHaveProperty('currentTime');
      expect(sim.conectado).toBe(true);
    });

    it('reconexão sem fechar a anterior: vale a conexão nova', async () => {
      const velho = await a.ligar();
      const novo = new CarregadorSimulado(`${a.url}/${CHAVE}/WALLBOX-1`);
      await novo.conectar();
      await novo.boot();
      await a.assentar();
      await a.gestao.comando('car-1', 'atualizar', ADMIN);
      expect(comandosRecebidos(novo, 'TriggerMessage')).toHaveLength(2);
      expect(comandosRecebidos(velho, 'TriggerMessage')).toHaveLength(0);
      expect(a.ocpp.conectado('WALLBOX-1')).toBe(true);
      await novo.fechar();
    });
  });

  // ---------------------------------------------------------------------------
  describe('comandos', () => {
    it('bloquear e liberar: ChangeAvailability, estado guardado e audit log', async () => {
      const sim = await a.ligar();
      expect(await a.gestao.comando('car-1', 'bloquear', DONO, CLIENTE)).toEqual({ ok: true, resposta: 'Accepted', mensagem: 'Carregador bloqueado.' });
      expect(await sim.esperar('ChangeAvailability')).toEqual({ connectorId: 0, type: 'Inoperative' });
      expect((await estado(DONO)).ocpp.disponivel).toBe(false);
      await a.gestao.comando('car-1', 'liberar', DONO, CLIENTE);
      expect(await sim.esperar('ChangeAvailability')).toEqual({ connectorId: 0, type: 'Operative' });
      expect((await estado(DONO)).ocpp.disponivel).toBe(true);
      const regs = auditorias('carregador_comando');
      expect(regs.map((r) => [r.mensagem, r.resultado, r.detalhes.comando_ocpp])).toEqual([
        ['Carregador bloqueado · CAR-01 · Eletroposto pl-1 · Planta pl-1', 'ok', 'ChangeAvailability Inoperative'],
        ['Carregador liberado · CAR-01 · Eletroposto pl-1 · Planta pl-1', 'ok', 'ChangeAvailability Operative'],
      ]);
    });

    it('bloqueio agendado para o fim da recarga também vale', async () => {
      const sim = await a.ligar();
      sim.responder('ChangeAvailability', () => ({ status: 'Scheduled' }));
      expect(await a.gestao.comando('car-1', 'bloquear', DONO)).toMatchObject({ resposta: 'Scheduled', mensagem: 'Carregador será bloqueado ao fim da recarga em andamento.' });
      expect(a.banco.estacoes[0].disponivel).toBe(false);
    });

    it('destravar, atualizar e reiniciar (este só para a equipe Aupus)', async () => {
      const sim = await a.ligar();
      expect(await a.gestao.comando('car-1', 'destravar', OPERADOR)).toMatchObject({ resposta: 'Unlocked' });
      expect(await sim.esperar('UnlockConnector')).toEqual({ connectorId: 1 });
      await a.gestao.comando('car-1', 'atualizar', OPERADOR);
      expect(comandosRecebidos(sim, 'TriggerMessage').map((x) => x.payload.requestedMessage)).toEqual(['StatusNotification', 'MeterValues']);
      expect(await a.gestao.comando('car-1', 'reiniciar', ADMIN, CLIENTE)).toMatchObject({ resposta: 'Accepted' });
      expect(await sim.esperar('Reset')).toEqual({ type: 'Soft' });
    });

    it('carregador recusa, não tem a função ou está sem conexão: erro claro e audit log com o resultado', async () => {
      const sim = await a.ligar();
      sim.responder('UnlockConnector', () => ({ status: 'UnlockFailed' }));
      await expect(a.gestao.comando('car-1', 'destravar', DONO, CLIENTE)).rejects.toThrow('o carregador não conseguiu destravar (resposta: UnlockFailed)');
      sim.responder('TriggerMessage', () => ERRO('NotImplemented'));
      await expect(a.gestao.comando('car-1', 'atualizar', DONO, CLIENTE)).rejects.toThrow('O carregador não aceitou o comando (NotImplemented).');
      await expect(a.gestao.comando('car-1', 'explodir', DONO)).rejects.toThrow('Comando desconhecido.');
      await sim.fechar();
      await a.assentar();
      await expect(a.gestao.comando('car-1', 'bloquear', DONO, CLIENTE)).rejects.toThrow('Carregador sem comunicação');
      expect(auditorias('carregador_comando').map((r) => r.resultado)).toEqual(['erro', 'erro', 'erro']);
      expect(auditorias('carregador_comando')[0].detalhes).toMatchObject({ comando: 'destravar', resposta: 'UnlockFailed' });
    });
  });

  // ---------------------------------------------------------------------------
  describe('conexão OCPP e parâmetros (equipe Aupus)', () => {
    it('vincular gera a chave uma vez; o carregador conecta com ela', async () => {
      a.banco.donos.set('u-dono', ['pl-1', 'pl-2']);
      expect(await a.gestao.conexao('car-2', ADMIN)).toMatchObject({ vinculado: false, charge_point_id: null, conectado: false });
      await expect(a.gestao.vincular('car-2', { charge_point_id: 'com espaço' }, ADMIN)).rejects.toThrow('Identidade inválida');
      await expect(a.gestao.vincular('car-2', { charge_point_id: 'wallbox-1' }, ADMIN)).rejects.toThrow('já está ligada a outro carregador');
      const r: any = await a.gestao.vincular('car-2', { charge_point_id: '20260703000025' }, ADMIN, CLIENTE);
      expect(r.chave).toMatch(/^[0-9a-f]{32}$/);
      expect(r.url).toBe(`wss://aupus-nexon-api.aupusenergia.com.br/ocpp/${r.chave}`);
      expect(r.url_completa).toBe(`wss://aupus-nexon-api.aupusenergia.com.br/ocpp/${r.chave}/20260703000025`);
      expect(JSON.stringify(a.banco.estacoes)).not.toContain(r.chave); // só o hash
      const sim = new CarregadorSimulado(`${a.url}/${r.chave}/20260703000025`);
      await sim.conectar();
      await sim.boot();
      await a.ocpp.entradaOciosa('20260703000025');
      await a.ponte.ocioso();
      expect(await a.gestao.conexao('car-2', ADMIN)).toMatchObject({ vinculado: true, charge_point_id: '20260703000025', conectado: true, fabricante: 'CHINT', modelo: 'NTW-EC2A22W1-L', perfis: ['Core', 'SmartCharging', 'RemoteTrigger'] });
      // Trocar a identidade não mostra chave de novo.
      const de_novo: any = await a.gestao.vincular('car-2', { charge_point_id: '20260703000025' }, ADMIN, CLIENTE);
      expect(de_novo.chave).toBeUndefined();
      const [reg] = auditorias('carregador_ocpp');
      expect(reg).toMatchObject({ resultado: 'ok', objetoId: 'car-2', mensagem: 'Carregador vinculado por OCPP · identidade 20260703000025 · CAR-02 · Eletroposto pl-2 · Planta pl-2' });
      expect(JSON.stringify(a.banco.auditoria)).not.toContain(r.chave);
      await sim.fechar();
    });

    it('chave nova derruba a conexão e a antiga deixa de valer; desvincular fecha a porta', async () => {
      const sim = await a.ligar();
      const r = await a.gestao.novaChave('car-1', ADMIN, CLIENTE);
      await new Promise((ok) => setTimeout(ok, 50));
      expect(sim.conectado).toBe(false);
      await expect(new CarregadorSimulado(`${a.url}/${CHAVE}/WALLBOX-1`).conectar()).rejects.toThrow('HTTP 401');
      const novo = new CarregadorSimulado(`${a.url}/${r.chave}/WALLBOX-1`);
      await novo.conectar();
      await a.assentar();
      await a.gestao.desvincular('car-1', ADMIN, CLIENTE);
      await new Promise((ok) => setTimeout(ok, 50));
      expect(novo.conectado).toBe(false);
      await expect(new CarregadorSimulado(`${a.url}/${r.chave}/WALLBOX-1`).conectar()).rejects.toThrow('HTTP 404');
      expect((await estado()).ocpp).toBeNull(); // voltou a ser carregador sem OCPP
      expect(auditorias('carregador_ocpp').map((x) => x.detalhes.operacao)).toEqual(['chave', 'desvinculo']);
    });

    it('não desvincula nem troca a identidade com recarga em andamento', async () => {
      const sim = await a.ligar();
      await sim.iniciar('04A1B2C3', 0);
      await a.assentar();
      await expect(a.gestao.desvincular('car-1', ADMIN)).rejects.toThrow('Há recarga em andamento');
      await expect(a.gestao.vincular('car-1', { charge_point_id: 'OUTRA' }, ADMIN)).rejects.toThrow('Há recarga em andamento');
    });

    it('parâmetros: lê a lista do próprio carregador e altera com audit log', async () => {
      const sim = await a.ligar();
      const p = await a.gestao.parametros('car-1', ADMIN);
      expect(p.parametros).toEqual([
        { chave: 'MeterValueSampleInterval', valor: '60', somente_leitura: false },
        { chave: 'NumberOfConnectors', valor: '1', somente_leitura: true },
        { chave: 'SupportedFeatureProfiles', valor: 'Core,SmartCharging,RemoteTrigger', somente_leitura: true },
      ]);
      expect(await a.gestao.mudarParametro('car-1', { chave: 'MeterValueSampleInterval', valor: '30' }, ADMIN, CLIENTE)).toEqual({ resposta: 'Accepted' });
      expect(await sim.esperar('ChangeConfiguration')).toEqual({ key: 'MeterValueSampleInterval', value: '30' });
      sim.responder('ChangeConfiguration', () => ({ status: 'Rejected' }));
      expect(await a.gestao.mudarParametro('car-1', { chave: 'NumberOfConnectors', valor: '2' }, ADMIN, CLIENTE)).toEqual({ resposta: 'Rejected' });
      await expect(a.gestao.mudarParametro('car-1', { chave: 'AuthorizationKey', valor: 'x' }, ADMIN)).rejects.toThrow('Gerar nova chave');
      await expect(a.gestao.mudarParametro('car-1', { chave: '', valor: 'x' }, ADMIN)).rejects.toThrow(BadRequestException);
      expect(auditorias('carregador_ocpp').map((r) => [r.detalhes.parametro, r.detalhes.resposta, r.resultado])).toEqual([
        ['MeterValueSampleInterval', 'Accepted', 'ok'],
        ['NumberOfConnectors', 'Rejected', 'erro'],
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  describe('integridade da recarga (revisão)', () => {
    it('um carregador não fecha nem altera a recarga de outro: a transação vale só no carregador dela', async () => {
      const sim = await a.ligar();
      const chaveB = 'bbbbccccddddeeee1111222233334444';
      a.banco.novaEstacao({ equipamentoId: 'car-2', identidade: 'WALLBOX-2', chaveHash: hashChave(chaveB), plantaId: 'pl-2' });
      await a.ocpp.recarregarCadastro();
      const outro = new CarregadorSimulado(`${a.url}/${chaveB}/WALLBOX-2`);
      await outro.conectar();
      await outro.boot();
      const tx = await sim.iniciar('04A1B2C3', 1000);
      await sim.medir(tx.transactionId, { energiaWh: 2000, potenciaW: 7000 });
      await a.assentar();
      // O outro carregador manda leitura e fim com o número da transação do primeiro.
      await outro.medir(tx.transactionId, { energiaWh: 900_000, potenciaW: 1 });
      expect(await outro.parar(tx.transactionId, 999_999, 'Local')).toEqual({ idTagInfo: { status: 'Accepted' } });
      await a.ocpp.entradaOciosa('WALLBOX-2');
      await a.ponte.ocioso();
      expect(a.banco.sessoes).toHaveLength(1);
      expect(a.banco.sessoes[0]).toMatchObject({ equipamentoId: 'car-1', status: 'ativa', kwhTotal: 1 });
      expect(a.banco.transacoes[0]).toMatchObject({ status: 'ativa', meterStopWh: null });
      await outro.fechar();
    });

    it('StartTransaction em outro conector da estação não vira recarga deste carregador', async () => {
      const sim = await a.ligar();
      const r = await sim.chamar('StartTransaction', { connectorId: 2, idTag: '04A1B2C3', meterStart: 0, timestamp: new Date().toISOString() });
      expect(r.transactionId).toBeGreaterThan(0);
      await a.assentar();
      expect(a.banco.sessoes).toHaveLength(0);
    });

    it('reinício da API com recarga em andamento não fecha a recarga; só fecha quem sumiu de verdade há 24 h', async () => {
      const repo = a.banco.repoCarregador();
      await repo.criarSessao({
        equipamentoId: 'car-1', plantaId: 'pl-1', moradorId: 'mor-a', moradorNome: 'Ana', inicio: new Date(Date.now() - 3_600_000), kwhInicio: 0,
        liberadoPor: 'tag', liberadoPorUser: 'cartão no carregador', tarifaKwh: 1, socInicio: null, transactionId: 77, idTag: '04A1B2C3',
        limiteTempoMin: null, limiteEnergiaKwh: null,
      });
      const estacao = a.banco.estacoes[0];
      // Estado que o processo anterior deixou: "conectado", com uma queda antiga registrada.
      Object.assign(estacao, { conectado: true, ultimaConexao: new Date(Date.now() - 5 * 3_600_000), ultimaDesconexao: new Date(Date.now() - 3 * 86_400_000) });
      await a.banco.repoOcpp().marcarTodasDesconectadas(); // o que o boot da API faz
      await a.ponte.vigiar();
      expect(a.banco.sessoes[0].status).toBe('ativa');
      // Mesmo sem o boot marcar (queda do processo): vale o contato mais recente, não a queda antiga.
      Object.assign(estacao, { conectado: false, ultimaConexao: new Date(Date.now() - 3_600_000), ultimaDesconexao: new Date(Date.now() - 3 * 86_400_000) });
      await a.ponte.vigiar();
      expect(a.banco.sessoes[0].status).toBe('ativa');
      // Sem contato nenhum há mais de 24 h: fecha com a última leitura.
      Object.assign(estacao, { ultimaConexao: new Date(Date.now() - 30 * 3_600_000), ultimaDesconexao: new Date(Date.now() - 25 * 3_600_000) });
      await a.ponte.vigiar();
      expect(a.banco.sessoes[0]).toMatchObject({ status: 'encerrada', motivoFim: 'sem_confirmacao' });
    });

    it('queda de energia: o carregador retoma com a mesma tag e a recarga continua no nome do morador, com os limites', async () => {
      const sim = await a.ligar();
      await a.carregador.liberarRecarga('car-1', 'mor-b', DONO, { limiteEnergiaKwh: 20 });
      const { idTag } = await sim.esperar('RemoteStartTransaction');
      const t1 = await sim.iniciar(idTag, 0);
      await sim.parar(t1.transactionId, 3000, 'PowerLoss');
      await a.assentar();
      expect(a.banco.sessoes[0]).toMatchObject({ status: 'encerrada', motivoFim: 'queda_energia', kwhTotal: 3 });
      const t2 = await sim.iniciar(idTag, 3000);
      expect(t2.status).toBe('Accepted');
      await a.assentar();
      expect(comandosRecebidos(sim, 'RemoteStopTransaction')).toHaveLength(0);
      expect(a.banco.sessoes[1]).toMatchObject({ status: 'ativa', moradorId: 'mor-b', moradorNome: 'Bruno', limiteEnergiaKwh: 20, liberadoPor: 'porteiro', transactionId: t2.transactionId });
      // Recarga parada por alguém não é retomada: a tag dela deixa de valer.
      await a.carregador.pararRecarga('car-1', DONO);
      await sim.parar(t2.transactionId, 4000, 'Remote');
      await a.assentar();
      expect((await sim.iniciar(idTag, 4000)).status).toBe('Invalid');
    });

    it('cartão recusado: a central insiste em parar até o carregador obedecer', async () => {
      const sim = await a.ligar();
      sim.responder('RemoteStopTransaction', () => ({ status: 'Rejected' }));
      const tx = await sim.iniciar('NAO-CADASTRADO', 0);
      await a.assentar();
      expect(comandosRecebidos(sim, 'RemoteStopTransaction')).toHaveLength(1);
      await a.ponte.vigiar();
      expect(comandosRecebidos(sim, 'RemoteStopTransaction')).toHaveLength(2);
      await sim.parar(tx.transactionId, 5, 'Remote');
      await a.assentar();
      await a.ponte.vigiar();
      expect(comandosRecebidos(sim, 'RemoteStopTransaction')).toHaveLength(2); // parou: não insiste mais
      expect(a.banco.sessoes).toHaveLength(0);
    });

    it('limite de energia sem leitura do carregador: avisa na trilha, uma vez', async () => {
      const sim = await a.ligar();
      await a.carregador.liberarRecarga('car-1', 'mor-b', DONO, { limiteEnergiaKwh: 10 });
      const { idTag } = await sim.esperar('RemoteStartTransaction');
      await sim.iniciar(idTag, 0, new Date(Date.now() - 11 * 60_000));
      await a.assentar();
      await a.ponte.vigiar();
      await a.ponte.vigiar();
      const avisos = a.banco.trilhas.filter((t) => t.semantico === 'carregador.sem_leitura');
      expect(avisos).toHaveLength(1);
      expect(avisos[0].mensagem).toContain('MeterValueSampleInterval');
    });

    it('carregador sem leitura periódica (intervalo 0): avisa ao conectar, sem mudar o carregador sozinho', async () => {
      const sim = new CarregadorSimulado(`${a.url}/${CHAVE}/WALLBOX-1`);
      sim.responder('GetConfiguration', () => ({ configurationKey: [{ key: 'MeterValueSampleInterval', readonly: false, value: '0' }] }));
      await sim.conectar();
      await sim.boot();
      await a.assentar();
      expect(a.banco.trilhas.some((t) => t.semantico === 'carregador.sem_leitura')).toBe(true);
      expect(comandosRecebidos(sim, 'ChangeConfiguration')).toHaveLength(0);
      await sim.fechar();
    });

    it('carregador comandado pela TON (MQTT) não é vinculado por OCPP', async () => {
      a.banco.equipamentos[1].mqtt = true;
      await expect(a.gestao.vincular('car-2', { charge_point_id: 'NOVO-CP' }, ADMIN)).rejects.toThrow('comandado pela TON');
      expect(a.banco.estacoes).toHaveLength(1);
    });

    it('valor de parâmetro com segredo chega ao carregador, mas não vai inteiro para a trilha nem para o audit log', async () => {
      const sim = await a.ligar();
      const url = `wss://plataforma.test/ocpp/${CHAVE}/WALLBOX-1`;
      await a.gestao.mudarParametro('car-1', { chave: 'CentralSystemUrl', valor: url }, ADMIN, CLIENTE);
      expect(await sim.esperar('ChangeConfiguration')).toEqual({ key: 'CentralSystemUrl', value: url });
      await a.gestao.mudarParametro('car-1', { chave: 'WifiPassword', valor: 'segredo123' }, ADMIN, CLIENTE);
      const guardado = JSON.stringify([a.banco.auditoria, a.banco.trilhas]);
      expect(guardado).not.toContain(CHAVE);
      expect(guardado).not.toContain('segredo123');
      expect(auditorias('carregador_ocpp').map((r) => r.detalhes.valor)).toEqual(['•••', '•••']);
      // Parâmetro padrão do OCPP fica com o valor.
      await a.gestao.mudarParametro('car-1', { chave: 'HeartbeatInterval', valor: '120' }, ADMIN, CLIENTE);
      expect(auditorias('carregador_ocpp')[2].detalhes.valor).toBe('120');
    });

    it('papel sem nome com a planta no escopo inicia e para, mas não bloqueia nem mexe em limite', async () => {
      const sim = await a.ligar();
      const SEM_NOME = { id: 'u-cativo', nome: 'Cativo', role: 'cativo' };
      a.banco.donos.set('u-cativo', ['pl-1']);
      expect((await a.carregador.getEstado('car-1', SEM_NOME)).pode).toEqual({ comandar: true, limites: false, bloquear: false, tecnico: false });
      await expect(a.gestao.comando('car-1', 'bloquear', SEM_NOME)).rejects.toThrow(ForbiddenException);
      await expect(a.gestao.salvarLimites('car-1', { limite_tempo_min: 60 }, SEM_NOME)).rejects.toThrow(ForbiddenException);
      await expect(a.gestao.conexao('car-1', SEM_NOME)).rejects.toThrow(ForbiddenException);
      expect(comandosRecebidos(sim, 'ChangeAvailability')).toHaveLength(0);
      await a.carregador.liberarRecarga('car-1', 'mor-b', SEM_NOME, {}); // como já era
      await sim.esperar('RemoteStartTransaction');
    });

    it('carregador sem planta: nenhum cartão autoriza e o vínculo é recusado', async () => {
      const sim = await a.ligar();
      a.banco.estacoes[0].plantaId = null;
      await a.ocpp.recarregarCadastro();
      await sim.fechar();
      const de_novo = new CarregadorSimulado(`${a.url}/${CHAVE}/WALLBOX-1`);
      await de_novo.conectar();
      expect(await de_novo.autorizar('04A1B2C3')).toBe('Invalid');
      await de_novo.fechar();
      a.banco.novoEquipamento('car-3', 'CAR-03', '');
      await expect(a.gestao.vincular('car-3', { charge_point_id: 'SEM-PLANTA' }, ADMIN)).rejects.toThrow('instalação sem planta');
    });

    it('histórico bruto acompanha a estação: identidade reaproveitada por outro carregador não herda as transações', async () => {
      const sim = await a.ligar();
      const tx = await sim.iniciar('04A1B2C3', 0);
      await sim.parar(tx.transactionId, 1000, 'Local');
      await a.assentar();
      await a.gestao.desvincular('car-1', ADMIN, CLIENTE);
      expect(a.banco.transacoes[0].cp).not.toBe('WALLBOX-1');
      await a.gestao.vincular('car-2', { charge_point_id: 'WALLBOX-1' }, ADMIN, CLIENTE);
      expect(a.banco.transacoes.filter((t) => t.cp === 'WALLBOX-1')).toHaveLength(0);
    });

    it('registrador com fração e tag longa no fim não travam a recarga', async () => {
      const sim = await a.ligar();
      const r = await sim.chamar('StartTransaction', { connectorId: 1, idTag: '04A1B2C3', meterStart: 1000.4, timestamp: new Date().toISOString() });
      expect(await sim.chamar('StopTransaction', { transactionId: r.transactionId, meterStop: '2500.6', idTag: 'X'.repeat(30), reason: 'Local' }))
        .toEqual({ idTagInfo: { status: 'Accepted' } });
      await a.assentar();
      expect(a.banco.sessoes[0]).toMatchObject({ status: 'encerrada', kwhTotal: 1.501 });
    });
  });
});
