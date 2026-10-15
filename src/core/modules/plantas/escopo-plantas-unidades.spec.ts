import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { PermissionScopeService } from '../auth/permission-scope.service';
import { PlantaScopeGuard } from '../auth/guards/planta-scope.guard';
import { prismaEscopoFake } from '../auth/testing/prisma-escopo.fake';
import { ExportacaoAuditoriaService } from '../usuarios/exportacao-auditoria.service';
import { EquipamentosService } from '../equipamentos/equipamentos.service';
import { UnidadesController } from '../unidades/unidades.controller';
import { UnidadesService } from '../unidades/unidades.service';
import { AnexosUnidadesService } from '../unidades/anexos-unidades.service';
import { PlantasController } from './plantas.controller';
import { PlantasService } from './plantas.service';

/**
 * Rotas de unidade e planta pela pilha HTTP (guard → interceptor → handler).
 * Fixture: P1/U1 do "dono1", P2/U2 do "dono2"; "op1" opera só a P1.
 * Fora do escopo = 403 e o service nem é chamado (nada lido nem gravado).
 */
const DONO1 = { id: 'dono1', role: 'proprietario' };
const OP1 = { id: 'op1', role: 'operador' };
const ADMIN = { id: 'adm', role: 'super_admin' };

describe('Escopo por planta nas rotas de unidade e planta', () => {
  let app: INestApplication;
  let usuario: any;
  const fn = () => jest.fn(async (..._a: any[]) => ({ ok: true, data: [], pagination: { total: 0 } }));
  const unidSvc: Record<string, jest.Mock> = {
    create: fn(), update: fn(), remove: fn(), findOne: fn(), findByPlanta: fn(), findAll: fn(), getEstatisticas: fn(),
  };
  const equipSvc: Record<string, jest.Mock> = { findByUnidade: fn(), getEstatisticasUnidade: fn() };
  const anexosUnidSvc: Record<string, jest.Mock> = { uploadAnexo: fn(), listarAnexos: fn() };
  const plantaSvc: Record<string, jest.Mock> = {
    create: fn(), update: fn(), remove: fn(), findAll: fn(), findUnidadesByPlanta: fn(), findProprietarios: jest.fn(async () => []),
    findOne: jest.fn(async (id: string) => ({ id, proprietarioId: id === 'P1' ? 'dono1' : 'dono2' })),
  };
  const todos = () => [...Object.values(unidSvc), ...Object.values(equipSvc), ...Object.values(anexosUnidSvc), ...Object.values(plantaSvc)];
  const chamadas = () => todos().reduce((n, m) => n + m.mock.calls.length, 0);

  beforeAll(async () => {
    const prisma = prismaEscopoFake();
    const scope = new PermissionScopeService(prisma as any);
    const mod = await Test.createTestingModule({
      controllers: [UnidadesController, PlantasController],
      providers: [
        PlantaScopeGuard,
        { provide: PermissionScopeService, useValue: scope },
        { provide: ExportacaoAuditoriaService, useValue: { executar: jest.fn(async (_c: any, f: () => any) => f()) } },
        { provide: UnidadesService, useValue: unidSvc },
        { provide: AnexosUnidadesService, useValue: anexosUnidSvc },
        { provide: EquipamentosService, useValue: equipSvc },
        { provide: PlantasService, useValue: plantaSvc },
      ],
    }).compile();
    app = mod.createNestApplication();
    app.use((req: any, _res: any, next: any) => {
      req.user = usuario;
      next();
    });
    await app.init();
  });
  afterAll(() => app?.close());
  beforeEach(() => {
    jest.clearAllMocks();
    usuario = DONO1;
  });
  const http = () => request(app.getHttpServer()) as any;

  it.each([
    ['get', '/unidades/U2'],
    ['put', '/unidades/U2'],
    ['delete', '/unidades/U2'],
    ['get', '/unidades/U2/estatisticas'],
    ['get', '/unidades/U2/equipamentos'],
    ['get', '/unidades/U2/equipamentos/estatisticas'],
    ['get', '/unidades/planta/P2'],
    ['get', '/plantas/P2'],
    ['put', '/plantas/P2'],
    ['delete', '/plantas/P2'],
    ['get', '/plantas/P2/unidades'],
  ])('%s %s de outra planta → 403 sem chamar o service', async (metodo, url) => {
    const r = await http()[metodo](url).send({ nome: 'x' });
    expect(r.status).toBe(403);
    expect(chamadas()).toBe(0);
  });

  it('operador também fica só na planta vinculada', async () => {
    usuario = OP1;
    expect((await http().get('/unidades/U2')).status).toBe(403);
    expect((await http().delete('/plantas/P2')).status).toBe(403);
    expect((await http().get('/unidades/U1')).status).toBe(200);
    expect(chamadas()).toBe(1);
  });

  it('criar unidade em planta alheia → 403', async () => {
    expect((await http().post('/unidades').send({ planta_id: 'P2', nome: 'x' })).status).toBe(403);
    expect(unidSvc.create).not.toHaveBeenCalled();
  });

  it('alterar unidade própria movendo para planta alheia → 403 sem gravar', async () => {
    expect((await http().put('/unidades/U1').send({ planta_id: 'P2' })).status).toBe(403);
    expect(unidSvc.update).not.toHaveBeenCalled();
  });

  it('planta: criar em nome de outro dono ou transferir a própria → 403 sem gravar', async () => {
    expect((await http().post('/plantas').send({ nome: 'x', proprietarioId: 'dono2' })).status).toBe(403);
    expect((await http().put('/plantas/P1').send({ proprietarioId: 'dono2' })).status).toBe(403);
    expect(plantaSvc.create).not.toHaveBeenCalled();
    expect(plantaSvc.update).not.toHaveBeenCalled();
  });

  it('no próprio escopo passa', async () => {
    expect((await http().put('/unidades/U1').send({ nome: 'x', planta_id: 'P1' })).status).toBe(200);
    expect((await http().post('/unidades').send({ planta_id: 'P1', nome: 'x' })).status).toBe(201);
    expect((await http().put('/plantas/P1').send({ nome: 'x', proprietarioId: 'dono1' })).status).toBe(200);
    expect((await http().post('/plantas').send({ nome: 'x', proprietarioId: 'dono1' })).status).toBe(201);
    expect((await http().get('/plantas/P1/unidades')).status).toBe(200);
  });

  it('admin passa em qualquer planta e pode mover/transferir', async () => {
    usuario = ADMIN;
    expect((await http().put('/unidades/U1').send({ planta_id: 'P2' })).status).toBe(200);
    expect((await http().put('/plantas/P1').send({ proprietarioId: 'dono2' })).status).toBe(200);
    expect((await http().post('/plantas').send({ nome: 'x', proprietarioId: 'dono2' })).status).toBe(201);
  });

  it('listagens repassam o usuário para o filtro de escopo do service', async () => {
    await http().get('/plantas/proprietarios');
    expect(plantaSvc.findProprietarios).toHaveBeenCalledWith(false, DONO1);
    await http().get('/unidades?plantaId=P2');
    expect(unidSvc.findAll.mock.calls[0][1]).toBe(DONO1);
  });
});

describe('PlantasService.findProprietarios com escopo', () => {
  it('usuário com escopo só recebe os donos das plantas dele', async () => {
    const prisma: any = prismaEscopoFake();
    prisma.usuarios = { findMany: jest.fn(async () => []) };
    const svc = new PlantasService(prisma, new PermissionScopeService(prisma));
    await svc.findProprietarios(true, DONO1);
    const where = prisma.usuarios.findMany.mock.calls[0][0].where;
    expect(where.plantas_proprietario.some.id).toEqual({ in: ['P1'] });
    expect(where.plantas_proprietario.some.unidades).toBeDefined();

    await svc.findProprietarios(false, ADMIN);
    expect(prisma.usuarios.findMany.mock.calls[1][0].where.plantas_proprietario).toBeUndefined();
  });
});
