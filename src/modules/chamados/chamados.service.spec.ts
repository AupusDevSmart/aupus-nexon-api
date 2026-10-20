import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ChamadosService } from './chamados.service';

const equipamento = {
  id: 'eq1',
  nome: 'Inversor 1',
  tag: 'INV-01',
  planta_id: null,
  unidade: { id: 'un1', nome: 'Usina A', planta: { id: 'pl1', nome: 'Fazenda', proprietario_id: 'pr1' } },
};

function montar(scope: string[] | null = null) {
  const prisma: any = {
    equipamentos: { findFirst: jest.fn().mockResolvedValue(equipamento), findMany: jest.fn().mockResolvedValue([]) },
    unidades: { findMany: jest.fn().mockResolvedValue([]) },
    plantas: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    usuarios: {
      findFirst: jest.fn().mockResolvedValue({ id: 'pr1', nome: 'Dono', email: 'dono@x.com', telefone: '62999990000' }),
    },
    chamados: {
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...data, numero: 7, created_at: new Date(), encaminhamentos: [] })),
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      groupBy: jest.fn().mockResolvedValue([
        { status: 'ABERTO', _count: { _all: 3 } },
        { status: 'ENCAMINHADO', _count: { _all: 2 } },
      ]),
    },
    chamados_encaminhamentos: { create: jest.fn().mockImplementation(({ data }) => data) },
    $transaction: jest.fn().mockImplementation((ops: any[]) => Promise.all(ops)),
  };
  const scopeService: any = {
    getScope: jest.fn().mockResolvedValue(scope),
    isScoped: (s: any) => Array.isArray(s),
    assertPlantaInScope: jest.fn().mockImplementation(async (p: string) => {
      if (scope && !scope.includes(p)) throw new ForbiddenException();
    }),
  };
  const auditoria: any = { registrar: jest.fn().mockResolvedValue(undefined) };
  return { service: new ChamadosService(prisma, scopeService, auditoria), prisma, auditoria };
}

const user = { id: 'u1', nome: 'Diego', email: 'diego@aupus.com', role: 'admin' };

describe('ChamadosService', () => {
  it('abre chamado com planta/proprietário do equipamento e grava trilha', async () => {
    const { service, prisma, auditoria } = montar();
    const r = await service.abrir({ equipamento_id: 'eq1', titulo: 'Parou', descricao: 'Sem geração' }, user, {
      dispositivo: 'iPhone · iOS',
      aparelho: 'iPhone',
    } as any);
    const data = prisma.chamados.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ planta_id: 'pl1', unidade_id: 'un1', proprietario_id: 'pr1', canal: 'APP', autor_nome: 'Diego' });
    expect(r.equipamento_nome).toBe('Inversor 1 (INV-01)');
    const reg = auditoria.registrar.mock.calls[0][0];
    expect(reg.acao).toBe('chamado_aberto');
    expect(reg.mensagem).toContain('Chamado #7 aberto — Inversor 1 (Fazenda)');
    expect(reg.plantaIds).toEqual(['pl1']);
    expect(reg.detalhes.equipamento).toMatchObject({ id: 'eq1', nome: 'Inversor 1' });
  });

  it('recusa abrir fora do escopo', async () => {
    const { service } = montar(['outra']);
    await expect(service.abrir({ equipamento_id: 'eq1', titulo: 'x', descricao: 'y' }, user)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('encaminha para o WhatsApp do proprietário quando não informam contato', async () => {
    const { service, prisma, auditoria } = montar();
    const c = { id: 'c1', numero: 7, titulo: 'Parou', status: 'ABERTO', motivo: 'FALHA', prioridade: 'MEDIA', equipamento_id: 'eq1', unidade_id: 'un1', planta_id: 'pl1', created_at: new Date(), encaminhamentos: [] };
    prisma.chamados.findFirst.mockResolvedValue(c);
    await service.encaminhar('c1', { destino: 'WHATSAPP' }, user);
    expect(prisma.chamados_encaminhamentos.create.mock.calls[0][0].data).toMatchObject({
      destino: 'WHATSAPP',
      contato: '5562999990000',
      status: 'PENDENTE',
    });
    expect(prisma.chamados.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { status: 'ENCAMINHADO' } });
    const reg = auditoria.registrar.mock.calls[0][0];
    expect(reg.acao).toBe('chamado_encaminhado');
    expect(reg.detalhes.contato_do_proprietario).toBe(true);
  });

  it('não encaminha chamado fechado', async () => {
    const { service, prisma } = montar();
    prisma.chamados.findFirst.mockResolvedValue({ id: 'c1', status: 'FECHADO', planta_id: 'pl1', encaminhamentos: [] });
    await expect(service.encaminhar('c1', { destino: 'EMAIL' }, user)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('fecha com motivo e trilha', async () => {
    const { service, prisma, auditoria } = montar();
    const c = { id: 'c1', numero: 7, titulo: 'Parou', status: 'ENCAMINHADO', motivo: 'FALHA', prioridade: 'MEDIA', equipamento_id: 'eq1', unidade_id: 'un1', planta_id: 'pl1', created_at: new Date(), encaminhamentos: [] };
    prisma.chamados.findFirst.mockResolvedValue(c);
    prisma.chamados.update.mockResolvedValue({ ...c, status: 'FECHADO', motivo_fechamento: 'Trocado fusível' });
    await service.fechar('c1', { motivo: 'Trocado fusível' }, user);
    expect(prisma.chamados.update.mock.calls[0][0].data).toMatchObject({ status: 'FECHADO', fechado_por_nome: 'Diego' });
    const reg = auditoria.registrar.mock.calls[0][0];
    expect(reg.acao).toBe('chamado_fechado');
    expect(reg.mensagem).toContain('Chamado #7 fechado');
  });

  it('contagem soma abertos e encaminhados', async () => {
    const { service } = montar();
    expect(await service.contagem(user)).toEqual({ abertos: 5, aguardando_encaminhamento: 3, encaminhados: 2 });
  });

  it('esconde chamado de planta fora do escopo', async () => {
    const { service, prisma } = montar(['outra']);
    prisma.chamados.findFirst.mockResolvedValue({ id: 'c1', planta_id: 'pl1', encaminhamentos: [] });
    await expect(service.detalhe('c1', user)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
