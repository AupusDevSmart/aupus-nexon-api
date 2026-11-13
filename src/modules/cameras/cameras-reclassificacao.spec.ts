import { BadRequestException } from '@nestjs/common';
import { CamerasEventosService } from './cameras-eventos.service';
import { decidirReclassificacao, interpretarCaixas, tipoReclassificado } from './cameras-regras';

/** NEXON-108: evento aberto como `movimento` e reconhecido depois pelo agente. */

const analise = { classificar: true, classes_alerta: ['pessoa', 'veiculo', 'animal'], clipe_s: 12 };

describe('tipoReclassificado', () => {
  it('sobe de movimento para pessoa/veiculo/animal', () => {
    expect(tipoReclassificado('movimento', 'veiculo')).toBe('veiculo');
    expect(tipoReclassificado('movimento', 'pessoa')).toBe('pessoa');
    expect(tipoReclassificado('movimento', 'animal')).toBe('animal');
  });

  it('nunca rebaixa nem troca classe, nem mexe em sistema/foto', () => {
    expect(tipoReclassificado('movimento', 'movimento')).toBeNull();
    expect(tipoReclassificado('pessoa', 'veiculo')).toBeNull();
    expect(tipoReclassificado('veiculo', 'movimento')).toBeNull();
    expect(tipoReclassificado('sem_sinal', 'pessoa')).toBeNull();
    expect(tipoReclassificado('foto', 'pessoa')).toBeNull();
    expect(tipoReclassificado('movimento', 'sem_sinal')).toBeNull();
    expect(tipoReclassificado('movimento', undefined)).toBeNull();
  });
});

describe('decidirReclassificacao', () => {
  it('classe em classes_alerta e armado → alerta e notifica', () => {
    expect(decidirReclassificacao('veiculo', false, true, analise)).toEqual({
      alerta: true,
      descartado: false,
      motivo_descarte: null,
      enviar_clipe: true,
      notificar: true,
    });
  });

  it('desarmado → descartado, sem aviso', () => {
    const d = decidirReclassificacao('pessoa', false, false, analise);
    expect(d).toMatchObject({ alerta: false, descartado: true, motivo_descarte: 'desarmado', notificar: false });
  });

  it('classe fora de classes_alerta → classe_ignorada', () => {
    const d = decidirReclassificacao('animal', false, true, { classes_alerta: ['pessoa'] });
    expect(d).toMatchObject({ alerta: false, motivo_descarte: 'classe_ignorada', notificar: false });
  });

  it('já alertou (movimento em classes_alerta) → segue alerta sem novo aviso nem clipe', () => {
    expect(decidirReclassificacao('pessoa', true, false, analise)).toEqual({
      alerta: true,
      descartado: false,
      motivo_descarte: null,
      enviar_clipe: false,
      notificar: false,
    });
  });
});

describe('interpretarCaixas', () => {
  it('aceita lista ou texto JSON, ignora itens que não são objeto', () => {
    expect(interpretarCaixas([{ x: 0.1 }, 3, null])).toEqual([{ x: 0.1 }]);
    expect(interpretarCaixas('[{"x":0.2}]')).toEqual([{ x: 0.2 }]);
    expect(interpretarCaixas('{nope')).toBeNull();
    expect(interpretarCaixas({ x: 1 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const camera: any = {
  id: 'c1',
  nome: 'Varanda',
  ip: '10.0.0.2',
  unidade_id: 'u1',
  planta_id: 'p1',
  equipamento_id: 'eq1',
  status: 'online',
  status_em: null,
  publicando: false,
  analise,
};

function eventoBase(extra: Record<string, unknown> = {}): any {
  return {
    id: 'e1',
    camera_id: 'c1',
    unidade_id: 'u1',
    planta_id: 'p1',
    tipo: 'movimento',
    inicio_em: new Date('2026-11-13T22:00:00Z'),
    fim_em: null,
    confianca: null,
    armado: true,
    alerta: false,
    descartado: true,
    motivo_descarte: 'classe_ignorada',
    snapshot_path: 'eventos/e1.jpg',
    clipe_path: null,
    dados: { area_pct: 1.2, caixas: [{ classe: 'movimento' }] },
    ...extra,
  };
}

function montar(opts: { armado?: boolean } = {}) {
  // banco em memória de um evento: updateMany só vence enquanto tipo = movimento
  let linha = eventoBase();
  const prisma: any = {
    cameras_eventos: {
      update: jest.fn().mockImplementation(async ({ data }) => (linha = { ...linha, ...data })),
      updateMany: jest.fn().mockImplementation(async ({ where, data }) => {
        if (where.tipo && linha.tipo !== where.tipo) return { count: 0 };
        linha = { ...linha, ...data };
        return { count: 1 };
      }),
    },
  };
  const storage: any = { caminhoEvento: jest.fn((id: string, ext: string) => `eventos/${id}.${ext}`), salvar: jest.fn() };
  const notificacao: any = { alertar: jest.fn().mockResolvedValue({ chamado_id: null, emails_enviados: 1 }) };
  const auditoria: any = { contextoUnidade: jest.fn().mockResolvedValue({ unidade: { id: 'u1', nome: 'U' }, planta: null }) };
  const config: any = {
    obter: jest.fn().mockResolvedValue({
      armamento_modo: 'manual',
      armado_manual: opts.armado ?? true,
      armado_manual_ate: null,
      abrir_chamado: true,
      notificar_emails: ['a@b.com'],
    }),
  };
  const svc = new CamerasEventosService(prisma, {} as any, storage, notificacao, auditoria, config);
  return { svc, prisma, storage, notificacao, linha: () => linha };
}

describe('CamerasEventosService.reclassificar', () => {
  it('movimento → veiculo: grava classe, caixas e snapshot novo, marca alerta e notifica', async () => {
    const m = montar();
    const caixas = [{ x: 0.1, y: 0.2, w: 0.1, h: 0.1, classe: 'car', confianca: 0.41 }];
    const r = await m.svc.reclassificar(m.linha(), camera, { tipo: 'veiculo', confianca: 0.41, caixas }, JPEG);
    expect(r).toMatchObject({ tipo: 'veiculo', alterado: true, alerta: true, descartado: false, enviar_clipe: true });
    expect(m.linha()).toMatchObject({ tipo: 'veiculo', confianca: 0.41, alerta: true, descartado: false, motivo_descarte: null });
    expect(m.linha().dados).toMatchObject({ area_pct: 1.2, caixas });
    expect(m.storage.salvar).toHaveBeenCalledWith('eventos/e1.jpg', JPEG);
    expect(m.notificacao.alertar).toHaveBeenCalledTimes(1);
    expect(m.notificacao.alertar.mock.calls[0][0]).toMatchObject({
      evento: { id: 'e1', tipo: 'veiculo', confianca: 0.41 },
      camera: { id: 'c1', equipamento_id: 'eq1' },
      config: { abrir_chamado: true, notificar_emails: ['a@b.com'] },
    });
  });

  it('idempotente: segunda chamada não muda nada nem avisa de novo', async () => {
    const m = montar();
    await m.svc.reclassificar(m.linha(), camera, { tipo: 'veiculo', confianca: 0.41 });
    // segunda chamada com a linha ainda velha (corrida) e com a linha nova
    const r1 = await m.svc.reclassificar(eventoBase(), camera, { tipo: 'pessoa', confianca: 0.9 });
    const r2 = await m.svc.reclassificar(m.linha(), camera, { tipo: 'pessoa', confianca: 0.9 });
    expect(r1.alterado).toBe(false);
    expect(r2).toMatchObject({ alterado: false, tipo: 'veiculo' });
    expect(m.linha().tipo).toBe('veiculo');
    expect(m.notificacao.alertar).toHaveBeenCalledTimes(1);
  });

  it('desarmado: sobe a classe mas fica descartado e não avisa', async () => {
    const m = montar({ armado: false });
    const r = await m.svc.reclassificar(m.linha(), camera, { tipo: 'pessoa', confianca: 0.8 });
    expect(r).toMatchObject({ alterado: true, alerta: false, descartado: true, motivo_descarte: 'desarmado' });
    expect(m.notificacao.alertar).not.toHaveBeenCalled();
  });

  it('não mexe em foto nem sem_sinal', async () => {
    const m = montar();
    const r = await m.svc.reclassificar(eventoBase({ tipo: 'foto' }), camera, { tipo: 'pessoa', confianca: 0.9 }, JPEG);
    expect(r.alterado).toBe(false);
    expect(m.prisma.cameras_eventos.updateMany).not.toHaveBeenCalled();
    expect(m.storage.salvar).not.toHaveBeenCalled();
  });

  it('snapshot que não é JPEG → 400', async () => {
    const m = montar();
    await expect(
      m.svc.reclassificar(m.linha(), camera, { tipo: 'pessoa', confianca: 0.9 }, Buffer.from('nao')),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('CamerasEventosService.fim com classe', () => {
  it('campos de topo no fim sobem a classe e avisam uma vez', async () => {
    const m = montar();
    await m.svc.fim(m.linha(), { fim_em: '2026-11-13T22:00:20Z', tipo: 'animal', confianca: 0.5, dados: { duracao_s: 20 } }, camera);
    expect(m.linha()).toMatchObject({ tipo: 'animal', alerta: true });
    expect(m.linha().dados).toMatchObject({ duracao_s: 20 });
    expect(m.notificacao.alertar).toHaveBeenCalledTimes(1);
  });

  it('agente antigo: tipo/confianca dentro de dados também sobem a classe', async () => {
    const m = montar();
    await m.svc.fim(
      m.linha(),
      { fim_em: '2026-11-13T22:00:20Z', dados: { duracao_s: 9, tipo: 'veiculo', confianca: 0.41, caixas: [{ classe: 'car' }] } },
      camera,
    );
    expect(m.linha()).toMatchObject({ tipo: 'veiculo', confianca: 0.41, alerta: true });
    expect(m.linha().dados).toMatchObject({ duracao_s: 9, caixas: [{ classe: 'car' }] });
    expect(m.notificacao.alertar).toHaveBeenCalledTimes(1);
  });

  it('fim com tipo movimento só fecha o evento', async () => {
    const m = montar();
    await m.svc.fim(m.linha(), { fim_em: '2026-11-13T22:00:20Z', dados: { tipo: 'movimento' } }, camera);
    expect(m.linha().tipo).toBe('movimento');
    expect(m.prisma.cameras_eventos.updateMany).not.toHaveBeenCalled();
    expect(m.notificacao.alertar).not.toHaveBeenCalled();
  });
});
