/**
 * Testes do refactor delta-phf — ver docs/tickets/powermeter-delta-phf.md.
 *
 * Foco: validar que CalculoCustosService passa a confiar em phf cumulativo
 * em vez de SUM(consumo_phf <= 5), cobrindo:
 *   1. Periodo sem outliers/gaps → total = phf_final - phf_inicial
 *   2. Outlier no meio (consumo_phf gigante, phf consistente) → ignora outlier
 *   3. Gap de leituras → delta-phf cobre por natureza, sem dupla contagem
 *   4. Reset de medidor (phf cai) → soma por segmento
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '@/core';
import { CalculoCustosService } from './calculo-custos.service';
import { ClassificacaoHorariosService } from './classificacao-horarios.service';
import { ConfiguracaoCustoService } from './configuracao-custo.service';
import {
  DadosUnidade,
  TarifasConcessionaria,
  TipoHorario,
} from '../interfaces/calculo-custos.interface';

function makePrismaMock(rows: Array<{ timestamp_dados: Date; dados: any; potencia_ativa_kw?: number | null }>) {
  return {
    equipamentos_dados: {
      findMany: jest.fn().mockResolvedValue(rows),
    },
  };
}

function leitura(ts: string, phf: number | null, extras: Record<string, unknown> = {}) {
  const dados: Record<string, unknown> = { ...extras };
  if (phf !== null) dados.phf = phf;
  return { timestamp_dados: new Date(ts), dados, potencia_ativa_kw: null };
}

describe('CalculoCustosService — delta-phf', () => {
  let service: CalculoCustosService;
  let prisma: any;

  // ClassificacaoHorariosService eh chamado dentro de agregarEnergiaPorTipo;
  // mockamos pra sempre retornar FORA_PONTA, simplificando asserts (total = soma das partes).
  const classificacao = {
    classificar: jest.fn().mockReturnValue({
      tipo: TipoHorario.FORA_PONTA,
      tarifa_tusd: 0,
      tarifa_te: 0,
      tarifa_total: 0,
      desconto_irrigante: false,
    }),
  };

  beforeEach(async () => {
    prisma = makePrismaMock([]);
    const moduleRef = await Test.createTestingModule({
      providers: [
        CalculoCustosService,
        { provide: PrismaService, useValue: prisma },
        { provide: ClassificacaoHorariosService, useValue: classificacao },
        { provide: ConfiguracaoCustoService, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(CalculoCustosService);
  });

  describe('buscarLeiturasPeriodo', () => {
    it('1. periodo sem outliers/gaps: energia por leitura = phf[i] - phf[i-1]', async () => {
      prisma.equipamentos_dados.findMany.mockResolvedValue([
        leitura('2026-05-01T00:00:00Z', 100),
        leitura('2026-05-01T00:00:30Z', 100.5),
        leitura('2026-05-01T00:01:00Z', 101.2),
        leitura('2026-05-01T00:01:30Z', 102.0),
      ]);

      const leituras = await (service as any).buscarLeiturasPeriodo(
        'eq1',
        new Date('2026-05-01T00:00:00Z'),
        new Date('2026-05-01T01:00:00Z'),
      );

      expect(leituras).toHaveLength(4);
      expect(leituras[0].energia_kwh).toBe(0); // primeira: sem antecessor
      expect(leituras[1].energia_kwh).toBeCloseTo(0.5, 5);
      expect(leituras[2].energia_kwh).toBeCloseTo(0.7, 5);
      expect(leituras[3].energia_kwh).toBeCloseTo(0.8, 5);

      const total = leituras.reduce((s: number, l: any) => s + l.energia_kwh, 0);
      // == phf_final - phf_inicial
      expect(total).toBeCloseTo(102.0 - 100, 5);
    });

    it('2. outlier no meio: consumo_phf gigante eh ignorado, phf manda', async () => {
      prisma.equipamentos_dados.findMany.mockResolvedValue([
        leitura('2026-05-01T00:00:00Z', 165, { consumo_phf: 0.4 }),
        leitura('2026-05-01T00:00:30Z', 165.5, { consumo_phf: 0.5 }),
        // Bug do firmware: consumo_phf gigante, mas phf cresceu so 0.7
        leitura('2026-05-01T00:01:00Z', 166.2, { consumo_phf: 10381.6 }),
        leitura('2026-05-01T00:01:30Z', 167.0, { consumo_phf: 0.8 }),
      ]);

      const leituras = await (service as any).buscarLeiturasPeriodo(
        'eq1',
        new Date('2026-05-01T00:00:00Z'),
        new Date('2026-05-01T01:00:00Z'),
      );

      const total = leituras.reduce((s: number, l: any) => s + l.energia_kwh, 0);
      // Soma e' 167 - 165 = 2.0 kWh — NAO os 10384.8 que consumo_phf somaria.
      expect(total).toBeCloseTo(2.0, 5);
    });

    it('3. gap > 10 min entre leituras: delta cobre, sem dupla contagem', async () => {
      // Cenario: 2 leituras antes do gap, depois 1h sem dados, depois 2 leituras.
      // phf cresce continuamente — total final deve ser phf_final - phf_inicial,
      // independente do tamanho do gap.
      prisma.equipamentos_dados.findMany.mockResolvedValue([
        leitura('2026-05-01T00:00:00Z', 100),
        leitura('2026-05-01T00:00:30Z', 100.5),
        // gap de 1h
        leitura('2026-05-01T01:00:30Z', 105.2),
        leitura('2026-05-01T01:01:00Z', 105.7),
      ]);

      const leituras = await (service as any).buscarLeiturasPeriodo(
        'eq1',
        new Date('2026-05-01T00:00:00Z'),
        new Date('2026-05-01T02:00:00Z'),
      );

      expect(leituras).toHaveLength(4);
      const total = leituras.reduce((s: number, l: any) => s + l.energia_kwh, 0);
      expect(total).toBeCloseTo(105.7 - 100, 5);
      // O delta do gap (4.7 kWh) vai pra leitura DEPOIS do gap (timestamp em 01:00:30),
      // que eh exatamente o comportamento desejado: nao cria leitura virtual nova.
      expect(leituras[2].energia_kwh).toBeCloseTo(4.7, 5);
    });

    it('4. phf cai e nao volta (raro reset real): descarta queda e tudo apos', async () => {
      // Comportamento documentado: phfPrev mantem o ultimo valor saudavel.
      // Se phf cai e fica baixo, todas as leituras subsequentes sao descartadas
      // ate phf voltar >= phfPrev. Reset real de medidor (raro) cai aqui.
      // Trade-off conhecido — ver calculo-custos.service.ts buscarLeiturasPeriodo.
      prisma.equipamentos_dados.findMany.mockResolvedValue([
        leitura('2026-05-01T00:00:00Z', 9998),
        leitura('2026-05-01T00:00:30Z', 9999.5),
        // "Reset" — phf cai e nao volta (cenario raro/improvavel)
        leitura('2026-05-01T00:01:00Z', 0.5),
        leitura('2026-05-01T00:01:30Z', 1.0),
      ]);

      const leituras = await (service as any).buscarLeiturasPeriodo(
        'eq1',
        new Date('2026-05-01T00:00:00Z'),
        new Date('2026-05-01T01:00:00Z'),
      );

      const total = leituras.reduce((s: number, l: any) => s + l.energia_kwh, 0);
      // Segmento normal: 9998 -> 9999.5 = 1.5
      // 0.5 cai abaixo de 9999.5 → glitch descartado, phfPrev mantem 9999.5
      // 1.0 cai abaixo de 9999.5 → glitch descartado
      // Total = 1.5 (descarta o reset real porque eh indistinguivel de glitch
      // sem heuristica adicional — TODO no codigo).
      expect(total).toBeCloseTo(1.5, 5);
    });

    it('4b. PADRAO REAL CHINT: glitch isolado de phf entre leituras normais', async () => {
      // Cenario observado em prod (05/05/2026 ~23:54-23:59):
      //   23:54  phf=10557.6  (normal)
      //   23:55  phf=10557.6  (normal)
      //   23:56  phf=  175.96 (glitch — firmware snapshot velho)
      //   23:57  phf=10557.6  (voltou ao normal)
      //   23:58  phf=10557.6  (normal)
      // Energia real consumida nesse intervalo: ZERO (phf estavel).
      // Bug do algoritmo anterior: 23:56 (delta -10381) virava phfPrev=175,
      // e 23:57 (delta +10381) era contado como consumo, somando +10381 falsos.
      prisma.equipamentos_dados.findMany.mockResolvedValue([
        leitura('2026-05-05T23:54:00Z', 10557.6),
        leitura('2026-05-05T23:55:00Z', 10557.6),
        leitura('2026-05-05T23:56:00Z', 175.96), // glitch isolado
        leitura('2026-05-05T23:57:00Z', 10557.6), // volta ao normal
        leitura('2026-05-05T23:58:00Z', 10557.6),
      ]);

      const leituras = await (service as any).buscarLeiturasPeriodo(
        'eq1',
        new Date('2026-05-05T23:00:00Z'),
        new Date('2026-05-06T00:00:00Z'),
      );

      const total = leituras.reduce((s: number, l: any) => s + l.energia_kwh, 0);
      // Total deve ser 0 — phf esta estavel exceto pelo glitch que eh descartado.
      // Se voltar a falhar com >10000, algoritmo regrediu pro bug original.
      expect(total).toBeCloseTo(0, 5);
    });

    it('4c. PADRAO REAL CHINT estendido: 2 glitches isolados em sequencia', async () => {
      // Cobertura defensiva: 2 glitches em janela curta nao devem somar nada.
      prisma.equipamentos_dados.findMany.mockResolvedValue([
        leitura('2026-05-05T00:00:00Z', 10000),
        leitura('2026-05-05T00:00:30Z', 100), // glitch 1
        leitura('2026-05-05T00:01:00Z', 10001), // volta
        leitura('2026-05-05T00:01:30Z', 50), // glitch 2
        leitura('2026-05-05T00:02:00Z', 10002), // volta + consumo real 1 kWh
      ]);

      const leituras = await (service as any).buscarLeiturasPeriodo(
        'eq1',
        new Date('2026-05-05T00:00:00Z'),
        new Date('2026-05-05T01:00:00Z'),
      );

      const total = leituras.reduce((s: number, l: any) => s + l.energia_kwh, 0);
      // 10000 -> 100 (glitch, descarta) phfPrev=10000
      // 10000 -> 10001 (+1) phfPrev=10001
      // 10001 -> 50 (glitch, descarta) phfPrev=10001
      // 10001 -> 10002 (+1) phfPrev=10002
      // Total = 2 kWh (consumo real entre os patamares de glitches)
      expect(total).toBeCloseTo(2, 5);
    });

    it('5. phf=null em alguma leitura: pula sem quebrar', async () => {
      prisma.equipamentos_dados.findMany.mockResolvedValue([
        leitura('2026-05-01T00:00:00Z', 100),
        leitura('2026-05-01T00:00:30Z', null, { Pt: 50 }), // sem phf
        leitura('2026-05-01T00:01:00Z', 101.5),
      ]);

      const leituras = await (service as any).buscarLeiturasPeriodo(
        'eq1',
        new Date('2026-05-01T00:00:00Z'),
        new Date('2026-05-01T01:00:00Z'),
      );

      // Total = (100 → 101.5) = 1.5, mesmo com leitura sem phf no meio
      const total = leituras.reduce((s: number, l: any) => s + l.energia_kwh, 0);
      expect(total).toBeCloseTo(1.5, 5);
    });
  });

  describe('validacoes de entrada em calcularCustos', () => {
    it('7. rejeita BadRequestException quando dataInicio >= dataFim', async () => {
      await expect(
        service.calcularCustos(
          'eq1',
          new Date('2026-05-22T00:00:00Z'),
          new Date('2026-05-21T00:00:00Z'),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.calcularCustos(
          'eq1',
          new Date('2026-05-22T00:00:00Z'),
          new Date('2026-05-21T00:00:00Z'),
        ),
      ).rejects.toThrow(/anterior à data final/);
    });

    it('8. rejeita BadRequestException quando periodo > 2 anos', async () => {
      await expect(
        service.calcularCustos(
          'eq1',
          new Date('2020-01-01T00:00:00Z'),
          new Date('2026-05-22T00:00:00Z'),
        ),
      ).rejects.toThrow(/Período máximo permitido: 2 anos/);
    });

    it('9. rejeita BadRequestException quando data eh invalida', async () => {
      await expect(
        service.calcularCustos(
          'eq1',
          new Date('invalida'),
          new Date('2026-05-22T00:00:00Z'),
        ),
      ).rejects.toThrow(/Data inicial inválida/);
    });
  });

  describe('agregarEnergiaPorTipo', () => {
    const unidade: DadosUnidade = {
      id: 'u1',
      nome: 'Teste',
      grupo: 'A',
      subgrupo: 'A4',
      irrigante: false,
      concessionaria_id: 'c1',
    };
    const tarifas: TarifasConcessionaria = { tusd_p: 0, te_p: 0, tusd_fp: 0, te_fp: 0 };

    it('6. ignora leituras com energia_kwh=0 (primeira leitura, reset)', () => {
      const leituras = [
        { timestamp: new Date('2026-05-01T00:00:00Z'), energia_kwh: 0, potencia_kw: 0 },
        { timestamp: new Date('2026-05-01T00:00:30Z'), energia_kwh: 0.5, potencia_kw: 60 },
        { timestamp: new Date('2026-05-01T00:01:00Z'), energia_kwh: 0.7, potencia_kw: 84 },
      ];

      const agregacao = (service as any).agregarEnergiaPorTipo(
        leituras,
        unidade,
        tarifas,
        {},
      );

      // Energia total = 0 + 0.5 + 0.7 = 1.2 (classificacao mockada como FORA_PONTA)
      expect(agregacao.energia_total_kwh).toBeCloseTo(1.2, 5);
      expect(agregacao.energia_fora_ponta_kwh).toBeCloseTo(1.2, 5);
      // demanda_maxima considera todas as leituras (incluindo as com energia=0)
      expect(agregacao.demanda_maxima_kw).toBe(84);
    });
  });
});
