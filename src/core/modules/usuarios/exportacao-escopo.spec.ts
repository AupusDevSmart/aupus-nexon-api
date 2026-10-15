import { ForbiddenException } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PermissionScopeService } from '../auth/permission-scope.service';
import { prismaEscopoFake } from '../auth/testing/prisma-escopo.fake';
import { AuditoriaAcessosService } from './auditoria-acessos.service';
import { ExportacaoAuditoriaService } from './exportacao-auditoria.service';
import { EquipamentosController } from '../equipamentos/equipamentos.controller';
import { UnidadesController } from '../unidades/unidades.controller';
import { CarregadorEletricoService } from '../../../modules/carregador-eletrico/carregador-eletrico.service';

const ADMIN = { id: 'adm', nome: 'Admin', role: 'super_admin' };
const DONO1 = { id: 'dono1', nome: 'Dono Um', role: 'proprietario' };
const OP1 = { id: 'op1', nome: 'Operador Um', role: 'operador' };
const CATIVO = { id: 'ninguem', nome: 'Sem Vínculo', role: 'cativo' };
const ARQUIVO = path.join(os.tmpdir(), `nexon-anexo-teste-${process.pid}.pdf`);
const CLIENTE = { plataforma: 'Web', aparelho: null, dispositivo: 'Chrome no macOS', ip: '10.0.0.9', userAgent: 'Mozilla/5.0' };

describe('Exportações: escopo por planta + trilha', () => {
  beforeAll(() => fs.writeFileSync(ARQUIVO, 'pdf'));
  afterAll(() => fs.rmSync(ARQUIVO, { force: true }));

  let prisma: ReturnType<typeof prismaEscopoFake>;
  let scope: PermissionScopeService;
  let auditoria: AuditoriaAcessosService;
  let registrar: jest.SpyInstance;
  let exportacoes: ExportacaoAuditoriaService;

  const dataService = {
    obterHistorico: jest.fn(async () => ({ data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] })),
    obterDadoAtual: jest.fn(async () => ({ ok: true })),
  };
  const anexosEquip = {
    buscarAnexo: jest.fn(async (id: string) => ({
      id,
      equipamento_id: id === 'AX2' ? 'E2' : 'E1',
      mime_type: 'application/pdf',
      nome_original: 'manual.pdf',
      tamanho: BigInt(10),
    })),
    obterCaminhoArquivo: jest.fn(async () => ARQUIVO),
    listarAnexos: jest.fn(async () => []),
  };
  const anexosUnid = {
    buscarAnexo: jest.fn(async (id: string) => ({
      id,
      unidade_id: id === 'AU2' ? 'U2' : 'U1',
      mime_type: 'application/pdf',
      nome_original: 'laudo.pdf',
      tamanho: 10,
    })),
    obterCaminhoArquivo: jest.fn(async () => ARQUIVO),
    listarAnexos: jest.fn(async () => []),
  };
  const res = { set: jest.fn(), setHeader: jest.fn(), sendFile: jest.fn() } as any;

  let equip: EquipamentosController;
  let unid: UnidadesController;

  const ultimaTrilha = () => registrar.mock.calls[registrar.mock.calls.length - 1][0];

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = prismaEscopoFake();
    scope = new PermissionScopeService(prisma as any);
    auditoria = new AuditoriaAcessosService(prisma as any);
    registrar = jest.spyOn(auditoria, 'registrar');
    exportacoes = new ExportacaoAuditoriaService(prisma as any, auditoria);
    equip = new EquipamentosController({} as any, dataService as any, anexosEquip as any, scope, exportacoes);
    unid = new UnidadesController({} as any, {} as any, anexosUnid as any, scope, exportacoes);
  });

  describe('GET /equipamentos/:id/dados/historico', () => {
    it('admin exporta de qualquer planta e grava exportacao com linhas, nomes, IP e UA', async () => {
      const r = await equip.obterHistorico('E2', '2026-10-01', '2026-10-07', '500', undefined, ADMIN, CLIENTE);
      expect(r.data).toHaveLength(3);
      expect(registrar).toHaveBeenCalledTimes(1);
      const t = ultimaTrilha();
      expect(t.acao).toBe('exportacao');
      expect(t.autorId).toBe('adm');
      expect(t.plantaIds).toEqual(['P2']);
      expect(t.unidadeIds).toEqual(['U2']);
      expect(t.mensagem).toContain('Medidor Dois');
      expect(t.detalhes).toMatchObject({
        tipo: 'leituras',
        usuario: { id: 'adm', nome: 'Admin', papel: 'super_admin' },
        equipamentos: [{ id: 'E2', nome: 'Medidor Dois' }],
        plantas: [{ id: 'P2', nome: 'Usina Dois' }],
        periodo: { inicio: '2026-10-01', fim: '2026-10-07' },
        formato: 'json',
        linhas: 3,
        ip: '10.0.0.9',
        user_agent: 'Mozilla/5.0',
      });
    });

    it('proprietário exporta o seu equipamento', async () => {
      await expect(equip.obterHistorico('E1', undefined, undefined, undefined, undefined, DONO1, CLIENTE)).resolves.toBeDefined();
      expect(ultimaTrilha().acao).toBe('exportacao');
    });

    it('proprietário recebe 403 no de outra planta e a negativa vai para a trilha', async () => {
      await expect(
        equip.obterHistorico('E2', undefined, undefined, undefined, undefined, DONO1, CLIENTE),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(dataService.obterHistorico).not.toHaveBeenCalled();
      const t = ultimaTrilha();
      expect(t.acao).toBe('exportacao_negada');
      expect(t.autorId).toBe('dono1');
      expect(t.detalhes).toMatchObject({ tipo: 'leituras', usuario: { papel: 'proprietario' }, plantas: [{ id: 'P2' }] });
      expect(t.detalhes.motivo).toBeTruthy();
    });

    it('papel desconhecido sem vínculo não vê nada', async () => {
      await expect(
        equip.obterHistorico('E1', undefined, undefined, undefined, undefined, CATIVO, CLIENTE),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(ultimaTrilha().acao).toBe('exportacao_negada');
    });
  });

  describe('GET /equipamentos/:id/dados/atual', () => {
    it('operador lê o da planta dele sem gravar trilha, e 403 (com trilha) fora dela', async () => {
      await expect(equip.obterDadoAtual('E1', OP1, CLIENTE)).resolves.toEqual({ ok: true });
      expect(registrar).not.toHaveBeenCalled();
      await expect(equip.obterDadoAtual('E2', OP1, CLIENTE)).rejects.toBeInstanceOf(ForbiddenException);
      expect(ultimaTrilha().acao).toBe('exportacao_negada');
    });
  });

  describe('anexos do equipamento', () => {
    it('admin baixa anexo de qualquer planta (trilha com arquivo)', async () => {
      const arquivo = await equip.downloadAnexo('AX2', res, ADMIN, CLIENTE);
      await new Promise((ok) => {
        const st = arquivo.getStream();
        st.on('close', ok).on('error', ok).resume();
      });
      expect(anexosEquip.obterCaminhoArquivo).toHaveBeenCalled();
      const t = ultimaTrilha();
      expect(t.acao).toBe('exportacao');
      expect(t.detalhes).toMatchObject({ tipo: 'anexo_equipamento', arquivo: 'manual.pdf', anexo_id: 'AX2' });
    });

    it('operador recebe 403 no anexo de outra planta', async () => {
      await expect(equip.downloadAnexo('AX2', res, OP1, CLIENTE)).rejects.toBeInstanceOf(ForbiddenException);
      expect(anexosEquip.obterCaminhoArquivo).not.toHaveBeenCalled();
      expect(ultimaTrilha().acao).toBe('exportacao_negada');
    });

    it('listar, enviar e remover anexo de outra planta dão 403', async () => {
      await expect(equip.listarAnexos('E2', DONO1, CLIENTE)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(equip.uploadAnexo('E2', {}, undefined, DONO1)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(equip.removerAnexo('AX2', DONO1)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        equip.replicarAnexos({ origem_equipamento_id: 'E1', destino_equipamento_ids: ['E2'] } as any, DONO1),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('anexos da unidade', () => {
    it('proprietário baixa o da unidade dele e recebe 403 na de outra planta', async () => {
      await unid.baixarAnexo('AU1', res, DONO1, CLIENTE);
      expect(res.sendFile).toHaveBeenCalled();
      expect(ultimaTrilha()).toMatchObject({ acao: 'exportacao', unidadeIds: ['U1'], plantaIds: ['P1'] });

      await expect(unid.baixarAnexo('AU2', res, DONO1, CLIENTE)).rejects.toBeInstanceOf(ForbiddenException);
      expect(ultimaTrilha()).toMatchObject({ acao: 'exportacao_negada', unidadeIds: ['U2'] });
    });

    it('admin baixa anexo de qualquer unidade', async () => {
      await unid.baixarAnexo('AU2', res, ADMIN, CLIENTE);
      expect(ultimaTrilha().acao).toBe('exportacao');
    });

    it('papel desconhecido sem vínculo não lista anexos', async () => {
      await expect(unid.listarAnexos('U1', CATIVO, CLIENTE)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('GET /carregador-eletrico/export', () => {
    const linhas = [
      { morador: 'Ana', kwh: 10, ocioso_min: 0, valor_reais: 5, planta_id: 'P1' },
      { morador: 'Bia', kwh: 7, ocioso_min: 3, valor_reais: 4, planta_id: 'P2' },
      { morador: 'Sem planta', kwh: 9, ocioso_min: 0, valor_reais: 2, planta_id: null },
    ];
    const svc = () => {
      prisma.$queryRaw.mockResolvedValue(linhas as any);
      return new CarregadorEletricoService(prisma as any, scope, {} as any);
    };

    it('usuário com escopo não recebe sessões sem planta nem de outra planta', async () => {
      const r = await svc().exportarMensal('2026-09', DONO1);
      expect(r.linhas.map((l: any) => l.morador)).toEqual(['Ana']);
      expect(r.csv).not.toContain('Sem planta');
    });

    it('admin recebe tudo', async () => {
      const r = await svc().exportarMensal('2026-09', ADMIN);
      expect(r.linhas).toHaveLength(3);
    });

    it('trilha do export com linhas e plantas', async () => {
      const s = svc();
      const r = await exportacoes.executar(
        { user: DONO1, cliente: CLIENTE, tipo: 'carregador', periodo: { mes: '2026-09' }, formato: 'csv' },
        () => s.exportarMensal('2026-09', DONO1),
        { resumo: (x) => ({ linhas: x.linhas.length, plantaIds: x.linhas.map((l: any) => l.planta_id) }) },
      );
      expect(r.linhas).toHaveLength(1);
      expect(ultimaTrilha()).toMatchObject({ acao: 'exportacao', plantaIds: ['P1'] });
      expect(ultimaTrilha().detalhes).toMatchObject({ tipo: 'carregador', linhas: 1, periodo: { mes: '2026-09' } });
    });

    it('pedir planta de fora do escopo nega e grava a negativa', async () => {
      const s = svc();
      await expect(
        exportacoes.executar(
          { user: DONO1, cliente: CLIENTE, tipo: 'carregador', plantaIds: ['P2'], periodo: { mes: '2026-09' } },
          () => s.exportarMensal('2026-09', DONO1, 'P2'),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(ultimaTrilha()).toMatchObject({ acao: 'exportacao_negada', plantaIds: ['P2'] });
    });
  });

  it('falha ao gravar a trilha não derruba o export', async () => {
    prisma.$executeRaw.mockRejectedValueOnce(new Error('db fora'));
    registrar.mockRestore();
    await expect(equip.obterHistorico('E1', undefined, undefined, undefined, undefined, ADMIN, CLIENTE)).resolves.toBeDefined();
  });
});
