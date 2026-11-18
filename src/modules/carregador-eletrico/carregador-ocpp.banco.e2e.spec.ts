import { Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as http from 'http';
import { AddressInfo } from 'net';
import { AuditoriaAcessosService } from '../../core/modules/usuarios/auditoria-acessos.service';
import { OcppController } from '../ocpp/ocpp.controller';
import { OcppRepositorio } from '../ocpp/ocpp.repositorio';
import { OcppService } from '../ocpp/ocpp.service';
import { CarregadorSimulado } from '../ocpp/testing/carregador-simulado';
import { CarregadorAuditoriaService } from './carregador-auditoria.service';
import { CarregadorEletricoService } from './carregador-eletrico.service';
import { CarregadorGestaoService } from './carregador-gestao.service';
import { grupoDoMorador } from './carregador-ocpp.regras';
import { CarregadorOcppRepositorio } from './carregador-ocpp.repositorio';
import { CarregadorOcppService } from './carregador-ocpp.service';

/**
 * NEXON-130 — ensaio do carregador OCPP contra um Postgres DE VERDADE: o mesmo ciclo dos
 * testes com banco em memória, agora passando por todo o SQL de produção (repositórios,
 * `/estado`, lista, exportação, auditoria). O carregador é o simulado.
 *
 * Só roda com `ENSAIO_OCPP_DATABASE_URL` apontando para um banco DESCARTÁVEL com o esquema
 * (prisma db push + SQL manual do carregador e do OCPP). Nunca use o banco de produção:
 * o ensaio grava e apaga linhas, e a auditoria é só-inserção.
 *
 *   ENSAIO_OCPP_DATABASE_URL=postgresql://postgres:pg@127.0.0.1:55440/postgres \
 *     npx jest --testPathIgnorePatterns='[]' src/modules/carregador-eletrico/carregador-ocpp.banco.e2e.spec.ts
 */
const URL_BANCO = process.env.ENSAIO_OCPP_DATABASE_URL;
const ADMIN = { id: 'ensaio-admin', nome: 'Ensaio Admin', email: 'ensaio@aupus.test', role: 'admin' };
const CLIENTE: any = { plataforma: 'Web', aparelho: null, dispositivo: 'Ensaio', ip: '127.0.0.1' };
const escopoAdmin: any = {
  assertEntityInScope: async () => undefined,
  getScope: async () => null,
  isScoped: () => false,
  getEquipamentosScope: async () => null,
  podeVerValores: async () => true,
};

(URL_BANCO ? describe : describe.skip)('Carregador OCPP no Postgres (ensaio com carregador simulado)', () => {
  const sufixo = Date.now().toString(36);
  const identidade = `ENSAIO-${sufixo}`;
  let prisma: PrismaClient;
  let server: http.Server;
  let ocpp: OcppService;
  let ponte: CarregadorOcppService;
  let carregador: CarregadorEletricoService;
  let gestao: CarregadorGestaoService;
  let url: string;
  let eid: string;
  let plantaId: string;
  let unidadeId: string;
  const moradorSemTag = `mor${sufixo}a`.padEnd(26, '0').slice(0, 26);
  const moradorComTag = `mor${sufixo}b`.padEnd(26, '0').slice(0, 26);
  const tag = `TAG${sufixo}`.toUpperCase().slice(0, 20);

  const assentar = async () => {
    await ocpp.entradaOciosa(identidade);
    await ponte.ocioso();
  };
  const estado = () => carregador.getEstado(eid, ADMIN);
  const um = async <T = any>(sql: Promise<T[]>) => (await sql)[0];

  beforeAll(async () => {
    Logger.overrideLogger(false);
    process.env.CARREGADOR_VALIDADE = 'off';
    prisma = new PrismaClient({ datasources: { db: { url: URL_BANCO } } });
    await prisma.$connect();
    const planta = await prisma.plantas.create({ data: { nome: `Planta ensaio ${sufixo}` } as any });
    const unidade = await prisma.unidades.create({ data: { nome: `Eletroposto ensaio ${sufixo}`, planta_id: planta.id } as any });
    const eq = await prisma.equipamentos.create({
      data: { nome: `CAR-${sufixo}`, classificacao: 'UC', criticidade: '3', unidade_id: unidade.id, tipo_equipamento: 'CARREGADOR_ELETRICO' } as any,
    });
    plantaId = planta.id.trim();
    unidadeId = unidade.id.trim();
    eid = eq.id.trim();
    await prisma.$executeRaw`INSERT INTO moradores (id, nome, apartamento, planta_id, ativo) VALUES (${moradorSemTag}, 'Bruno Ensaio', '202', ${plantaId}, true)`;
    await prisma.$executeRaw`INSERT INTO moradores (id, nome, apartamento, planta_id, ativo, tag_uid, validade) VALUES (${moradorComTag}, 'Ana Ensaio', '101', ${plantaId}, true, ${tag}, '2099-12-31')`;

    server = http.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const p: any = prisma;
    ocpp = new OcppService(new OcppRepositorio(p), { httpAdapter: { getHttpServer: () => server } } as any);
    ocpp.timeoutMs = 2000;
    const repo = new CarregadorOcppRepositorio(p);
    ponte = new CarregadorOcppService(repo, ocpp);
    ponte.onModuleInit();
    const auditoria = new CarregadorAuditoriaService(new AuditoriaAcessosService(p));
    carregador = new CarregadorEletricoService(p, escopoAdmin, {} as any, {} as any, ponte, repo, auditoria);
    gestao = new CarregadorGestaoService(carregador, ponte, repo, auditoria);
    await ocpp.onApplicationBootstrap();
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ocpp`;
  }, 30_000);

  afterAll(async () => {
    ocpp?.onModuleDestroy();
    if (server) await new Promise<void>((r) => server.close(() => r()));
    if (!prisma) return;
    await prisma.$executeRaw`DELETE FROM logs_mqtt WHERE equipamento_id = ${eid}::bpchar`;
    await prisma.$executeRaw`DELETE FROM equipamentos_dados WHERE equipamento_id = ${eid}::bpchar`;
    await prisma.$executeRaw`DELETE FROM carregador_sessoes WHERE equipamento_id = ${eid}::bpchar`;
    await prisma.$executeRaw`DELETE FROM carregador_config WHERE equipamento_id = ${eid}::bpchar`;
    await prisma.$executeRaw`DELETE FROM ocpp_meter_values WHERE charge_point_id LIKE ${`${identidade}%`}`;
    await prisma.$executeRaw`DELETE FROM ocpp_transactions WHERE charge_point_id LIKE ${`${identidade}%`}`;
    await prisma.$executeRaw`DELETE FROM ocpp_charge_points WHERE equipamento_id = ${eid}::bpchar`;
    await prisma.$executeRaw`DELETE FROM moradores WHERE planta_id = ${plantaId}`;
    await prisma.equipamentos.deleteMany({ where: { nome: `CAR-${sufixo}` } });
    await prisma.unidades.deleteMany({ where: { nome: `Eletroposto ensaio ${sufixo}` } });
    await prisma.plantas.deleteMany({ where: { nome: `Planta ensaio ${sufixo}` } });
    await prisma.$disconnect();
  }, 30_000);

  it('ciclo inteiro: vincular, conectar, limites, recarga, falha, cartão, comandos e desvincular', async () => {
    // ---- vínculo e conexão ----
    expect(await gestao.conexao(eid, ADMIN)).toMatchObject({ vinculado: false });
    const v: any = await gestao.vincular(eid, { charge_point_id: identidade }, ADMIN, CLIENTE);
    expect(v.chave).toMatch(/^[0-9a-f]{32}$/);
    const sim = new CarregadorSimulado(`${url}/${v.chave}/${identidade}`);
    await sim.conectar();
    await sim.boot();
    await sim.status('Available');
    await assentar();
    expect(await estado()).toMatchObject({ estado: 'disponivel', fonte_kwh: 'ocpp', ocpp: { conectado: true, disponivel: true, fabricante: 'CHINT', modelo: 'NTW-EC2A22W1-L' }, sessao_ativa: null });
    expect(await gestao.conexao(eid, ADMIN)).toMatchObject({ vinculado: true, charge_point_id: identidade, conectado: true, numero_serie: '20260703000025', perfis: ['Core', 'SmartCharging', 'RemoteTrigger'], ip: '127.0.0.1' });

    // ---- limites de uso e corrente ----
    const lim = await gestao.salvarLimites(eid, { limite_tempo_min: 120, limite_energia_kwh: '30,5', inicio_automatico: false, limite_corrente_a: 16 }, ADMIN, CLIENTE);
    expect(lim.limites).toEqual({ tempo_min: 120, energia_kwh: 30.5, inicio_automatico: false, corrente_a: 16, corrente_min_a: 6, corrente_max_a: 32, corrente_suportada: true });
    expect((await sim.esperar('SetChargingProfile')).csChargingProfiles.chargingSchedule.chargingSchedulePeriod).toEqual([{ startPeriod: 0, limit: 16 }]);
    await carregador.salvarConfig(eid, { tarifa_kwh: '1,25' }, ADMIN, CLIENTE);

    // ---- recarga liberada no NexON ----
    const lib = await carregador.liberarRecarga(eid, moradorSemTag, ADMIN, { limiteEnergiaKwh: 10, cliente: CLIENTE });
    expect(lib).toMatchObject({ morador: 'Bruno Ensaio', aguardando_inicio: true });
    const { idTag } = await sim.esperar('RemoteStartTransaction');
    expect((await estado()).sessao_ativa).toMatchObject({ aguardando_inicio: true, limite_tempo_min: 120, limite_energia_kwh: 10, origem: 'nexon' });
    const t0 = Date.now() - 180_000;
    const tx = await sim.iniciar(idTag, 1000, new Date(t0));
    expect(tx.status).toBe('Accepted');
    expect((await sim.iniciar(idTag, 1000, new Date(t0))).transactionId).toBe(tx.transactionId); // repetido
    await sim.status('Charging');
    await sim.medir(tx.transactionId, { energiaWh: 1000, potenciaW: 7100, correnteA: 31, tensaoV: 220, temperaturaC: 38 }, new Date(t0 + 60_000));
    await sim.medir(tx.transactionId, { energiaWh: 4250, potenciaW: 7200, correnteA: 31.4, tensaoV: 221, temperaturaC: 41, soc: 55 }, new Date(t0 + 120_000));
    await assentar();
    await ponte.vigiar();
    const e = await estado();
    expect(e).toMatchObject({ estado: 'carregando', soc: 55, leitura: { potencia_kw: 7.2, corrente_a: 31.4, tensao_v: 221, temperatura_c: 41, energia_sessao_kwh: 3.25 } });
    expect(Number(e.ultima_leitura_kwh)).toBe(4.25);
    expect(Number(e.sessao_ativa.kwh_total)).toBe(3.25);
    expect(e.sessao_ativa.aguardando_inicio).toBe(false);
    expect(e.sessao_ativa.duracao_min).toBeGreaterThanOrEqual(2);
    expect(e.sessao_ativa.inicio_iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Math.abs(Date.parse(e.sessao_ativa.inicio_iso) - t0)).toBeLessThan(1500);
    const dado = await um(prisma.$queryRaw<any[]>`SELECT dados, fonte, potencia_ativa_kw, energia_kwh FROM equipamentos_dados WHERE equipamento_id = ${eid}::bpchar ORDER BY timestamp_dados DESC LIMIT 1`);
    expect(dado.fonte).toBe('OCPP');
    expect(Number(dado.potencia_ativa_kw)).toBe(7.2);
    expect(Number(dado.energia_kwh)).toBe(3.25);
    expect(dado.dados).toMatchObject({ Pt: 7200, potencia_kw: 7.2, status: 'carregando', energia_sessao_kwh: 3.25 });

    await carregador.pararRecarga(eid, ADMIN, CLIENTE);
    expect(await sim.esperar('RemoteStopTransaction')).toEqual({ transactionId: tx.transactionId });
    await sim.parar(tx.transactionId, 8500, 'Remote');
    await sim.status('Available');
    await assentar();
    const fim = await estado();
    expect(fim.sessao_ativa).toBeNull();
    expect(fim.sessoes[0]).toMatchObject({ morador_nome: 'Bruno Ensaio', status: 'encerrada', motivo_fim: 'parado_no_nexon', motivo_fim_texto: 'Parada pelo NexON', origem: 'nexon' });
    expect(Number(fim.sessoes[0].kwh_total)).toBe(7.5);
    expect(Number(fim.sessoes[0].tarifa_kwh)).toBe(1.25);
    expect(fim.sessoes[0].inicio).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
    expect(fim.sessoes[0].duracao_min).toBeGreaterThanOrEqual(2);
    const txBanco = await um(prisma.$queryRaw<any[]>`SELECT status, meter_start, meter_stop, energia_kwh, motivo_fim FROM ocpp_transactions WHERE transaction_id = ${tx.transactionId}`);
    expect(txBanco).toMatchObject({ status: 'encerrada', meter_start: 1000, meter_stop: 8500, motivo_fim: 'Remote' });
    expect(Number(txBanco.energia_kwh)).toBe(7.5);
    expect((await prisma.$queryRaw<any[]>`SELECT 1 FROM ocpp_meter_values WHERE transaction_id = ${tx.transactionId}`).length).toBe(2);

    // ---- exportação do mês (datas de Brasília) ----
    const mes = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).format(new Date(t0)).slice(0, 7);
    const exp = await carregador.exportarMensal(mes, ADMIN, plantaId);
    expect(exp.linhas).toHaveLength(1);
    expect(exp.linhas[0]).toMatchObject({ morador: 'Bruno Ensaio', recargas: 1, kwh: 7.5, valor_reais: 9.38 });

    // ---- falha do manual e alarme ----
    await sim.status('Faulted', { errorCode: 'OtherError', vendorErrorCode: 'E07' });
    await assentar();
    expect((await estado()).falha).toMatchObject({ codigo: 'E07', titulo: 'Botão de parada de emergência pressionado' });
    const aberto = await um(prisma.$queryRaw<any[]>`SELECT severidade, resolvido_em, dados_snapshot FROM logs_mqtt WHERE tipo = 'alerta' AND equipamento_id = ${eid}::bpchar`);
    expect(aberto).toMatchObject({ severidade: 'CRITICA', resolvido_em: null, dados_snapshot: { kind: 'carregador_falha', codigo: 'E07' } });
    await sim.status('Available');
    await assentar();
    const resolvido = await um(prisma.$queryRaw<any[]>`SELECT resolvido_em, dados_snapshot FROM logs_mqtt WHERE tipo = 'alerta' AND equipamento_id = ${eid}::bpchar`);
    expect(resolvido.resolvido_em).not.toBeNull();
    expect(resolvido.dados_snapshot.normalizado_em).toMatch(/Z$/);
    expect((await estado()).falha).toBeNull();

    // ---- cartão do morador ----
    expect((await sim.chamar('Authorize', { idTag: tag.toLowerCase() })).idTagInfo).toEqual({ status: 'Accepted', expiryDate: '2100-01-01T03:00:00.000Z', parentIdTag: grupoDoMorador(moradorComTag) });
    expect(await sim.autorizar('DESCONHECIDO')).toBe('Invalid');
    const txTag = await sim.iniciar(tag, 9000);
    await assentar();
    expect((await estado()).sessao_ativa).toMatchObject({ morador_nome: 'Ana Ensaio', origem: 'cartao', limite_tempo_min: 120 });
    await sim.parar(txTag.transactionId, 9500, 'Local');
    await assentar();
    expect((await estado()).sessoes[0]).toMatchObject({ morador_nome: 'Ana Ensaio', motivo_fim: 'parado_no_carregador', origem: 'cartao' });

    // ---- queda de energia: o carregador retoma com a mesma tag e a recarga segue no nome do morador ----
    await carregador.liberarRecarga(eid, moradorSemTag, ADMIN, {});
    const retomar = await sim.esperar('RemoteStartTransaction');
    const q1 = await sim.iniciar(retomar.idTag, 10_000);
    await sim.parar(q1.transactionId, 10_500, 'PowerLoss');
    await assentar();
    expect((await estado()).sessoes[0]).toMatchObject({ morador_nome: 'Bruno Ensaio', motivo_fim: 'queda_energia' });
    const q2 = await sim.iniciar(retomar.idTag, 10_500);
    expect(q2.status).toBe('Accepted');
    await assentar();
    expect((await estado()).sessao_ativa).toMatchObject({ morador_nome: 'Bruno Ensaio', limite_tempo_min: 120, aguardando_inicio: false });

    // ---- fechada sem a confirmação do carregador e ele segue medindo: reabre ----
    await prisma.$executeRaw`UPDATE carregador_sessoes SET status = 'encerrada', fim = now(), motivo_fim = 'sem_confirmacao' WHERE equipamento_id = ${eid}::bpchar AND status = 'ativa'`;
    expect((await estado()).sessao_ativa).toBeNull();
    await sim.medir(q2.transactionId, { energiaWh: 11_000, potenciaW: 7000 });
    await assentar();
    const reaberta = (await estado()).sessao_ativa;
    expect(reaberta).toMatchObject({ morador_nome: 'Bruno Ensaio' });
    expect(Number(reaberta.kwh_total)).toBe(0.5);
    await sim.parar(q2.transactionId, 11_500, 'EVDisconnected');
    await assentar();
    expect((await estado()).sessao_ativa).toBeNull();
    expect((await estado()).sessoes[0]).toMatchObject({ motivo_fim: 'desconectado' });

    // ---- recarga que não começa é cancelada ----
    await carregador.liberarRecarga(eid, moradorSemTag, ADMIN, {});
    await sim.esperar('RemoteStartTransaction');
    ponte.prazoInicioMs = -5000; // a coluna arredonda o início para o segundo: folga para o teste
    await ponte.vigiar();
    ponte.prazoInicioMs = 180_000;
    expect((await estado()).sessao_ativa).toBeNull();
    expect((await prisma.$queryRaw<any[]>`SELECT 1 FROM carregador_sessoes WHERE equipamento_id = ${eid}::bpchar`).length).toBe(4);

    // ---- comandos, parâmetros e visão técnica ----
    expect(await gestao.comando(eid, 'bloquear', ADMIN, CLIENTE)).toMatchObject({ resposta: 'Accepted' });
    expect((await estado()).ocpp.disponivel).toBe(false);
    await gestao.comando(eid, 'liberar', ADMIN, CLIENTE);
    expect((await gestao.parametros(eid, ADMIN)).parametros.length).toBe(3);
    expect(await gestao.mudarParametro(eid, { chave: 'MeterValueSampleInterval', valor: '30' }, ADMIN, CLIENTE)).toEqual({ resposta: 'Accepted' });
    const tecnico = new OcppController(ocpp, prisma as any, escopoAdmin);
    expect((await tecnico.chargePoints(ADMIN)).data.find((c: any) => c.charge_point_id === identidade)).toMatchObject({ ao_vivo: true, equipamento_id: eid, planta_id: plantaId });
    expect((await tecnico.transactions(identidade, '10', ADMIN)).data).toHaveLength(4);

    // ---- trilha e audit log gravados de verdade ----
    const trilha = await prisma.$queryRaw<any[]>`SELECT comando_semantico FROM logs_mqtt WHERE tipo = 'comando' AND equipamento_id = ${eid}::bpchar`;
    expect(trilha.map((t) => t.comando_semantico)).toEqual(expect.arrayContaining([
      'carregador.ocpp_vinculo', 'carregador.limites', 'carregador.corrente', 'carregador.tarifa', 'carregador.iniciar', 'carregador.iniciada',
      'carregador.parar', 'carregador.encerrada', 'carregador.falha', 'carregador.falha_normalizada', 'carregador.nao_iniciou', 'carregador.bloquear',
    ]));
    const aud = await prisma.$queryRaw<any[]>`
      SELECT acao, resultado, mensagem, autor_nome, objeto_tipo, TRIM(objeto_id) AS objeto_id, planta_ids, unidade_ids, detalhes
      FROM auditoria_acessos WHERE objeto_id = ${eid} ORDER BY created_at`;
    expect(aud.map((x) => x.acao)).toEqual(expect.arrayContaining(['carregador_ocpp', 'carregador_config', 'carregador_comando']));
    const iniciar = aud.find((x) => x.detalhes?.comando === 'iniciar');
    expect(iniciar).toMatchObject({ acao: 'carregador_comando', resultado: 'ok', autor_nome: 'Ensaio Admin', objeto_tipo: 'carregador', objeto_id: eid, planta_ids: [plantaId], unidade_ids: [unidadeId] });
    expect(iniciar.mensagem).toContain(`Recarga iniciada · Bruno Ensaio · CAR-${sufixo} · Eletroposto ensaio ${sufixo} · Planta ensaio ${sufixo}`);
    expect(iniciar.detalhes).toMatchObject({ comando_ocpp: 'RemoteStartTransaction', resposta: 'Accepted', charge_point_id: identidade, limites: { tempo_min: 120, energia_kwh: 10 } });

    // ---- chave nova e desvincular ----
    const nova = await gestao.novaChave(eid, ADMIN, CLIENTE);
    await new Promise((r) => setTimeout(r, 80));
    expect(sim.conectado).toBe(false);
    await expect(new CarregadorSimulado(`${url}/${v.chave}/${identidade}`).conectar()).rejects.toThrow('HTTP 401');
    const sim2 = new CarregadorSimulado(`${url}/${nova.chave}/${identidade}`);
    await sim2.conectar();
    await assentar();
    await gestao.desvincular(eid, ADMIN, CLIENTE);
    await new Promise((r) => setTimeout(r, 80));
    expect(sim2.conectado).toBe(false);
    expect((await estado()).ocpp).toBeNull();
    // A identidade fica livre para ser cadastrada de novo.
    const outra: any = await gestao.vincular(eid, { charge_point_id: identidade }, ADMIN, CLIENTE);
    expect(outra.chave).toMatch(/^[0-9a-f]{32}$/);
    // O histórico bruto ficou com a estação antiga: a nova, de mesma identidade, não o herda.
    expect((await tecnico.transactions(identidade, '10', ADMIN)).data).toHaveLength(0);
    expect((await prisma.$queryRaw<any[]>`SELECT 1 FROM ocpp_transactions WHERE charge_point_id LIKE ${`${identidade}#%`}`).length).toBe(4);
    expect((await prisma.$queryRaw<any[]>`SELECT 1 FROM ocpp_meter_values WHERE charge_point_id = ${identidade}`).length).toBe(0);
    const guardado = await um(prisma.$queryRaw<any[]>`SELECT chave_hash FROM ocpp_charge_points WHERE equipamento_id = ${eid}::bpchar AND deleted_at IS NULL`);
    expect(guardado.chave_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(guardado.chave_hash).not.toBe(outra.chave);
  }, 60_000);
});
