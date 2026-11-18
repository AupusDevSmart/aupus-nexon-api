import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { CamerasInstalacoesService, limparRegistro } from './cameras-instalacoes.service';

/* eslint-disable @typescript-eslint/no-explicit-any */
function montar(antes: any = null) {
  const prisma: any = {
    cameras_instalacoes: {
      findUnique: jest.fn().mockResolvedValue(antes),
      create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ ...data })),
      update: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'i1', ...data })),
      findMany: jest.fn().mockResolvedValue([{ id: 'i1', unidade_id: 'u1', estado: 'erro' }]),
    },
    usuarios: { findFirst: jest.fn().mockResolvedValue({ nome: 'Fulano' }) },
    unidades: { findMany: jest.fn().mockResolvedValue([{ id: 'u1', nome: 'UFV Aupus II' }]) },
  };
  const midia: any = { lerVinculo: (c: string) => (c === 'vin.ok' ? { un: 'u1', by: 'a1', n: 'x' } : null) };
  const auditoria: any = { registrar: jest.fn(), contextoUnidade: jest.fn().mockResolvedValue({ unidade: { id: 'u1', nome: 'UFV Aupus II' }, planta: null }) };
  return { svc: new CamerasInstalacoesService(prisma, midia, auditoria), prisma, auditoria };
}
const tecnico: any = { id: 'a1', role: 'super_admin', nome: 'Lucas' };

describe('relato das instalações pelo computador', () => {
  it('cria a sessão com a usina do vínculo e audita o erro uma vez, sem tokens', async () => {
    const m = montar();
    await m.svc.relatar(tecnico, {
      sessao: 'abc12345-1', estado: 'erro', passo: 'Programa da Raspberry', mensagem: 'falhou',
      registro: 'curl https://x/imagem?token=segredo.assinado ok vin.abc.def', vinculo: 'vin.ok', sistema: 'Linux Ubuntu 24.04',
    } as any);
    const data = m.prisma.cameras_instalacoes.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ sessao: 'abc12345-1', unidade_id: 'u1', estado: 'erro', usuario_id: 'a1' });
    expect(data.registro).not.toContain('segredo');
    expect(data.registro).not.toContain('vin.abc');
    expect(m.auditoria.registrar).toHaveBeenCalledWith('camera_instalacao', expect.objectContaining({ objetoTipo: 'camera_instalacao' }));
  });

  it('sem nome no token, busca o nome no cadastro', async () => {
    const m = montar();
    await m.svc.relatar({ id: 'a1', role: 'super_admin' } as any, { sessao: 'abc12345-9' } as any);
    expect(m.prisma.cameras_instalacoes.create.mock.calls[0][0].data.usuario_nome).toBe('Fulano');
  });

  it('andamento não audita; mesma sessão de outra pessoa é recusada; sessão inválida também', async () => {
    const m = montar({ estado: 'andamento', usuario_id: 'a1' });
    await m.svc.relatar(tecnico, { sessao: 'abc12345-1', estado: 'andamento', passo: 'Imagem' } as any);
    expect(m.auditoria.registrar).not.toHaveBeenCalled();
    await expect(m.svc.relatar({ id: 'outro', role: 'super_admin' } as any, { sessao: 'abc12345-1' } as any)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(m.svc.relatar(tecnico, { sessao: 'x' } as any)).rejects.toBeInstanceOf(BadRequestException);
    // proprietário (sem cadastro técnico) não relata
    await expect(montar().svc.relatar({ id: 'p1', role: 'proprietario' } as any, { sessao: 'abc12345-2' } as any)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('chave de vínculo de outra pessoa não define a usina', async () => {
    const m = montar();
    await m.svc.relatar({ id: 'b2', role: 'super_admin' } as any, { sessao: 'abc12345-3', vinculo: 'vin.ok' } as any);
    expect(m.prisma.cameras_instalacoes.create.mock.calls[0][0].data.unidade_id).toBeNull();
  });

  it('lista só para administrador, com o nome da usina', async () => {
    const m = montar();
    const r = await m.svc.listar(tecnico);
    expect(r[0]).toMatchObject({ unidade_nome: 'UFV Aupus II' });
    await expect(m.svc.listar({ id: 'x', role: 'analista' } as any)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('limparRegistro tira token, vínculo e token do agente', () => {
    expect(limparRegistro('a?token=abc.def&x=1 vin.zz.yy nxcam_123')).toBe('a?token=***&x=1 vin.*** nxcam_***');
  });

  it('Raspberry relata o primeiro boot com a chave de vínculo (usina e autor vêm da chave)', async () => {
    const m = montar();
    await m.svc.relatarAparelho({ vinculo: 'vin.ok', estado: 'andamento', passo: 'internet', host: 'nexon-cam', ip_local: '192.168.0.10' } as any);
    const data = m.prisma.cameras_instalacoes.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ sessao: 'pi-x', unidade_id: 'u1', usuario_nome: 'Fulano', passo: 'internet', estado: 'andamento' });
    expect(data.sistema).toBe('Raspberry nexon-cam (192.168.0.10)');
    expect(m.auditoria.registrar).not.toHaveBeenCalled();
  });

  it('chave inválida não relata', async () => {
    await expect(montar().svc.relatarAparelho({ vinculo: 'vin.ruim' } as any)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
