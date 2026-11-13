import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { CamerasService } from './cameras.service';

const camera = {
  id: 'c1',
  unidade_id: 'u1',
  planta_id: 'p1',
  agente_id: null as string | null,
  equipamento_id: null,
  nome: 'Cabine / SSU',
  fabricante: 'intelbras',
  modelo: null,
  ip: '192.168.0.108',
  porta_rtsp: 554,
  porta_http: 80,
  usuario: 'admin',
  senha: 'v1.cifrada',
  canal: 1,
  ativa: true,
  ordem: 1,
  status: 'online',
  status_em: new Date('2026-11-07T10:00:00Z'),
  ultimo_contato_em: new Date('2026-11-07T11:59:00Z'),
  miniatura_em: null,
  publicando: false,
  stream_pedido_em: null,
  stream_continuo: false,
  stream_transcodificar: false,
  stream_bitrate_kbps: 800,
  analise: {},
  created_at: new Date('2026-11-01T00:00:00Z'),
  updated_at: new Date('2026-11-01T00:00:00Z'),
  deleted_at: null,
};

const configPadrao = {
  unidade_id: 'u1',
  planta_id: 'p1',
  armamento_modo: 'agenda',
  armado_manual: false,
  armado_manual_ate: null as Date | null,
  agenda_inicio: new Date('1970-01-01T18:00:00Z'),
  agenda_fim: new Date('1970-01-01T06:30:00Z'),
  refletor_equipamento_id: 'eq1',
  refletor_ponto_id: 'pt1',
  sirene_equipamento_id: null,
  sirene_ponto_id: null,
  abrir_chamado: false,
  notificar_emails: [] as string[],
  updated_at: new Date(),
  updated_por_id: null,
};

function montar(opts: { escopo?: string[] | null; camera?: Partial<typeof camera> } = {}) {
  const cam = { ...camera, ...(opts.camera ?? {}) };
  const prisma: any = {
    cameras: {
      findMany: jest.fn().mockResolvedValue([cam]),
      findFirst: jest.fn().mockResolvedValue(cam),
      create: jest.fn().mockImplementation(async ({ data }) => ({ ...cam, ...data })),
      update: jest.fn().mockImplementation(async ({ data }) => ({ ...cam, ...data })),
      aggregate: jest.fn().mockResolvedValue({ _max: { ordem: 2 } }),
    },
    cameras_agentes: { findFirst: jest.fn().mockResolvedValue(null) },
    cameras_comandos: {
      create: jest.fn().mockImplementation(async ({ data }) => data),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    equipamentos: { findFirst: jest.fn().mockResolvedValue({ id: 'eq1 ' }) },
    equipamento_pontos: { findFirst: jest.fn().mockResolvedValue({ tipo: 'comando', ativo: true, nome: 'ligar' }) },
    $transaction: jest.fn().mockImplementation((ops: any[]) => Promise.all(ops)),
  };
  const scope: any = {
    assertEntityInScope: jest.fn().mockImplementation(async (_tipo: string, id: string) => {
      if (opts.escopo && !opts.escopo.includes(id.trim())) throw new ForbiddenException('Recurso fora do escopo do usuario');
    }),
  };
  const midia: any = {
    cifrar: jest.fn().mockImplementation((s: string) => `enc:${s}`),
    gerarTokenMidia: jest.fn().mockReturnValue({ token: 'tok.en', valido_ate: 'x' }),
    hlsUrl: jest.fn().mockImplementation((caminho: string, token: string) => `https://m/hls/${caminho}/index.m3u8?token=${token}`),
  };
  const eventos: any = {
    estatisticasPorCamera: jest.fn().mockResolvedValue(new Map([['c1', { nao_lidos: 2, ultimo_alerta_em: new Date('2026-11-07T05:00:00Z') }]])),
    contarNaoLidos: jest.fn().mockResolvedValue(2),
    ultimoAlerta: jest.fn().mockResolvedValue(null),
    contarDesde: jest.fn().mockResolvedValue({ alertas: 1, descartados: 14 }),
  };
  const cmd: any = { acionarPonto: jest.fn().mockResolvedValue({ cmd_id: 'x', status: 'ok', msg: 'rele_3_on' }) };
  const auditoria: any = {
    registrar: jest.fn().mockResolvedValue(undefined),
    contextoUnidade: jest.fn().mockImplementation(async (id: string) =>
      id.trim() === 'u1' || id.trim() === 'u2'
        ? { unidade: { id: id.trim(), nome: 'UFV Boa Vista' }, planta: { id: 'p1', nome: 'Fazenda' } }
        : { unidade: null, planta: null },
    ),
  };
  const storage: any = {
    caminhoMiniatura: jest.fn().mockImplementation((id: string) => `miniaturas/${id}.jpg`),
    servir: jest.fn().mockResolvedValue(undefined),
    remover: jest.fn().mockResolvedValue(undefined),
  };
  // Estado da config como no banco: `armar` muda o que `obter` devolve depois.
  let cfgAtual = { ...configPadrao };
  const config: any = {
    obter: jest.fn().mockImplementation(async () => cfgAtual),
    armar: jest.fn().mockImplementation(async (_u: string, _p: string, armado: boolean, ate: Date | null) => {
      cfgAtual = { ...cfgAtual, armamento_modo: 'manual', armado_manual: armado, armado_manual_ate: ate };
      return cfgAtual;
    }),
    apresentar: jest.fn().mockImplementation((c: any) => ({ unidade_id: c.unidade_id, modo: c.armamento_modo })),
    salvar: jest.fn().mockResolvedValue(configPadrao),
  };
  const service = new CamerasService(prisma, scope, midia, eventos, cmd, auditoria, storage, config);
  return { service, prisma, scope, midia, eventos, cmd, auditoria, storage, config };
}

const admin = { id: 'adm1', nome: 'Diego', email: 'diego@aupus.com', role: 'admin' };
const operador = { id: 'op1', nome: 'Zé', email: 'ze@aupus.com', role: 'operador' };
const cliente: any = { ip: '177.1.2.3', dispositivo: 'iPhone 15 · iOS', userAgent: 'NexON/1.0', aparelho: 'iPhone 15', plataforma: 'iOS' };

describe('CamerasService · escopo', () => {
  it('lista câmeras da unidade com não lidos; fora do escopo é 403', async () => {
    const { service, scope } = montar({ escopo: ['u1'] });
    const lista = await service.listar({ unidade_id: 'u1' }, operador);
    expect(scope.assertEntityInScope).toHaveBeenCalledWith('unidade', 'u1', operador);
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({ id: 'c1', nao_lidos: 2, miniatura_url: '/api/v1/cameras/c1/miniatura', stream: { caminho: 'cam-c1' } });
    expect((lista[0] as any).senha).toBeUndefined();
    await expect(service.listar({ unidade_id: 'u2' }, operador)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('detalhe de câmera cuja unidade está fora do escopo é 403', async () => {
    const { service } = montar({ escopo: ['outra'] });
    await expect(service.detalhe('c1', operador)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('stream marca a câmera como assistida e devolve HLS com token', async () => {
    const { service, prisma } = montar();
    const r = await service.stream('c1', admin);
    expect(prisma.cameras.update.mock.calls[0][0].data.stream_pedido_em).toBeInstanceOf(Date);
    expect(r.hls_url).toBe('https://m/hls/cam-c1/index.m3u8?token=tok.en');
    expect(r.estado).toBe('aguardando');
  });
});

describe('CamerasService · cadastro e auditoria', () => {
  it('operador não cadastra (somente leitura)', async () => {
    const { service, prisma } = montar();
    await expect(
      service.criar({ unidade_id: 'u1', nome: 'Nova', ip: '192.168.0.2', usuario: 'admin', senha: 'x' }, operador),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.cameras.create).not.toHaveBeenCalled();
  });

  it('admin cadastra com senha cifrada, planta da unidade e trilha camera_cadastro', async () => {
    const { service, prisma, auditoria } = montar();
    const r = await service.criar(
      { unidade_id: 'u1 ', nome: ' Arranjo IV3 ', ip: '192.168.0.120', usuario: 'admin', senha: 'segredo', equipamento_id: 'eq1' },
      admin,
      cliente,
    );
    const data = prisma.cameras.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ unidade_id: 'u1', planta_id: 'p1', nome: 'Arranjo IV3', senha: 'enc:segredo', equipamento_id: 'eq1', ordem: 3 });
    // NEXON-108: câmera nova alerta em qualquer detecção e não classifica (IA fora da tela).
    expect(data.analise.classes_alerta).toEqual(['movimento', 'pessoa', 'veiculo', 'animal']);
    expect(data.analise.classificar).toBe(false);
    expect((r as any).senha).toBeUndefined();

    const reg = auditoria.registrar.mock.calls[0];
    expect(reg[0]).toBe('camera_cadastro');
    expect(reg[1].mensagem).toBe('Câmera "Arranjo IV3" (192.168.0.120) cadastrada — UFV Boa Vista (Fazenda)');
    expect(reg[1].camera).toMatchObject({ nome: 'Arranjo IV3', ip: '192.168.0.120' });
    expect(reg[1].unidade).toEqual({ id: 'u1', nome: 'UFV Boa Vista' });
    expect(reg[1].cliente).toBe(cliente);
    expect(reg[1].extra.camera_dados.senha).toBeUndefined();
  });

  it('agente de outra unidade é recusado no cadastro', async () => {
    const { service, prisma } = montar();
    prisma.cameras_agentes.findFirst.mockResolvedValue({ id: 'ag1', unidade_id: 'u2' });
    await expect(
      service.criar({ unidade_id: 'u1', nome: 'X', ip: '1.1.1.1', usuario: 'a', senha: 'b', agente_id: 'ag1' }, admin),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('exclusão lógica grava camera_exclusao e apaga a miniatura', async () => {
    const { service, prisma, auditoria, storage } = montar();
    const r = await service.excluir('c1', admin, cliente);
    expect(r).toEqual({ id: 'c1', excluida: true });
    expect(prisma.cameras.update.mock.calls[0][0].data.deleted_at).toBeInstanceOf(Date);
    expect(storage.remover).toHaveBeenCalledWith('miniaturas/c1.jpg');
    expect(auditoria.registrar.mock.calls[0][0]).toBe('camera_exclusao');
  });
});

describe('CamerasService · comandos', () => {
  it('foto sem agente → 409 CAMERA_SEM_AGENTE com trilha negada', async () => {
    const { service, auditoria, prisma } = montar();
    const erro = await service.foto('c1', admin, cliente).catch((e) => e);
    expect(erro).toBeInstanceOf(ConflictException);
    expect(erro.getResponse()).toMatchObject({ code: 'CAMERA_SEM_AGENTE' });
    expect(prisma.cameras_comandos.create).not.toHaveBeenCalled();
    expect(auditoria.registrar.mock.calls[0][0]).toBe('camera_comando');
    expect(auditoria.registrar.mock.calls[0][1].resultado).toBe('negado');
  });

  it('foto com agente sem contato há mais de 3 min → 409', async () => {
    const { service, prisma } = montar({ camera: { agente_id: 'ag1' } });
    prisma.cameras_agentes.findFirst.mockResolvedValue({ id: 'ag1', nome: 'A', ultimo_contato_em: new Date(Date.now() - 10 * 60_000) });
    await expect(service.foto('c1', admin)).rejects.toBeInstanceOf(ConflictException);
  });

  it('foto com agente em contato cria comando pendente e audita', async () => {
    const { service, prisma, auditoria } = montar({ camera: { agente_id: 'ag1' } });
    prisma.cameras_agentes.findFirst.mockResolvedValue({ id: 'ag1', nome: 'A', ultimo_contato_em: new Date() });
    const r = await service.foto('c1', operador, cliente);
    expect(r.comando_id).toHaveLength(26);
    expect(prisma.cameras_comandos.create.mock.calls[0][0].data).toMatchObject({ camera_id: 'c1', agente_id: 'ag1', tipo: 'foto', solicitado_por_id: 'op1' });
    expect(auditoria.registrar.mock.calls[0][1].mensagem).toContain('Foto pedida à câmera "Cabine / SSU"');
  });

  it('armar manual grava camera_armada com o pedido e devolve o resumo', async () => {
    const { service, config, auditoria } = montar();
    const r = await service.armar('u1', { armado: true }, operador, cliente);
    expect(config.armar).toHaveBeenCalledWith('u1', 'p1', true, null, 'op1', expect.any(Date));
    expect(auditoria.registrar.mock.calls[0][0]).toBe('camera_armada');
    expect(auditoria.registrar.mock.calls[0][1].extra.pedido).toEqual({ armado: true, ate: null });
    expect(r).toMatchObject({ total: 1, online: 1, offline: 0, armado: true, armamento_modo: 'manual', nao_lidos: 2, comandos: { refletor: true, sirene: false } });
    expect(r.noite).toMatchObject({ alertas: 1, descartados: 14 });
  });

  it('desarmar com prazo passado é 400; prazo futuro vira camera_desarmada', async () => {
    const { service, auditoria } = montar();
    await expect(service.armar('u1', { armado: false, ate: '2020-01-01T00:00:00Z' }, admin)).rejects.toBeInstanceOf(BadRequestException);
    await service.armar('u1', { armado: false, ate: new Date(Date.now() + 3600_000).toISOString() }, admin);
    expect(auditoria.registrar.mock.calls[0][0]).toBe('camera_desarmada');
  });

  it('acionar refletor usa o ponto configurado pelo mesmo acionarPonto e audita', async () => {
    const { service, cmd, auditoria } = montar();
    const r = await service.acionar('u1', { dispositivo: 'refletor' }, operador, cliente);
    expect(cmd.acionarPonto).toHaveBeenCalledWith('eq1', 'pt1', { id: 'op1', role: 'operador', nome: 'Zé' }, false, undefined, cliente);
    expect(r).toEqual({ cmd_id: 'x', status: 'ok', msg: 'rele_3_on' });
    expect(auditoria.registrar.mock.calls[0][0]).toBe('camera_comando');
    expect(auditoria.registrar.mock.calls[0][1].extra).toMatchObject({ dispositivo: 'refletor', equipamento_id: 'eq1', ponto_id: 'pt1' });
  });

  it('acionar sirene sem ponto configurado → 400 DISPOSITIVO_NAO_CONFIGURADO', async () => {
    const { service, cmd } = montar();
    const erro = await service.acionar('u1', { dispositivo: 'sirene' }, admin).catch((e) => e);
    expect(erro).toBeInstanceOf(BadRequestException);
    expect(erro.getResponse()).toMatchObject({ code: 'DISPOSITIVO_NAO_CONFIGURADO' });
    expect(cmd.acionarPonto).not.toHaveBeenCalled();
  });

  it('falha do acionamento vira trilha com resultado erro e propaga', async () => {
    const { service, cmd, auditoria } = montar();
    cmd.acionarPonto.mockRejectedValue(new BadRequestException('Broker MQTT desconectado'));
    await expect(service.acionar('u1', { dispositivo: 'refletor' }, admin)).rejects.toBeInstanceOf(BadRequestException);
    expect(auditoria.registrar.mock.calls[0][1].resultado).toBe('erro');
  });

  it('config: operador salva (configOperacional) e ponto que não é comando é recusado', async () => {
    const { service, prisma, config, auditoria } = montar();
    await service.salvarConfig('u1', { armamento: { modo: 'agenda' }, refletor: { equipamento_id: 'eq1', ponto_id: 'pt1' } }, operador, cliente);
    expect(config.salvar).toHaveBeenCalled();
    expect(auditoria.registrar.mock.calls[0][0]).toBe('camera_config');
    prisma.equipamento_pontos.findFirst.mockResolvedValue({ tipo: 'status', ativo: true, nome: 'porta' });
    await expect(
      service.salvarConfig('u1', { armamento: { modo: 'agenda' }, sirene: { equipamento_id: 'eq1', ponto_id: 'pt2' } }, admin),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
