import { HttpException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  analiseNovaCamera,
  chaveLimiteIp,
  expandirIpv6,
  ipPrivadoOuLinkLocal,
  mascararCodigo,
  deveEntregarToken,
  descobertasPendentes,
  estadoPareamento,
  gerarCodigoUnico,
  LimitadorPorMinuto,
  mesmoIp,
  normalizarAnalise,
  normalizarCodigo,
  normalizarDescobertas,
} from './cameras-regras';
import { CamerasPareamentoService } from './cameras-pareamento.service';

const agora = new Date('2026-11-13T12:00:00Z');
const min = (n: number) => new Date(agora.getTime() + n * 60_000);

describe('analiseNovaCamera (câmera nova: qualquer detecção alerta, sem IA)', () => {
  it('sem análise no dto → pessoa/veículo/animal e classificar=true', () => {
    const a = analiseNovaCamera(undefined);
    expect(a.classes_alerta).toEqual(['pessoa', 'veiculo', 'animal']);
    expect(a.classificar).toBe(true);
    expect(a.ativa).toBe(true);
  });

  it('front manda só {ativa, sensibilidade}; chaves undefined não apagam o padrão', () => {
    const a = analiseNovaCamera({ ativa: true, sensibilidade: 80, classificar: undefined, classes_alerta: undefined });
    expect(a.sensibilidade).toBe(80);
    expect(a.classificar).toBe(true);
    expect(a.classes_alerta).toHaveLength(3);
  });

  it('o que vier explícito vale', () => {
    const a = analiseNovaCamera({ classificar: true, classes_alerta: ['pessoa'] });
    expect(a.classificar).toBe(true);
    expect(a.classes_alerta).toEqual(['pessoa']);
  });

  it('câmera existente (normalizarAnalise) não muda de padrão', () => {
    expect(normalizarAnalise({}).classes_alerta).toEqual(['pessoa', 'veiculo']);
    expect(normalizarAnalise({}).classificar).toBe(true);
  });
});

describe('gerarCodigoUnico', () => {
  it('6 dígitos com zero à esquerda', () => {
    expect(gerarCodigoUnico([], () => 42)).toBe('000042');
  });

  it('pula código em uso entre os pedidos não expirados', () => {
    const sorteios = [123456, 123456, 654321];
    expect(gerarCodigoUnico(['123456'], () => sorteios.shift()!)).toBe('654321');
  });

  it('sem código livre depois das tentativas → erro', () => {
    expect(() => gerarCodigoUnico(['000001'], () => 1, 5)).toThrow();
  });

  it('códigos gerados em sequência não se repetem', () => {
    const usados: string[] = [];
    for (let i = 0; i < 200; i++) usados.push(gerarCodigoUnico(usados, () => Math.floor(Math.random() * 1_000_000)));
    expect(new Set(usados).size).toBe(200);
  });

  it('normalizarCodigo aceita espaço e recusa tamanho errado', () => {
    expect(normalizarCodigo(' 123 456 ')).toBe('123456');
    expect(normalizarCodigo('12345')).toBeNull();
    expect(normalizarCodigo(undefined)).toBeNull();
  });
});

describe('estado do pedido: aguardando → vinculado → token uma vez → expirado', () => {
  const base = { expira_em: min(30), agente_id: null as string | null, vinculado_em: null as Date | null };

  it('aguardando dentro do prazo, expirado depois', () => {
    expect(estadoPareamento(base, agora)).toBe('aguardando');
    expect(estadoPareamento(base, min(31))).toBe('expirado');
  });

  it('reservado (vinculado_em sem agente ainda) continua aguardando', () => {
    expect(estadoPareamento({ ...base, vinculado_em: agora }, agora)).toBe('aguardando');
  });

  it('vinculado vale mesmo depois do prazo (token pego no último minuto)', () => {
    const v = { ...base, agente_id: 'ag1', vinculado_em: min(29) };
    expect(estadoPareamento(v, min(31))).toBe('vinculado');
  });

  it('token só sai uma vez', () => {
    const v = { ...base, agente_id: 'ag1', vinculado_em: agora, token_cifrado: 'v1.x', entregue_em: null as Date | null };
    expect(deveEntregarToken(v, agora)).toBe(true);
    expect(deveEntregarToken({ ...v, entregue_em: agora, token_cifrado: null }, agora)).toBe(false);
    expect(deveEntregarToken({ ...base, token_cifrado: 'v1.x', entregue_em: null }, agora)).toBe(false);
  });
});

describe('mesmoIp (aparelho encontrado nesta rede)', () => {
  it('compara sem ::ffff: e sem caixa', () => {
    expect(mesmoIp('::ffff:189.1.2.3', '189.1.2.3')).toBe(true);
    expect(mesmoIp('2804:ABCD::1', '2804:abcd::1')).toBe(true);
    expect(mesmoIp('189.1.2.3', '189.1.2.4')).toBe(false);
    expect(mesmoIp(null, null)).toBe(false);
  });
});

describe('LimitadorPorMinuto', () => {
  it('10 por minuto por IP; janela desliza', () => {
    const l = new LimitadorPorMinuto(10);
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) expect(l.permitir('1.1.1.1', t0 + i)).toBe(true);
    expect(l.permitir('1.1.1.1', t0 + 100)).toBe(false);
    expect(l.permitir('2.2.2.2', t0 + 100)).toBe(true);
    expect(l.permitir('1.1.1.1', t0 + 60_001)).toBe(true);
  });

  it('mapa tem teto: chaves velhas saem primeiro', () => {
    const l = new LimitadorPorMinuto(1, 60_000, 100);
    for (let i = 0; i < 500; i++) l.permitir(`ip-${i}`, 1_000 + i);
    expect(l.tamanho).toBeLessThanOrEqual(100);
    expect(l.permitir('ip-499', 2_000)).toBe(false); // a mais nova continua contada
    expect(l.permitir('ip-0', 2_000)).toBe(true); // a mais antiga foi descartada
  });

  it('excedido/registrar contam só falhas (limite por usuário)', () => {
    const l = new LimitadorPorMinuto(5, 10 * 60_000);
    for (let i = 0; i < 5; i++) {
      expect(l.excedido('u1', i)).toBe(false);
      l.registrar('u1', i);
    }
    expect(l.excedido('u1', 10)).toBe(true);
    expect(l.excedido('u1', 10 * 60_000 + 10)).toBe(false);
  });
});

describe('chave do limite por IP', () => {
  it('IPv4 inteiro, IPv4 mapeado vira IPv4', () => {
    expect(chaveLimiteIp('189.1.2.3')).toBe('189.1.2.3');
    expect(chaveLimiteIp('::ffff:189.1.2.3')).toBe('189.1.2.3');
    expect(chaveLimiteIp(null)).toBe('sem-ip');
  });

  it('IPv6 agrupa pelo prefixo /64', () => {
    const a = chaveLimiteIp('2804:14c:65a1:4000::1');
    expect(a).toBe('2804:014c:65a1:4000::/64');
    expect(chaveLimiteIp('2804:14c:65a1:4000:aaaa:bbbb:cccc:dddd')).toBe(a);
    expect(chaveLimiteIp('2804:14c:65a1:4001::1')).not.toBe(a);
  });

  it('expandirIpv6 recusa lixo', () => {
    expect(expandirIpv6('::1')).toEqual(['0000', '0000', '0000', '0000', '0000', '0000', '0000', '0001']);
    expect(expandirIpv6('1::2::3')).toBeNull();
    expect(expandirIpv6('1.2.3.4')).toBeNull();
    expect(expandirIpv6('zz::1')).toBeNull();
  });
});

describe('mascararCodigo', () => {
  it('só os 2 últimos dígitos aparecem', () => {
    expect(mascararCodigo('123456')).toBe('****56');
    expect(mascararCodigo('123 456')).toBe('****56');
    expect(mascararCodigo('7')).toBe('*');
    expect(mascararCodigo(undefined)).toBeNull();
  });
});

describe('descobertas da rede', () => {
  it('só IPv4 privado ou link-local', () => {
    for (const ip of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.108', '169.254.10.20']) {
      expect(ipPrivadoOuLinkLocal(ip)).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '127.0.0.1', '192.169.0.1', '0.0.0.0', 'fe80::1', 'camera.local', '10.0.0']) {
      expect(ipPrivadoOuLinkLocal(ip)).toBe(false);
    }
  });

  it('normalizarDescobertas descarta IP público, loopback e IPv6', () => {
    const r = normalizarDescobertas([{ ip: '8.8.8.8' }, { ip: '127.0.0.1' }, { ip: 'fe80::1' }, { ip: '169.254.1.1' }]);
    expect(r.map((d) => d.ip)).toEqual(['169.254.1.1']);
  });

  it('normalizarDescobertas valida, saneia e deduplica por IP', () => {
    const r = normalizarDescobertas([
      { ip: '192.168.1.108', mac: 'AA-BB-CC-DD-EE-FF', fabricante: 'Intelbras', porta_http: 80, porta_rtsp: 554, inicializada: true },
      { ip: '192.168.1.108', fabricante: 'intelbras', modelo: 'VIP 1230' },
      { ip: '999.1.1.1' },
      { ip: 'abc' },
      null,
      { ip: '192.168.1.20', mac: 'lixo', porta_http: 70000, porta_rtsp: '554', inicializada: 'sim' },
    ]);
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({
      ip: '192.168.1.108',
      mac: null,
      fabricante: 'intelbras',
      modelo: 'VIP 1230',
      serial: null,
      porta_http: null,
      porta_rtsp: null,
      inicializada: null,
    });
    expect(r[1]).toMatchObject({ ip: '192.168.1.20', mac: null, porta_http: null, porta_rtsp: null, inicializada: null });
    expect(normalizarDescobertas([{ ip: '10.0.0.1', mac: 'AA-BB-CC-DD-EE-FF', fabricante: 'ONVIF' }])[0]).toMatchObject({
      mac: 'aa:bb:cc:dd:ee:ff',
      fabricante: 'onvif',
    });
  });

  it('no máximo 64 itens; não-array vira lista vazia', () => {
    const muitos = Array.from({ length: 80 }, (_, i) => ({ ip: `10.0.${Math.floor(i / 250)}.${(i % 250) + 1}` }));
    expect(normalizarDescobertas(muitos)).toHaveLength(64);
    expect(normalizarDescobertas('x')).toEqual([]);
  });

  it('descobertasPendentes tira IP já cadastrado e o que é mais velho que 24 h', () => {
    const lista = [
      { ip: '192.168.1.108', visto_em: min(-5) },
      { ip: '192.168.1.109', visto_em: min(-5) },
      { ip: '192.168.1.110', visto_em: min(-25 * 60) },
    ];
    expect(descobertasPendentes(lista, [' 192.168.1.108 '], agora).map((d) => d.ip)).toEqual(['192.168.1.109']);
  });
});

describe('CamerasPareamentoService', () => {
  const sha = (v: string) => createHash('sha256').update(v).digest('hex');

  function montar(pedido: Record<string, unknown> | null) {
    let atual = pedido ? { ...pedido } : null;
    const prisma: any = {
      cameras_pareamentos: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockImplementation(async () => (atual ? { ...atual } : null)),
        findFirst: jest.fn().mockImplementation(async () => (atual ? { ...atual } : null)),
        create: jest.fn().mockImplementation(async ({ data }) => data),
        update: jest.fn().mockImplementation(async ({ data }) => (atual = { ...atual!, ...data })),
        updateMany: jest.fn().mockImplementation(async ({ where, data }) => {
          if (!atual) return { count: 0 };
          const casa = Object.entries(where).every(([k, v]) => k === 'id' || (atual as any)[k] === v);
          if (!casa) return { count: 0 };
          atual = { ...atual, ...data };
          return { count: 1 };
        }),
      },
      cameras_agentes: { findFirst: jest.fn().mockResolvedValue({ id: 'ag1', nome: 'pi-portaria' }) },
    };
    const midia: any = { cifrar: (t: string) => `c:${t}`, decifrar: (c: string | null) => (c ? c.slice(2) : '') };
    const agentes: any = {
      exigirCadastroTecnico: jest.fn(),
      inserirAgente: jest.fn().mockResolvedValue({ agente: { id: 'ag1', nome: 'pi-portaria' }, token: 'nxcam_abc' }),
      apresentar: jest.fn().mockImplementation((a) => ({ id: a.id, nome: a.nome })),
    };
    const auditoria: any = {
      contextoUnidade: jest.fn().mockResolvedValue({ unidade: { id: 'u1', nome: 'Fazenda' }, planta: { id: 'p1', nome: 'Planta' } }),
      registrar: jest.fn(),
    };
    const scope: any = { assertEntityInScope: jest.fn() };
    const svc = new CamerasPareamentoService(prisma, scope, midia, agentes, auditoria);
    return { svc, prisma, agentes, auditoria, atual: () => atual, trocar: (p: Record<string, unknown> | null) => (atual = p) };
  }

  const cliente: any = { ip: '189.1.2.3', dispositivo: 'Web' };
  const pedido = {
    id: 'pd1',
    codigo: '123456',
    segredo_hash: sha('s3gredo'),
    host: 'pi-portaria',
    mac: 'aa:bb:cc:dd:ee:ff',
    versao: '1.0.0',
    ip_publico: '189.1.2.3',
    ip_local: '192.168.1.50',
    criado_em: agora,
    expira_em: min(30),
    agente_id: null,
    token_cifrado: null,
    vinculado_em: null,
    entregue_em: null,
  };

  it('pedir devolve segredo e código; grava só o hash do segredo e o IP do cliente', async () => {
    const { svc, prisma } = montar(null);
    const r = await svc.pedir({ host: 'pi-portaria' }, cliente, agora);
    expect(r.codigo).toMatch(/^\d{6}$/);
    expect(r.segredo.length).toBeGreaterThanOrEqual(43);
    const data = prisma.cameras_pareamentos.create.mock.calls[0][0].data;
    expect(data.segredo_hash).toBe(sha(r.segredo));
    expect(data.ip_publico).toBe('189.1.2.3');
    expect(data.expira_em).toEqual(min(30));
  });

  it('pedir passa de 10 por minuto no mesmo IP → 429', async () => {
    const { svc } = montar(null);
    for (let i = 0; i < 10; i++) await svc.pedir({ host: 'pi' }, { ...cliente, ip: '7.7.7.7' }, agora);
    await expect(svc.pedir({ host: 'pi' }, { ...cliente, ip: '7.7.7.7' }, agora)).rejects.toBeInstanceOf(HttpException);
  });

  it('segredo errado → 404', async () => {
    const { svc } = montar(pedido);
    await expect(svc.estado('pd1', { segredo: 'errado' }, cliente, agora)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('fluxo completo: aguardando → vincular → token uma vez → depois sem token', async () => {
    const { svc, agentes, auditoria, atual } = montar(pedido);
    expect(await svc.estado('pd1', { segredo: 's3gredo' }, cliente, agora)).toMatchObject({ estado: 'aguardando', codigo: '123456' });

    const v = await svc.vincular({ codigo: '123 456', unidade_id: 'u1' }, { id: 'us1' } as any, cliente, min(1));
    expect(v.agente).toEqual({ id: 'ag1', nome: 'pi-portaria' });
    expect(agentes.inserirAgente).toHaveBeenCalledWith('u1', 'p1', 'pi-portaria', { host: 'pi-portaria', versao: '1.0.0' });
    expect(atual()).toMatchObject({ agente_id: 'ag1', token_cifrado: 'c:nxcam_abc' });
    expect(auditoria.registrar).toHaveBeenCalledWith('camera_agente_pareado', expect.objectContaining({ objetoId: 'ag1' }));
    expect(auditoria.registrar.mock.calls[0][1].mensagem).toContain('123456');

    const primeira = await svc.estado('pd1', { segredo: 's3gredo' }, cliente, min(2));
    expect(primeira).toMatchObject({ estado: 'vinculado', token: 'nxcam_abc', agente: { id: 'ag1', nome: 'pi-portaria' } });
    expect(atual()).toMatchObject({ token_cifrado: null, entregue_em: min(2) });

    const segunda = await svc.estado('pd1', { segredo: 's3gredo' }, cliente, min(3));
    expect(segunda).toMatchObject({ estado: 'vinculado' });
    expect(segunda).not.toHaveProperty('token');
  });

  it('vincular código inexistente/expirado → 404 com a mensagem do contrato', async () => {
    const { svc } = montar(null);
    await expect(svc.vincular({ codigo: '000000', unidade_id: 'u1' }, undefined, cliente, agora)).rejects.toThrow(
      'Código não encontrado ou expirado',
    );
  });

  it('pedido sem vínculo depois do prazo → expirado', async () => {
    const { svc } = montar(pedido);
    expect(await svc.estado('pd1', { segredo: 's3gredo' }, cliente, min(31))).toMatchObject({ estado: 'expirado' });
  });

  it('pedir: mesmo /64 IPv6 divide o limite de 10/min', async () => {
    const { svc } = montar(null);
    for (let i = 0; i < 10; i++) await svc.pedir({ host: 'pi' }, { ...cliente, ip: `2804:14c:65a1:4000::${i + 1}` }, agora);
    await expect(svc.pedir({ host: 'pi' }, { ...cliente, ip: '2804:14c:65a1:4000::ff' }, agora)).rejects.toMatchObject({ status: 429 });
    await expect(svc.pedir({ host: 'pi' }, { ...cliente, ip: '2804:14c:65a1:4001::1' }, agora)).resolves.toBeTruthy();
  });

  it('pedir: 500 pedidos aguardando → 503', async () => {
    const { svc, prisma } = montar(null);
    prisma.cameras_pareamentos.count.mockResolvedValueOnce(0).mockResolvedValueOnce(500);
    await expect(svc.pedir({ host: 'pi' }, { ...cliente, ip: '5.5.5.5' }, agora)).rejects.toMatchObject({ status: 503 });
    expect(prisma.cameras_pareamentos.create).not.toHaveBeenCalled();
  });

  it('pedir: 10 pedidos aguardando da mesma rede → 429 (antes do teto global)', async () => {
    const { svc, prisma } = montar(null);
    prisma.cameras_pareamentos.count.mockResolvedValueOnce(10);
    await expect(svc.pedir({ host: 'pi' }, { ...cliente, ip: '6.6.6.6' }, agora)).rejects.toMatchObject({ status: 429 });
    expect(prisma.cameras_pareamentos.create).not.toHaveBeenCalled();
  });

  it('proximos devolve pedido_id e NÃO devolve codigo', async () => {
    const { svc, prisma } = montar(pedido);
    prisma.cameras_pareamentos.findMany.mockResolvedValue([pedido]);
    const r = await svc.proximos({ id: 'us1' } as any, cliente, agora);
    expect(r).toEqual([
      { pedido_id: 'pd1', host: 'pi-portaria', mac: 'aa:bb:cc:dd:ee:ff', ip_local: '192.168.1.50', criado_em: agora, expira_em: min(30) },
    ]);
    expect(r[0]).not.toHaveProperty('codigo');
    expect(prisma.cameras_pareamentos.findMany.mock.calls[0][0].where.ip_publico).toBe('189.1.2.3');
  });

  it('vincular por pedido_id na mesma rede funciona e audita a via', async () => {
    const { svc, auditoria, atual } = montar(pedido);
    const r = await svc.vincular({ pedido_id: 'pd1', unidade_id: 'u1' }, { id: 'us1' } as any, cliente, min(1));
    expect(r.agente.id).toBe('ag1');
    expect(atual()).toMatchObject({ agente_id: 'ag1' });
    const [acao, reg] = auditoria.registrar.mock.calls[0];
    expect(acao).toBe('camera_agente_pareado');
    expect(reg.extra.via).toBe('pedido_id');
  });

  it('vincular por pedido_id de outra rede → 404 e falha auditada', async () => {
    const { svc, agentes, auditoria } = montar(pedido);
    await expect(
      svc.vincular({ pedido_id: 'pd1', unidade_id: 'u1' }, { id: 'us1' } as any, { ...cliente, ip: '200.9.9.9' }, min(1)),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(agentes.inserirAgente).not.toHaveBeenCalled();
    const [acao, reg] = auditoria.registrar.mock.calls[0];
    expect(acao).toBe('camera_pareamento_falha');
    expect(reg).toMatchObject({ resultado: 'negado', user: { id: 'us1' }, extra: { via: 'pedido_id', motivo: 'pedido de outra rede' } });
    expect(reg.cliente.ip).toBe('200.9.9.9');
  });

  it('vincular por código funciona de outra rede (código digitado do aparelho)', async () => {
    const { svc, auditoria } = montar(pedido);
    await svc.vincular({ codigo: '123456', unidade_id: 'u1' }, { id: 'us1' } as any, { ...cliente, ip: '200.9.9.9' }, min(1));
    expect(auditoria.registrar.mock.calls[0][0]).toBe('camera_agente_pareado');
    expect(auditoria.registrar.mock.calls[0][1].extra.via).toBe('codigo');
  });

  it('codigo e pedido_id juntos (ou nenhum) → 400', async () => {
    const { svc } = montar(pedido);
    await expect(svc.vincular({ codigo: '123456', pedido_id: 'pd1', unidade_id: 'u1' }, undefined, cliente, agora)).rejects.toMatchObject({
      status: 400,
    });
    await expect(svc.vincular({ unidade_id: 'u1' }, undefined, cliente, agora)).rejects.toMatchObject({ status: 400 });
  });

  it('código errado: falha auditada com código mascarado; 5 erros em 10 min → 429 para o usuário', async () => {
    const { svc, auditoria } = montar(null);
    const user = { id: 'us-err' } as any;
    for (let i = 0; i < 5; i++) {
      await expect(svc.vincular({ codigo: '98765' + i, unidade_id: 'u-a' }, user, cliente, min(i))).rejects.toBeInstanceOf(NotFoundException);
    }
    const [acao, reg] = auditoria.registrar.mock.calls[0];
    expect(acao).toBe('camera_pareamento_falha');
    expect(reg.extra.codigo_tentado).toBe('****50');
    expect(reg.mensagem).toContain('****50');
    expect(reg.mensagem).not.toContain('987650');
    expect(reg.cliente.ip).toBe('189.1.2.3');

    await expect(svc.vincular({ codigo: '123456', unidade_id: 'u-b' }, user, cliente, min(6))).rejects.toMatchObject({
      status: 429,
      message: 'Muitas tentativas; aguarde alguns minutos',
    });
    // Outro usuário em outra unidade segue livre; depois de 10 min o mesmo usuário volta.
    await expect(svc.vincular({ codigo: '123456', unidade_id: 'u-c' }, { id: 'us-ok' } as any, cliente, min(6))).rejects.toMatchObject({
      status: 404,
    });
    await expect(svc.vincular({ codigo: '123456', unidade_id: 'u-b' }, user, cliente, min(15))).rejects.toMatchObject({ status: 404 });
  });

  it('limite por unidade: 20 falhas de usuários diferentes → 429 na unidade', async () => {
    const { svc } = montar(null);
    for (let i = 0; i < 20; i++) {
      await expect(svc.vincular({ codigo: '111111', unidade_id: 'u-x' }, { id: `us${i}` } as any, cliente, agora)).rejects.toMatchObject({
        status: 404,
      });
    }
    await expect(svc.vincular({ codigo: '111111', unidade_id: 'u-x' }, { id: 'novo' } as any, cliente, agora)).rejects.toMatchObject({
      status: 429,
    });
  });
});

describe('LimitadorPorMinuto.desfazer (NEXON-108)', () => {
  it('reserva antes do await e devolve a tentativa que deu certo', () => {
    const { LimitadorPorMinuto } = require('./cameras-regras');
    const l = new LimitadorPorMinuto(2, 60_000);
    expect(l.permitir('u', 1000)).toBe(true);
    expect(l.permitir('u', 1001)).toBe(true);
    expect(l.permitir('u', 1002)).toBe(false); // corrida: a terceira simultânea já é barrada
    l.desfazer('u', 1001);
    expect(l.permitir('u', 1003)).toBe(true);
  });
});
