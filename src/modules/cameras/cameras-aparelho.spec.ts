import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CamerasAparelhoService } from './cameras-aparelho.service';

/* eslint-disable @typescript-eslint/no-explicit-any */
function montar(manifesto?: object) {
  const dir = mkdtempSync(join(tmpdir(), 'nexon-ap-'));
  if (manifesto) {
    mkdirSync(join(dir, 'agente'));
    writeFileSync(join(dir, 'agente', 'atual.json'), JSON.stringify(manifesto));
  }
  const prisma: any = {
    cameras_agentes: { findFirst: jest.fn().mockResolvedValue({ id: 'ag1', nome: 'Pi', unidade_id: 'u1', versao: '0.3.0', host: 'nexon-cam' }) },
    cameras_comandos: { create: jest.fn().mockImplementation(async ({ data }) => ({ ...data, estado: 'pendente' })) },
  };
  const scope: any = { assertEntityInScope: jest.fn() };
  const storage: any = { absoluto: (rel: string) => join(dir, rel) };
  const auditoria: any = { contextoUnidade: jest.fn().mockResolvedValue({ unidade: { id: 'u1', nome: 'UFV' }, planta: null }), registrar: jest.fn() };
  const despertar: any = { despertar: jest.fn() };
  return { svc: new CamerasAparelhoService(prisma, scope, storage, auditoria, despertar), prisma, auditoria, despertar };
}
const admin: any = { id: 'a1', role: 'super_admin' };
const sha = 'a'.repeat(64);

describe('aparelho pela web', () => {
  it('admin pede atualização: comando sem câmera, acorda o aparelho e audita versão de → para', async () => {
    const m = montar({ versao: '0.4.0', sha256: sha, tamanho: 10 });
    const r = await m.svc.pedir('ag1', 'atualizar', admin);
    expect(r.tipo).toBe('atualizar');
    expect(m.prisma.cameras_comandos.create.mock.calls[0][0].data).toMatchObject({ camera_id: null, agente_id: 'ag1', parametros: { versao: '0.4.0' } });
    expect(m.despertar.despertar).toHaveBeenCalledWith('ag1');
    const [acao, reg] = m.auditoria.registrar.mock.calls[0];
    expect(acao).toBe('camera_agente_comando');
    expect(reg.mensagem).toContain('0.3.0 → 0.4.0');
  });

  it('sem versão publicada não atualiza; quem não é admin não atualiza nem reinicia', async () => {
    await expect(montar().svc.pedir('ag1', 'atualizar', admin)).rejects.toBeInstanceOf(BadRequestException);
    const m = montar({ versao: '0.4.0', sha256: sha, tamanho: 1 });
    for (const tipo of ['atualizar', 'reiniciar']) {
      await expect(m.svc.pedir('ag1', tipo, { id: 'x', role: 'operador' } as any)).rejects.toBeInstanceOf(ForbiddenException);
    }
    await expect(m.svc.pedir('ag1', 'apagar_tudo', admin)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('versão disponível vem do manifesto', async () => {
    expect(await montar({ versao: '0.4.0', sha256: sha, tamanho: 1, notas: 'x' }).svc.disponivel()).toMatchObject({ versao: '0.4.0' });
    expect(await montar().svc.disponivel()).toEqual({ versao: null });
  });
});
