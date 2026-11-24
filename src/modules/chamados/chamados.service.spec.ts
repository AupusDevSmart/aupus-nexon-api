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
    unidades: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    plantas: { findFirst: jest.fn().mockResolvedValue({ id: 'pl1', nome: 'Fazenda', proprietario_id: 'pr1' }), findMany: jest.fn().mockResolvedValue([]) },
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
    chamados_atualizacoes: { create: jest.fn().mockImplementation(({ data }) => data), findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn().mockImplementation((ops: any[]) => Promise.all(ops)),
  };
  const scopeService: any = {
    getScope: jest.fn().mockResolvedValue(scope),
    getEquipamentosScope: jest.fn().mockResolvedValue(null),
    getUnidadesScope: jest.fn().mockResolvedValue(null),
    assertEquipamentoLiberado: jest.fn().mockResolvedValue(undefined),
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
    expect(reg.mensagem).toContain('Chamado #7 aberto — Inversor 1 · Usina A · Fazenda');
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
    expect(await service.contagem(user)).toEqual({ abertos: 5, aguardando_encaminhamento: 3, encaminhados: 2, externos_abertos: 0 });
  });

  it('esconde chamado de planta fora do escopo', async () => {
    const { service, prisma } = montar(['outra']);
    prisma.chamados.findFirst.mockResolvedValue({ id: 'c1', planta_id: 'pl1', encaminhamentos: [] });
    await expect(service.detalhe('c1', user)).rejects.toBeInstanceOf(ForbiddenException);
  });

  describe('chamado externo (NEXON-144)', () => {
    const externo = {
      id: 'c9', numero: 9, tipo: 'EXTERNO', status: 'ABERTO', motivo: 'FALTA_ENERGIA', prioridade: 'ALTA',
      titulo: 'Falta de energia', descricao: 'Rua sem luz', orgao: 'Equatorial', protocolo: '123', equipamento_id: null,
      unidade_id: null, planta_id: 'pl1', autor_id: 'u2', autor_nome: 'Ana', ocorrencia_em: new Date('2026-11-20T13:00:00Z'),
      aberto_em: new Date('2026-11-20T13:30:00Z'), previsao_em: null, fechado_em: null, created_at: new Date('2026-11-20T13:31:00Z'),
      encaminhamentos: [],
    };

    it('abre só com a planta, órgão e protocolo; trilha com órgão e protocolo', async () => {
      const { service, prisma, auditoria } = montar();
      await service.abrir(
        { tipo: 'EXTERNO', planta_id: 'pl1', orgao: 'Equatorial', protocolo: '123', titulo: 'Falta de energia', descricao: 'Rua sem luz' },
        user,
      );
      const data = prisma.chamados.create.mock.calls[0][0].data;
      expect(data).toMatchObject({ tipo: 'EXTERNO', equipamento_id: null, planta_id: 'pl1', orgao: 'Equatorial', motivo: 'FALTA_ENERGIA' });
      expect(data.aberto_em).toBeInstanceOf(Date);
      const reg = auditoria.registrar.mock.calls[0][0];
      expect(reg.mensagem).toContain('Chamado #7 (Equatorial, protocolo 123) aberto — Fazenda');
      expect(reg).toMatchObject({ objetoTipo: 'chamado', autorNome: 'Diego' });
    });

    it('externo sem órgão e interno sem equipamento são recusados', async () => {
      const { service } = montar();
      await expect(service.abrir({ tipo: 'EXTERNO', planta_id: 'pl1', titulo: 'x', descricao: 'y' }, user)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.abrir({ titulo: 'x', descricao: 'y' } as any, user)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('sem usuário grava como ação do NexON', async () => {
      const { service, prisma } = montar();
      await service.abrir({ tipo: 'EXTERNO', planta_id: 'pl1', orgao: 'Equatorial', titulo: 'Falta', descricao: 'TON sem rede' });
      expect(prisma.chamados.create.mock.calls[0][0].data.autor_nome).toBe('NexON (automático)');
    });

    it('resolver grava fechado_em, linha do tempo e duração na trilha', async () => {
      const { service, prisma, auditoria } = montar();
      prisma.chamados.findFirst.mockResolvedValue(externo);
      prisma.chamados.update.mockImplementation(({ data }: any) => Promise.resolve({ ...externo, ...data }));
      await service.mudarStatus('c9', { status: 'RESOLVIDO', texto: 'Religou', quando: '2026-11-20T17:00:00Z' }, user);
      const upd = prisma.chamados.update.mock.calls[0][0].data;
      expect(upd).toMatchObject({ status: 'RESOLVIDO', fechado_por_nome: 'Diego', motivo_fechamento: 'Religou' });
      expect(prisma.chamados_atualizacoes.create.mock.calls[0][0].data).toMatchObject({ tipo: 'STATUS', status_anterior: 'ABERTO', status_novo: 'RESOLVIDO' });
      const reg = auditoria.registrar.mock.calls[0][0];
      expect(reg.acao).toBe('chamado_status');
      expect(reg.mensagem).toContain('Aberto → Resolvido');
      expect(reg.detalhes.duracao_horas).toBe(4);
    });

    it('externo não é encaminhado nem fechado pelo fluxo do reparo', async () => {
      const { service, prisma } = montar();
      prisma.chamados.findFirst.mockResolvedValue(externo);
      await expect(service.fechar('c9', { motivo: 'x' }, user)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.encaminhar('c9', { destino: 'SMART_SERVICE' }, user)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('edição grava só o que mudou (antes → depois)', async () => {
      const { service, prisma, auditoria } = montar();
      prisma.chamados.findFirst.mockResolvedValue(externo);
      prisma.chamados.update.mockImplementation(({ data }: any) => Promise.resolve({ ...externo, ...data }));
      await service.editar('c9', { protocolo: '456', titulo: 'Falta de energia' }, user);
      const reg = auditoria.registrar.mock.calls[0][0];
      expect(reg.acao).toBe('chamado_editado');
      expect(reg.detalhes.alteracoes).toEqual([{ campo: 'protocolo', antes: '123', depois: '456' }]);
    });

    it('excluir: só autor ou administrador', async () => {
      const { service, prisma } = montar();
      prisma.chamados.findFirst.mockResolvedValue(externo);
      await expect(service.excluir('c9', { motivo: 'duplicado' }, { id: 'u9', role: 'proprietario' } as any)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.excluir('c9', { motivo: 'duplicado' }, user)).resolves.toEqual({ ok: true });
    });
  });
});
