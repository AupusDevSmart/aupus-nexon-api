import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CamerasAparelhoService, versaoMaior } from './cameras-aparelho.service';

/* eslint-disable @typescript-eslint/no-explicit-any */
const agora = new Date('2026-11-23T12:00:00Z');
function montar(opts: { criadoHaDias?: number; recente?: boolean; publicada?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nexon-auto-'));
  mkdirSync(join(dir, 'agente'));
  writeFileSync(join(dir, 'agente', 'atual.json'), JSON.stringify({ versao: opts.publicada ?? '0.4.5', sha256: 'a'.repeat(64), tamanho: 10 }));
  const prisma: any = {
    cameras_agentes: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'ag1', nome: 'Pi', unidade_id: 'u1', versao: '0.4.4', host: 'nexon-cam',
        created_at: new Date(agora.getTime() - (opts.criadoHaDias ?? 0) * 86_400_000),
      }),
    },
    cameras_comandos: {
      findFirst: jest.fn().mockResolvedValue(opts.recente ? { id: 'c0' } : null),
      create: jest.fn().mockImplementation(async ({ data }) => ({ ...data, estado: 'pendente' })),
    },
  };
  const auditoria: any = { contextoUnidade: jest.fn().mockResolvedValue({ unidade: { id: 'u1', nome: 'UFV' }, planta: null }), registrar: jest.fn() };
  const despertar: any = { despertar: jest.fn() };
  const svc = new CamerasAparelhoService(prisma, {} as any, { absoluto: (r: string) => join(dir, r) } as any, auditoria, despertar);
  return { svc, prisma, auditoria, despertar };
}

describe('aparelho novo se atualiza sozinho', () => {
  it('versão velha num aparelho novo: pede atualizar, acorda e audita como automático', async () => {
    const m = montar();
    await m.svc.atualizarSozinho('ag1', '0.4.4', agora);
    expect(m.prisma.cameras_comandos.create.mock.calls[0][0].data).toMatchObject({ tipo: 'atualizar', parametros: { versao: '0.4.5', automatico: true }, solicitado_por_id: null });
    expect(m.despertar.despertar).toHaveBeenCalledWith('ag1');
    expect(m.auditoria.registrar.mock.calls[0][1].mensagem).toContain('Atualização automática');
  });

  it('não pede: já atualizado, aparelho antigo (mais de 7 dias) ou pedido nas últimas 24 h', async () => {
    for (const m of [montar({ publicada: '0.4.4' }), montar({ criadoHaDias: 8 }), montar({ recente: true })]) {
      await m.svc.atualizarSozinho('ag1', '0.4.4', agora);
      expect(m.prisma.cameras_comandos.create).not.toHaveBeenCalled();
    }
  });

  it('compara versões por número', () => {
    expect(versaoMaior('0.4.10', '0.4.9')).toBe(true);
    expect(versaoMaior('0.4.4', '0.4.4')).toBe(false);
    expect(versaoMaior('0.4.3', '0.4.4')).toBe(false);
  });
});
