import { BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { mkdtempSync, rmSync, utimesSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CamerasAgenteService } from './cameras-agente.service';
import { apresentarGravacao, estadoTrecho, ERRO_TRECHO_EXPIRADO, normalizarGravacaoConfig, normalizarGravacaoStatus } from './cameras-regras';
import { CamerasStorageService } from './cameras-storage.service';
import { CamerasTrechosService } from './cameras-trechos.service';
import { HeartbeatDto } from './dto/cameras-agente.dto';
import { EditarCameraDto, PedirTrechoDto } from './dto/cameras.dto';

const AGORA = new Date('2026-11-16T15:00:00Z');
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64)]);

const camera = {
  id: 'c1',
  unidade_id: 'u1',
  planta_id: 'p1',
  agente_id: 'a1' as string | null,
  nome: 'Portão',
  ip: '192.168.0.108',
  gravacao: {},
  deleted_at: null,
};

function montar(opts: { escopo?: string[]; agenteContato?: Date | null; abertos?: number; comando?: Record<string, unknown> | null } = {}) {
  const comandos = new Map<string, any>();
  if (opts.comando) comandos.set(String(opts.comando.id), { ...opts.comando });
  const prisma: any = {
    cameras: { findFirst: jest.fn().mockResolvedValue(camera) },
    cameras_agentes: {
      findFirst: jest.fn().mockResolvedValue(
        opts.agenteContato === null ? null : { id: 'a1', nome: 'Pi da usina', ultimo_contato_em: opts.agenteContato ?? new Date(AGORA.getTime() - 20_000) },
      ),
    },
    cameras_comandos: {
      count: jest.fn().mockResolvedValue(opts.abertos ?? 0),
      create: jest.fn().mockImplementation(async ({ data }) => {
        const c = { estado: 'pendente', erro: null, created_at: AGORA, entregue_em: null, concluido_em: null, ...data };
        comandos.set(c.id, c);
        return c;
      }),
      findFirst: jest.fn().mockImplementation(async ({ where }) => {
        const c = comandos.get(where.id);
        if (!c) return null;
        if (where.tipo && c.tipo !== where.tipo) return null;
        if (where.agente_id && c.agente_id !== where.agente_id) return null;
        return { ...c };
      }),
      update: jest.fn().mockImplementation(async ({ where, data }) => {
        const c = { ...comandos.get(where.id), ...data };
        comandos.set(where.id, c);
        return c;
      }),
      updateMany: jest.fn().mockImplementation(async ({ where, data }) => {
        const c = comandos.get(where.id);
        if (c && where.estado.in.includes(c.estado)) comandos.set(where.id, { ...c, ...data });
        return { count: c ? 1 : 0 };
      }),
    },
  };
  const scope: any = {
    assertEntityInScope: jest.fn().mockImplementation(async (_t: string, id: string) => {
      if (opts.escopo && !opts.escopo.includes(id)) throw new ForbiddenException('fora do escopo');
    }),
  };
  const midia: any = { gerarTokenMidia: jest.fn().mockReturnValue({ token: 'tok.en', valido_ate: 'x' }) };
  const auditoria: any = {
    registrar: jest.fn().mockResolvedValue(undefined),
    contextoUnidade: jest.fn().mockResolvedValue({ unidade: { id: 'u1', nome: 'Fazenda' }, planta: { id: 'p1', nome: 'Planta' } }),
  };
  const storage = new CamerasStorageService();
  const svc = new CamerasTrechosService(prisma, scope, midia, storage, auditoria);
  return { svc, prisma, auditoria, storage, comandos };
}

const user = { id: 'us1', role: 'operador' } as any;
const agente = { id: 'a1', unidade_id: 'u1', planta_id: 'p1', nome: 'Pi da usina' };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'trechos-'));
  process.env.CAMERAS_STORAGE_DIR = dir;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CAMERAS_STORAGE_DIR;
});

describe('PedirTrechoDto', () => {
  const erros = async (body: unknown) => (await validate(plainToInstance(PedirTrechoDto, body))).map((e) => e.property);
  it('aceita inicio ISO e duração 10..300', async () => {
    expect(await erros({ inicio: '2026-11-16T14:00:00Z', duracao_s: 60 })).toEqual([]);
  });
  it('recusa duração fora de 10..300 e inicio que não é data', async () => {
    expect(await erros({ inicio: '2026-11-16T14:00:00Z', duracao_s: 5 })).toEqual(['duracao_s']);
    expect(await erros({ inicio: '2026-11-16T14:00:00Z', duracao_s: 301 })).toEqual(['duracao_s']);
    expect(await erros({ inicio: 'ontem', duracao_s: 60 })).toEqual(['inicio']);
  });
});

describe('CamerasTrechosService.pedir', () => {
  it('cria comando trecho para o agente da câmera, audita e responde pendente', async () => {
    const { svc, prisma, auditoria } = montar();
    const r = await svc.pedir('c1', { inicio: '2026-11-16T14:59:00-00:00', duracao_s: 60 }, user, undefined, AGORA);
    expect(r).toEqual({ comando_id: expect.any(String), estado: 'pendente' });
    expect(prisma.cameras_comandos.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ camera_id: 'c1', agente_id: 'a1', tipo: 'trecho', parametros: { inicio: '2026-11-16T14:59:00.000Z', duracao_s: 60 } }),
    });
    expect(auditoria.registrar).toHaveBeenCalledWith(
      'camera_trecho_pedido',
      expect.objectContaining({
        camera: expect.objectContaining({ id: 'c1' }),
        unidade: { id: 'u1', nome: 'Fazenda' },
        planta: { id: 'p1', nome: 'Planta' },
        extra: expect.objectContaining({ inicio: '2026-11-16T14:59:00.000Z', duracao_s: 60 }),
      }),
    );
  });

  it('recusa câmera fora do escopo do usuário', async () => {
    const { svc } = montar({ escopo: ['outra'] });
    await expect(svc.pedir('c1', { inicio: '2026-11-16T14:00:00Z', duracao_s: 60 }, user, undefined, AGORA)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('recusa inicio no futuro', async () => {
    const { svc } = montar();
    await expect(svc.pedir('c1', { inicio: '2026-11-16T16:00:00Z', duracao_s: 60 }, user, undefined, AGORA)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('aparelho offline → 409 CAMERA_SEM_AGENTE', async () => {
    const { svc, prisma } = montar({ agenteContato: new Date(AGORA.getTime() - 10 * 60_000) });
    await expect(svc.pedir('c1', { inicio: '2026-11-16T14:00:00Z', duracao_s: 60 }, user, undefined, AGORA)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.cameras_comandos.create).not.toHaveBeenCalled();
  });

  it('limite de 3 pedidos abertos por câmera → 429', async () => {
    const { svc, prisma } = montar({ abertos: 3 });
    const p = svc.pedir('c1', { inicio: '2026-11-16T14:00:00Z', duracao_s: 60 }, user, undefined, AGORA);
    await expect(p).rejects.toBeInstanceOf(HttpException);
    await expect(p).rejects.toMatchObject({ status: 429 });
    expect(prisma.cameras_comandos.count).toHaveBeenCalledWith({ where: expect.objectContaining({ camera_id: 'c1', tipo: 'trecho' }) });
    expect(prisma.cameras_comandos.create).not.toHaveBeenCalled();
  });
});

describe('ciclo do trecho: pendente → pronto / erro / expirado', () => {
  const base = { id: 'k1', camera_id: 'c1', agente_id: 'a1', tipo: 'trecho', parametros: { inicio: '2026-11-16T14:00:00.000Z', duracao_s: 60 }, erro: null, entregue_em: null, concluido_em: null };

  it('pendente enquanto o agente não responde', async () => {
    const { svc } = montar({ comando: { ...base, estado: 'entregue', created_at: AGORA, entregue_em: AGORA } });
    const r = await svc.estado('k1', user, new Date(AGORA.getTime() + 60_000));
    expect(r).toEqual({ comando_id: 'k1', estado: 'pendente', inicio: '2026-11-16T14:00:00.000Z', duracao_s: 60 });
  });

  it('agente envia o MP4 → pronto com URL tokenizada que serve o arquivo', async () => {
    const { svc, storage, comandos } = montar({ comando: { ...base, estado: 'entregue', created_at: AGORA, entregue_em: AGORA } });
    const up = await svc.receber(agente, 'k1', { buffer: MP4 } as Express.Multer.File, AGORA);
    expect(up).toMatchObject({ ok: true, comando_id: 'k1' });
    expect(existsSync(storage.absoluto('trechos/k1.mp4'))).toBe(true);
    expect(comandos.get('k1').estado).toBe('ok');
    const r = await svc.estado('k1', user, AGORA);
    expect(r.estado).toBe('pronto');
    expect(r.url).toBe('/api/v1/cameras/trechos/k1/arquivo?token=tok.en');
  });

  it('upload recusa arquivo que não é MP4 e comando de outro agente/tipo', async () => {
    const { svc } = montar({ comando: { ...base, estado: 'entregue', created_at: AGORA } });
    await expect(svc.receber(agente, 'k1', { buffer: Buffer.from('not a video at all') } as Express.Multer.File)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.receber({ ...agente, id: 'a2' }, 'k1', { buffer: MP4 } as Express.Multer.File)).rejects.toBeInstanceOf(NotFoundException);
    const foto = montar({ comando: { ...base, tipo: 'foto', estado: 'entregue', created_at: AGORA } });
    await expect(foto.svc.receber(agente, 'k1', { buffer: MP4 } as Express.Multer.File)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('resultado ok=false do agente → erro com a mensagem', async () => {
    const { svc } = montar({ comando: { ...base, estado: 'erro', erro: 'sem gravação neste horário', created_at: AGORA } });
    expect(await svc.estado('k1', user, AGORA)).toMatchObject({ estado: 'erro', erro: 'sem gravação neste horário' });
  });

  it('sem resposta em 3 min → expirado (e grava no comando)', async () => {
    const { svc, comandos } = montar({ comando: { ...base, estado: 'pendente', created_at: AGORA } });
    const r = await svc.estado('k1', user, new Date(AGORA.getTime() + 181_000));
    expect(r.estado).toBe('expirado');
    expect(comandos.get('k1')).toMatchObject({ estado: 'erro', erro: ERRO_TRECHO_EXPIRADO });
  });

  it('estadoTrecho: ok sem arquivo (apagado em 24 h) vira expirado', () => {
    expect(estadoTrecho({ estado: 'ok', erro: null, created_at: AGORA, entregue_em: AGORA }, false, AGORA)).toBe('expirado');
    expect(estadoTrecho({ estado: 'ok', erro: null, created_at: AGORA, entregue_em: AGORA }, true, AGORA)).toBe('pronto');
  });

  it('limpeza apaga só trechos com mais de 24 h', async () => {
    const { svc, prisma } = montar();
    prisma.cameras_comandos.updateMany = jest.fn().mockResolvedValue({ count: 2 });
    mkdirSync(join(dir, 'trechos'), { recursive: true });
    writeFileSync(join(dir, 'trechos', 'velho.mp4'), MP4);
    writeFileSync(join(dir, 'trechos', 'novo.mp4'), MP4);
    const antigo = new Date(AGORA.getTime() - 25 * 3600_000);
    utimesSync(join(dir, 'trechos', 'velho.mp4'), antigo, antigo);
    utimesSync(join(dir, 'trechos', 'novo.mp4'), AGORA, AGORA);
    expect(await svc.limpar(AGORA)).toEqual({ arquivos: 1, expirados: 2 });
    expect(existsSync(join(dir, 'trechos', 'velho.mp4'))).toBe(false);
    expect(existsSync(join(dir, 'trechos', 'novo.mp4'))).toBe(true);
  });
});

describe('gravação: heartbeat, config e apresentação', () => {
  it('heartbeat grava o status da gravação na câmera sem perder a config', async () => {
    const cam = { ...camera, gravacao: { config: { ativa: true, dias: 10, stream: 'principal' } } };
    const prisma: any = {
      cameras_agentes: { update: jest.fn().mockResolvedValue({}) },
      cameras: { findMany: jest.fn().mockResolvedValue([cam]), update: jest.fn().mockResolvedValue({}) },
    };
    const eventos: any = { marcarOnline: jest.fn().mockResolvedValue(undefined), marcarOffline: jest.fn() };
    const svc = new CamerasAgenteService(prisma, {} as any, {} as any, {} as any, eventos, {} as any, {} as any);
    const dto = plainToInstance(HeartbeatDto, {
      cameras: [{ id: 'c1', online: true, gravacao: { ativa: true, de: '2026-11-10T00:00:00Z', ate: '2026-11-16T14:59:50Z', uso_gb: 98.44, livre_gb: 120 } }],
    });
    expect(await validate(dto)).toEqual([]);
    await svc.heartbeat(agente, dto, AGORA);
    expect(prisma.cameras.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: {
        gravacao: {
          config: { ativa: true, dias: 10, stream: 'principal' },
          status: { ativa: true, de: '2026-11-10T00:00:00.000Z', ate: '2026-11-16T14:59:50.000Z', uso_gb: 98.4, livre_gb: 120, em: AGORA.toISOString() },
        },
      },
    });
  });

  it('heartbeat sem gravacao não mexe na coluna', async () => {
    const prisma: any = {
      cameras_agentes: { update: jest.fn().mockResolvedValue({}) },
      cameras: { findMany: jest.fn().mockResolvedValue([camera]), update: jest.fn() },
    };
    const eventos: any = { marcarOnline: jest.fn().mockResolvedValue(undefined), marcarOffline: jest.fn() };
    const svc = new CamerasAgenteService(prisma, {} as any, {} as any, {} as any, eventos, {} as any, {} as any);
    await svc.heartbeat(agente, { cameras: [{ id: 'c1', online: true }] } as any, AGORA);
    expect(prisma.cameras.update).not.toHaveBeenCalled();
  });

  it('DTO da câmera valida gravacao (dias 1..30, stream secundario|principal)', async () => {
    const props = async (body: unknown) => (await validate(plainToInstance(EditarCameraDto, body))).map((e) => e.property);
    expect(await props({ gravacao: { ativa: false, dias: 7, stream: 'secundario' } })).toEqual([]);
    expect(await props({ gravacao: { dias: 31 } })).toEqual(['gravacao']);
    expect(await props({ gravacao: { stream: 'hd' } })).toEqual(['gravacao']);
  });

  it('normaliza config e status; apresentar junta status + config', () => {
    expect(normalizarGravacaoConfig(undefined)).toEqual({ ativa: true, dias: 7, stream: 'secundario' });
    expect(normalizarGravacaoConfig({ dias: 90, stream: 'x' })).toEqual({ ativa: true, dias: 30, stream: 'secundario' });
    expect(normalizarGravacaoStatus({ ativa: true, de: 'lixo', uso_gb: -1 }, AGORA)).toEqual({
      ativa: true,
      de: null,
      ate: null,
      uso_gb: null,
      livre_gb: null,
      em: AGORA.toISOString(),
    });
    expect(apresentarGravacao({})).toEqual({
      ativa: false,
      de: null,
      ate: null,
      uso_gb: null,
      livre_gb: null,
      em: null,
      config: { ativa: true, dias: 7, stream: 'secundario' },
    });
  });
});
