import 'reflect-metadata';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { PlantaScopeGuard } from './planta-scope.guard';
import { PLANTA_SCOPE_KEY } from '../decorators/planta-scope.decorator';
import { PermissionScopeService } from '../permission-scope.service';
import { prismaEscopoFake } from '../testing/prisma-escopo.fake';
import { EquipamentosController } from '../../equipamentos/equipamentos.controller';

const DONO1 = { id: 'dono1', role: 'proprietario' };
const ADMIN = { id: 'adm', role: 'admin' };
const CATIVO = { id: 'ninguem', role: 'cativo' };

const proto = EquipamentosController.prototype as any;
const handlers = Object.getOwnPropertyNames(proto).filter(
  (n) => n !== 'constructor' && Reflect.getMetadata(PATH_METADATA, proto[n]) !== undefined,
);

/** Rotas de export auditadas: checam o escopo no próprio handler (1º passo) para gravar a recusa. */
const CHECAM_NO_HANDLER = ['downloadAnexo', 'listarAnexos', 'obterDadoAtual', 'obterHistorico'];
/** Sem id de entidade: listam com filtro de escopo no service ou são catálogo. */
const SEM_ENTIDADE = ['findAll', 'tiposUnifilar', 'findEquipamentosUC'];

describe('PlantaScopeGuard', () => {
  let guard: PlantaScopeGuard;

  beforeEach(() => {
    guard = new PlantaScopeGuard(new Reflector(), new PermissionScopeService(prismaEscopoFake() as any));
  });

  const ctx = (handler: string, req: { params?: any; body?: any; query?: any; user: any }) =>
    ({
      getHandler: () => proto[handler],
      getClass: () => EquipamentosController,
      switchToHttp: () => ({ getRequest: () => ({ params: {}, body: {}, query: {}, ...req }) }),
    }) as any;

  it('TODA rota do EquipamentosController com id na URL ou no body tem escopo declarado', () => {
    const semEscopo = handlers.filter((h) => {
      if (CHECAM_NO_HANDLER.includes(h) || SEM_ENTIDADE.includes(h)) return false;
      return !Reflect.getMetadata(PLANTA_SCOPE_KEY, proto[h]);
    });
    expect(semEscopo).toEqual([]);
  });

  it('rotas que escrevem (POST/PUT/PATCH/DELETE) nunca ficam só no handler', () => {
    for (const h of handlers) {
      const m = Reflect.getMetadata(METHOD_METADATA, proto[h]);
      if ([RequestMethod.POST, RequestMethod.PUT, RequestMethod.PATCH, RequestMethod.DELETE].includes(m)) {
        expect([h, !!Reflect.getMetadata(PLANTA_SCOPE_KEY, proto[h])]).toEqual([h, true]);
      }
    }
  });

  it('upload de foto em equipamento de outra planta: 403 no guard (antes do multer gravar)', async () => {
    await expect(guard.canActivate(ctx('uploadFoto', { params: { id: 'E2' }, user: DONO1 }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(guard.canActivate(ctx('uploadFoto', { params: { id: 'E1' }, user: DONO1 }))).resolves.toBe(true);
  });

  it('update/remove: 403 fora do escopo; admin passa', async () => {
    await expect(guard.canActivate(ctx('update', { params: { id: 'E2' }, user: DONO1 }))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(ctx('remove', { params: { id: 'E2' }, user: DONO1 }))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(ctx('remove', { params: { id: 'E2' }, user: ADMIN }))).resolves.toBe(true);
  });

  it('PATCH :id não move equipamento próprio para unidade/pai de outra planta', async () => {
    await expect(
      guard.canActivate(ctx('update', { params: { id: 'E1' }, body: { unidade_id: 'U2' }, user: DONO1 })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      guard.canActivate(ctx('update', { params: { id: 'E1' }, body: { equipamento_pai_id: 'E2' }, user: DONO1 })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(ctx('update', { params: { id: 'E1' }, body: { nome: 'x' }, user: DONO1 }))).resolves.toBe(true);
  });

  it('remover anexo: dono resolvido pelo anexoId no banco', async () => {
    await expect(guard.canActivate(ctx('removerAnexo', { params: { anexoId: 'AX2' }, user: DONO1 }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(guard.canActivate(ctx('removerAnexo', { params: { anexoId: 'AX1' }, user: DONO1 }))).resolves.toBe(true);
    await expect(guard.canActivate(ctx('removerAnexo', { params: { anexoId: 'nao-existe' }, user: DONO1 }))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('replicar anexos: qualquer destino fora do escopo barra', async () => {
    await expect(
      guard.canActivate(
        ctx('replicarAnexos', { body: { origem_equipamento_id: 'E1', destino_equipamento_ids: ['E1', 'E2'] }, user: DONO1 }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('criar em unidade de outra planta e papel sem vínculo: 403', async () => {
    await expect(
      guard.canActivate(ctx('criarEquipamentoRapido', { body: { unidade_id: 'U2' }, user: DONO1 })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(ctx('findOne', { params: { id: 'E1' }, user: CATIVO }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('campo opcional ausente não barra; obrigatório ausente é 404', async () => {
    await expect(guard.canActivate(ctx('proximoSequencial', { query: {}, user: DONO1 }))).resolves.toBe(true);
    await expect(guard.canActivate(ctx('criarEquipamentoRapido', { body: {}, user: DONO1 }))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
