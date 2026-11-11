import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PivoCalibracaoService } from './pivo-calibracao.service';

/**
 * NEXON-103 — calibração do ângulo: pré-condições (seção 3.2), confirmação da TON antes de
 * gravar (seção 5), restaurar a anterior e permissão (seção 3.4). Números da seção 6.
 */

const ADMIN = { id: 'u-admin', role: 'admin' };
const PROPRIETARIO = { id: 'u-dono', role: 'proprietario' };
const DTO = { bruto_cal: 147, sentido: 1, centro_lat: -16, centro_lon: -48, ponta_lat: -15.997, ponta_lon: -47.997 };

interface Cenario {
  status?: { direita: 0 | 1 | null; esquerda: 0 | 1 | null };
  temModoTon?: boolean;
  modoTon?: 0 | 1 | null;
  tonE?: number;
  encoder?: { equipamento_id: string; resolucao: number | null; invertido: boolean; zero: number } | null;
  vigente?: any;
  anterior?: any;
  ack?: (cmd: string) => string | Error;
  alvo?: { tonId: string } | null;
  encoderNaTon?: boolean;
}

function linhaCal(over: Record<string, unknown> = {}) {
  return {
    id: 'cal-antiga', equipamento_id: 'pivo-11', bruto_cal: 100, sentido: 1, centro_lat: -16, centro_lon: -48,
    ponta_lat: -15.99, ponta_lon: -48, az_cal: 0, resolucao: 360, zero: -100, encoder_equipamento_id: 'enc-1',
    leituras: [100, 100, 100, 100, 100], origem: 'calibracao', usuario_id: 'u-admin', usuario_nome: 'Admin',
    criado_em: new Date('2026-11-10T12:00:00Z'), ativa: true, desativada_em: null, motivo_desativacao: null, ...over,
  };
}

function montar(c: Cenario = {}) {
  const cmds: string[] = [];
  const sql: string[] = [];
  const valores: any[][] = [];
  const exec = jest.fn(async (s: TemplateStringsArray, ...v: any[]) => { sql.push(s.join('?')); valores.push(v); return 1; });
  const prisma: any = {
    $queryRaw: jest.fn(async (s: TemplateStringsArray) => {
      const q = s.join('?');
      if (q.includes('FROM calibracao_angulo') && q.includes('NOT c.ativa')) return c.anterior ? [c.anterior] : [];
      if (q.includes('FROM calibracao_angulo')) return c.vigente ? [c.vigente] : [];
      if (q.includes('FROM equipamentos e')) return [{ nome: 'Pivo 11', unidade_id: 'un-1', unidade_nome: 'Pivos 1,2,3,11', planta_id: 'pl-1', planta_nome: 'Chimarrão' }];
      return [];
    }),
    $executeRaw: exec,
    $transaction: jest.fn(async (fn: (tx: any) => Promise<void>) => fn({ $executeRaw: exec })),
    equipamentos: { findFirst: jest.fn(async () => ({ nome: 'Encoder_1' })) },
    usuarios: { findFirst: jest.fn(async () => ({ nome: 'Fulano' })) },
    logs_mqtt: { create: jest.fn(async () => ({ id: 'log-1' })) },
  };
  const encoder = c.encoder === undefined ? { equipamento_id: 'enc-1', resolucao: 360, invertido: false, zero: 0 } : c.encoder;
  const seq: any = {
    estado: jest.fn(async () => ({
      pivo: {
        status: { direita: 0, esquerda: 0, desligado: null, erro: null, ...(c.status ?? {}) },
        tem_modo_ton: c.temModoTon ?? true,
        modo_ton: c.modoTon === undefined ? 1 : c.modoTon,
        ton_local: { e: c.tonE ?? 0 },
      },
      posicao: { fonte: 'encoder', angulo: null, bruto: 147, lido_em: new Date(), motivo: null, encoder, sem_calibracao: !c.vigente, calibracao: null },
      sequencia: null,
    })),
  };
  const ton: any = {
    alvo: jest.fn(async () => (c.alvo === undefined ? { tonId: 'ton-1' } : c.alvo)),
    encoderNaTon: jest.fn(async () => (c.encoderNaTon === false ? null : encoder)),
    esquecerConfig: jest.fn(),
  };
  const cmd: any = {
    comandoTon: jest.fn(async (p: { cmd: string; ackOk?: RegExp }) => {
      cmds.push(p.cmd);
      const r = c.ack ? c.ack(p.cmd) : p.cmd === 'pivo encler' ? 'pivo_el 147 147 147 147 147' : 'pivo_enc_ok';
      if (r instanceof Error) throw r;
      if (p.ackOk && !p.ackOk.test(r)) throw new BadGatewayException({ message: `TON não aplicou "${p.cmd}": ${r} (firmware sem suporte? regrave a TON)` });
      return { status: 'ok', msg: r, latency_ms: 5 };
    }),
  };
  const auditoria: any = { registrar: jest.fn(async () => undefined) };
  const svc = new PivoCalibracaoService(prisma, seq, ton, cmd, auditoria);
  return { svc, cmds, sql, valores, prisma, auditoria, ton };
}

describe('calibração do ângulo do pivô (serviço)', () => {
  describe('Ler encoder', () => {
    it('5 leituras iguais: válida', async () => {
      const { svc, cmds } = montar();
      const r = await svc.lerEncoder('pivo-11', ADMIN);
      expect(cmds).toEqual(['pivo encler']);
      expect(r).toMatchObject({ valida: true, valor: 147, leituras: [147, 147, 147, 147, 147], motivo: null });
    });

    it('leituras variando mais que ±1: recusada, com o motivo', async () => {
      const { svc } = montar({ ack: () => 'pivo_el 147 150 147 147 147' });
      const r = await svc.lerEncoder('pivo-11', ADMIN);
      expect(r.valida).toBe(false);
      expect(r.motivo).toMatch(/instável/);
    });

    it('erro de comunicação no meio das leituras: recusada', async () => {
      const { svc } = montar({ ack: () => 'pivo_el_erro 2' });
      const r = await svc.lerEncoder('pivo-11', ADMIN);
      expect(r).toMatchObject({ valida: false, valor: null });
    });

    it('firmware sem o comando: pede para regravar a placa', async () => {
      const { svc } = montar({ ack: () => 'pivo_cmd_desconhecido' });
      await expect(svc.lerEncoder('pivo-11', ADMIN)).rejects.toThrow(/regrave o firmware/);
    });

    it('pivô sem encoder na Configuração', async () => {
      const { svc } = montar({ encoder: null });
      await expect(svc.lerEncoder('pivo-11', ADMIN)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('encoder fora do RS485 da TON do pivô', async () => {
      const { svc } = montar({ encoderNaTon: false });
      await expect(svc.lerEncoder('pivo-11', ADMIN)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('Salvar calibração', () => {
    it('exemplo da spec: manda para a TON, espera a confirmação e grava', async () => {
      const { svc, cmds, sql, valores, auditoria, ton, prisma } = montar({ vigente: linhaCal() });
      await svc.lerEncoder('pivo-11', ADMIN);
      await svc.salvar('pivo-11', DTO, ADMIN);
      // azimute 43,87° − 147 = zero −103,13° (a tela mostra 43,9° e 96,9° com bruto 200)
      expect(cmds).toEqual(['pivo encler', 'pivo enc 360 0 -103.13']);
      const escritas = sql.filter((q) => /UPDATE calibracao_angulo|INSERT INTO calibracao_angulo|UPDATE pivo_config/.test(q));
      expect(escritas[0]).toMatch(/UPDATE calibracao_angulo SET ativa = false/);   // desativa a anterior, não apaga
      expect(escritas[1]).toMatch(/INSERT INTO calibracao_angulo/);
      expect(escritas[2]).toMatch(/UPDATE pivo_config/);
      expect(sql.some((q) => /DELETE/i.test(q))).toBe(false);
      const insert = valores[sql.findIndex((q) => q.includes('INSERT INTO calibracao_angulo'))];
      expect(insert).toEqual(expect.arrayContaining(['pivo-11', 147, 1, -16, -48, -15.997, -47.997, 43.87, 360, -103.13]));
      expect(ton.esquecerConfig).toHaveBeenCalledWith('ton-1');
      expect(auditoria.registrar).toHaveBeenCalledWith(expect.objectContaining({
        acao: 'pivo_calibracao', objetoTipo: 'equipamento', objetoId: 'pivo-11', autorId: 'u-admin',
        plantaIds: ['pl-1'], unidadeIds: ['un-1'],
      }));
      expect(prisma.logs_mqtt.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ comando_semantico: 'pivo.calibracao', usuario_id: 'u-admin' }),
      }));
    });

    it('sentido anti-horário vai como encoder invertido', async () => {
      const { svc, cmds } = montar();
      await svc.lerEncoder('pivo-11', ADMIN);
      await svc.salvar('pivo-11', { ...DTO, sentido: -1 }, ADMIN);
      expect(cmds[1]).toBe('pivo enc 360 1 -169.13');
    });

    it('a TON não confirma: erro e NADA gravado', async () => {
      const { svc, sql, auditoria } = montar({ ack: (c) => (c === 'pivo encler' ? 'pivo_el 147 147 147 147 147' : new Error('TON "T" nao respondeu ao comando dentro do timeout.')) });
      await svc.lerEncoder('pivo-11', ADMIN);
      await expect(svc.salvar('pivo-11', DTO, ADMIN)).rejects.toThrow(/não confirmou a gravação/);
      expect(sql.some((q) => q.includes('calibracao_angulo') && /INSERT|UPDATE/.test(q))).toBe(false);
      expect(auditoria.registrar).not.toHaveBeenCalled();
    });

    it('sem ter lido o encoder: não salva', async () => {
      const { svc, cmds } = montar();
      await expect(svc.salvar('pivo-11', DTO, ADMIN)).rejects.toThrow(/Leia o encoder/);
      expect(cmds).toEqual([]);
    });

    it('valor diferente do que a TON leu: não salva', async () => {
      const { svc } = montar();
      await svc.lerEncoder('pivo-11', ADMIN);
      await expect(svc.salvar('pivo-11', { ...DTO, bruto_cal: 150 }, ADMIN)).rejects.toBeInstanceOf(ConflictException);
    });

    it('centro e ponta a menos de 50 m: "pontos muito próximos"', async () => {
      const { svc, cmds } = montar();
      await svc.lerEncoder('pivo-11', ADMIN);
      await expect(svc.salvar('pivo-11', { ...DTO, ponta_lat: -16.0003, ponta_lon: -48 }, ADMIN)).rejects.toThrow(/Pontos muito próximos/);
      expect(cmds).toEqual(['pivo encler']);
    });

    it('pivô em movimento: não salva', async () => {
      const { svc } = montar({ status: { direita: 1, esquerda: 0 } });
      await svc.lerEncoder('pivo-11', ADMIN);
      await expect(svc.salvar('pivo-11', DTO, ADMIN)).rejects.toThrow(/pivô parado/);
    });

    it('chave seletora em modo CLP: não salva', async () => {
      const { svc } = montar({ modoTon: 0 });
      await svc.lerEncoder('pivo-11', ADMIN);
      await expect(svc.salvar('pivo-11', DTO, ADMIN)).rejects.toThrow(/modo CLP/);
    });

    it('pivô sem a chave seletora não exige o modo TON', async () => {
      const { svc, cmds } = montar({ temModoTon: false, modoTon: null });
      await svc.lerEncoder('pivo-11', ADMIN);
      await svc.salvar('pivo-11', DTO, ADMIN);
      expect(cmds).toHaveLength(2);
    });
  });

  describe('Restaurar calibração anterior', () => {
    it('reativa a última inativa na TON e no banco', async () => {
      const anterior = linhaCal({ id: 'cal-antiga', ativa: false, az_cal: 43.9, bruto_cal: 147, zero: -103.1, desativada_em: new Date() });
      const { svc, cmds, sql, auditoria } = montar({ vigente: linhaCal({ id: 'cal-nova' }), anterior });
      await svc.restaurar('pivo-11', ADMIN);
      expect(cmds).toEqual(['pivo enc 360 0 -103.1']);
      expect(sql.some((q) => /UPDATE calibracao_angulo SET ativa = false/.test(q))).toBe(true);
      expect(sql.some((q) => /UPDATE calibracao_angulo SET ativa = true/.test(q))).toBe(true);
      expect(auditoria.registrar).toHaveBeenCalledWith(expect.objectContaining({ acao: 'pivo_calibracao_restaurada' }));
    });

    it('sem calibração anterior', async () => {
      const { svc } = montar();
      await expect(svc.restaurar('pivo-11', ADMIN)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('anterior de outra resolução: pede calibração nova', async () => {
      const { svc, cmds } = montar({ anterior: linhaCal({ ativa: false, resolucao: 4096 }) });
      await expect(svc.restaurar('pivo-11', ADMIN)).rejects.toBeInstanceOf(ConflictException);
      expect(cmds).toEqual([]);
    });

    it('a TON não confirma: nada muda no banco', async () => {
      const { svc, sql } = montar({ anterior: linhaCal({ ativa: false }), ack: () => new Error('timeout') });
      await expect(svc.restaurar('pivo-11', ADMIN)).rejects.toBeInstanceOf(BadGatewayException);
      expect(sql.some((q) => /UPDATE calibracao_angulo/.test(q))).toBe(false);
    });
  });

  describe('permissão', () => {
    it('proprietário só visualiza', async () => {
      const { svc, cmds } = montar();
      await expect(svc.lerEncoder('pivo-11', PROPRIETARIO)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(svc.salvar('pivo-11', DTO, PROPRIETARIO)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(svc.restaurar('pivo-11', PROPRIETARIO)).rejects.toBeInstanceOf(ForbiddenException);
      expect(cmds).toEqual([]);
      const ver = await svc.ver('pivo-11', PROPRIETARIO);
      expect(ver.pode_editar).toBe(false);
    });

    it('admin e analista editam', async () => {
      const { svc } = montar();
      expect((await svc.ver('pivo-11', ADMIN)).pode_editar).toBe(true);
      expect((await svc.ver('pivo-11', { id: 'a', role: 'analista' })).pode_editar).toBe(true);
      expect((await svc.ver('pivo-11', { id: 'o', role: 'operador' })).pode_editar).toBe(false);
    });
  });

  it('ver: pré-condições com o motivo visível', async () => {
    const { svc } = montar({ status: { direita: 1, esquerda: 0 }, modoTon: 0 });
    const v = await svc.ver('pivo-11', ADMIN);
    expect(v.precondicoes).toMatchObject({ parado: false, modo_ton: false });
    expect(v.precondicoes.pendencias).toHaveLength(2);
    expect(v.encoder).toMatchObject({ equipamento_id: 'enc-1', resolucao: 360, nome: 'Encoder_1' });
  });
});
