import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { SincronizacaoService } from './sincronizacao.service';
import { OutboxService } from './outbox.service';
import { compartilhadosNaCascata, descendentes } from './arvore';
import { montarPayload } from './recursos';
import { PlantasService } from '../plantas/plantas.service';
import { UnidadesService } from '../unidades/unidades.service';

/** Quem é este nó, e quem é o outro (no Service, o mesmo spec com os dois trocados) */
const ESTE = 'nexon';
const OUTRO = 'service';

/**
 * O incidente de 26/10 a 07/11/2026, fechado (10/11/2026): a exclusão de um
 * lado chegava ao outro como exclusão, 12 dias depois, sem ninguém decidir; e o
 * desvincular só valia do lado que clicou. Agora a exclusão chega como aviso, o
 * desvínculo vale dos dois lados e desce a hierarquia, compartilhar de novo
 * religa o outro lado, restaurar fecha o aviso de lá, e excluir o que é
 * compartilhado pede confirmação. Precisa do SQL 2026-11-10 no banco.
 */
describe('exclusao vira aviso e desvinculo vale dos dois lados (banco real)', () => {
  const prisma = new PrismaClient();
  const db = prisma as unknown as PrismaService;
  const service = new SincronizacaoService(db);
  const outbox = new OutboxService(db);

  const ID_PROP = 'TESTEAVISOPROPRIETARIO001';
  const ID_PLANTA = 'TESTEAVISOPLANTA000000001';
  const ID_UNIDADE = 'TESTEAVISOUNIDADE00000001';
  const ID_UNIDADE_2 = 'TESTEAVISOUNIDADE00000002';
  const ID_EQUIP = 'TESTEAVISOEQUIPAMENTO0001';
  // 25 caracteres, o id do cuid antigo (o Char(26) guarda com um espaço no fim)
  const ID_SUB = 'TESTEAVISOSUBEQUIP0000001';
  const ID_USUARIO = 'TESTEAVISOUSUARIO00000001';
  const DA_SINCRONIZACAO = [ID_PROP, ID_PLANTA, ID_UNIDADE, ID_UNIDADE_2, ID_EQUIP, ID_SUB, ID_USUARIO];

  const limpar = async () => {
    const where = { registro_id: { in: DA_SINCRONIZACAO } };
    await prisma.sincronizacao_outbox.deleteMany({ where });
    await prisma.sincronizacao_auditoria.deleteMany({ where });
    await prisma.sincronizacao_vinculos.deleteMany({ where });
    await prisma.sincronizacao_exclusoes_pendentes.deleteMany({ where });
    await prisma.equipamentos.deleteMany({ where: { id: { in: [ID_SUB, ID_EQUIP] } } });
    await prisma.unidades.deleteMany({ where: { id: { in: [ID_UNIDADE, ID_UNIDADE_2] } } });
    await prisma.plantas.deleteMany({ where: { id: ID_PLANTA } });
    await prisma.usuarios.deleteMany({ where: { id: ID_USUARIO } });
  };

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO sincronizacao_no (travar, origem) VALUES (TRUE, '${ESTE}')
       ON CONFLICT (travar) DO UPDATE SET origem = '${ESTE}'`,
    );
    await prisma.usuarios.upsert({
      where: { id: ID_PROP },
      update: {},
      create: { id: ID_PROP, nome: 'Prop aviso', email: 'aviso.sync@exemplo.local' },
    });
  });

  beforeEach(async () => {
    await limpar();
    await prisma.plantas.create({ data: { id: ID_PLANTA, nome: 'Planta aviso', proprietario_id: ID_PROP } });
    await prisma.unidades.create({ data: { id: ID_UNIDADE, nome: 'Instalação aviso', planta_id: ID_PLANTA } });
    // Criadas antes de qualquer vínculo: nenhum evento, mas por garantia
    await prisma.sincronizacao_outbox.deleteMany({ where: { registro_id: { in: DA_SINCRONIZACAO } } });
  });

  afterAll(async () => {
    await limpar();
    await prisma.$disconnect();
  });

  const vinculoAtivo = async (recurso: string, id: string) =>
    (await prisma.sincronizacao_vinculos.findUnique({ where: { recurso_registro_id: { recurso, registro_id: id } } }))?.ativo;
  const eventos = (id: string) => prisma.sincronizacao_outbox.findMany({ where: { registro_id: id }, orderBy: { id: 'asc' } });
  const receber = (operacao: 'delete' | 'desvinculo' | 'restauro', id: string, recurso = 'plantas', versao = '99', criado_em?: string) =>
    service.aplicar({ recurso: recurso as 'plantas', registro_id: id, operacao, versao, origem: OUTRO, payload: { id }, criado_em });
  /** Os avisos de cima que a tela mostra */
  const avisos = async () => (await service.listarAvisosDeExclusao()).avisos;
  const avisoDe = async (id: string) => (await avisos()).find((a) => a.registro_id === id)!;
  const pendenteDe = (id: string) => prisma.sincronizacao_exclusoes_pendentes.findFirst({ where: { registro_id: id }, orderBy: { id: 'desc' } });
  const criarEquipamentos = async () => {
    await prisma.equipamentos.create({ data: { id: ID_EQUIP, nome: 'UC aviso', classificacao: 'UC', criticidade: '3', unidade_id: ID_UNIDADE } });
    // O sub-equipamento nasce só com o pai, sem instalação própria
    await prisma.equipamentos.create({ data: { id: ID_SUB, nome: 'UAR aviso', classificacao: 'UAR', criticidade: '3', equipamento_pai_id: ID_EQUIP } });
  };

  describe('desvincular', () => {
    it('vale dos dois lados e desce a hierarquia: a planta leva a instalação, um desvinculo para cada', async () => {
      await outbox.vincular('unidades', ID_UNIDADE, ID_PROP); // a cadeia liga a planta e o dono junto
      await prisma.sincronizacao_outbox.deleteMany({ where: { registro_id: { in: DA_SINCRONIZACAO } } });

      const { desligados } = await outbox.desvincular('plantas', ID_PLANTA);

      expect(desligados).toBe(2);
      expect(await vinculoAtivo('plantas', ID_PLANTA)).toBe(false);
      expect(await vinculoAtivo('unidades', ID_UNIDADE)).toBe(false);
      expect((await eventos(ID_PLANTA)).map((e) => e.operacao)).toEqual(['desvinculo']);
      expect((await eventos(ID_UNIDADE)).map((e) => e.operacao)).toEqual(['desvinculo']);
      // O dono não está debaixo da planta: continua compartilhado
      expect(await vinculoAtivo('usuarios', ID_PROP)).toBe(true);
      // E o dado fica
      expect(await prisma.unidades.findUnique({ where: { id: ID_UNIDADE } })).not.toBeNull();
    });

    it('desvinculo recebido desliga o vinculo daqui sem tocar no dado nem gerar evento', async () => {
      await outbox.vincular('plantas', ID_PLANTA, ID_PROP);
      await prisma.sincronizacao_outbox.deleteMany({ where: { registro_id: { in: DA_SINCRONIZACAO } } });

      const r = await receber('desvinculo', ID_PLANTA);

      expect(r.resultado).toBe('desvinculado');
      expect(await vinculoAtivo('plantas', ID_PLANTA)).toBe(false);
      expect((await prisma.plantas.findUnique({ where: { id: ID_PLANTA } }))?.deleted_at).toBeNull();
      expect(await eventos(ID_PLANTA)).toHaveLength(0);
    });
  });

  describe('compartilhar de novo depois de parar', () => {
    const vinculoDeLa = async (nome: string, versao = '1') => {
      const linha = await prisma.plantas.findUniqueOrThrow({ where: { id: ID_PLANTA } });
      return service.aplicar({
        recurso: 'plantas', registro_id: ID_PLANTA, operacao: 'vinculo', versao, origem: OUTRO,
        payload: { ...montarPayload('plantas', linha), nome },
      });
    };

    it('compartilhar aqui manda vinculo (nao upsert)', async () => {
      await outbox.vincular('plantas', ID_PLANTA, ID_PROP);
      expect((await eventos(ID_PLANTA)).map((e) => e.operacao)).toEqual(['vinculo']);
    });

    it('o vinculo de la religa o vinculo daqui e grava, mesmo com versao menor (a daqui e de antes de parar)', async () => {
      await outbox.vincular('plantas', ID_PLANTA, ID_PROP);
      await prisma.plantas.update({ where: { id: ID_PLANTA }, data: { nome: 'Editada aqui' } }); // versão daqui sobe
      await receber('desvinculo', ID_PLANTA);
      // Um upsert de lá com o vínculo desligado continua ignorado
      const linha = await prisma.plantas.findUniqueOrThrow({ where: { id: ID_PLANTA } });
      const upsert = await service.aplicar({
        recurso: 'plantas', registro_id: ID_PLANTA, operacao: 'upsert', versao: '99', origem: OUTRO,
        payload: { ...montarPayload('plantas', linha), nome: 'Upsert de la' },
      });
      expect(upsert.resultado).toBe('ignorado_desvinculado');

      const r = await vinculoDeLa('Compartilhada de novo la');

      expect(r.resultado).toBe('aplicado');
      expect(await vinculoAtivo('plantas', ID_PLANTA)).toBe(true);
      expect((await prisma.plantas.findUniqueOrThrow({ where: { id: ID_PLANTA } })).nome).toBe('Compartilhada de novo la');
      // O que foi trocado fica na auditoria
      expect(
        await prisma.sincronizacao_auditoria.findFirst({ where: { registro_id: ID_PLANTA, resultado: 'aplicado', detalhe: { startsWith: 'religado' } } }),
      ).not.toBeNull();
    });

    it('com o vinculo daqui ligado e a versao daqui maior, a versao daqui volta para la (sem ela, os dois divergiam)', async () => {
      await outbox.vincular('plantas', ID_PLANTA, ID_PROP);
      await prisma.plantas.update({ where: { id: ID_PLANTA }, data: { nome: 'Mais nova aqui' } }); // versão daqui sobe
      await prisma.sincronizacao_outbox.deleteMany({ where: { registro_id: ID_PLANTA } });
      const versaoDaqui = (await prisma.sincronizacao_vinculos.findUniqueOrThrow({ where: { recurso_registro_id: { recurso: 'plantas', registro_id: ID_PLANTA } } })).versao;

      const r = await vinculoDeLa('Velha de la', '1');

      expect(r.resultado).toBe('ignorado_versao');
      expect((await prisma.plantas.findUniqueOrThrow({ where: { id: ID_PLANTA } })).nome).toBe('Mais nova aqui');
      expect((await eventos(ID_PLANTA)).map((e) => [e.operacao, e.versao])).toEqual([['upsert', versaoDaqui]]);
    });

    it('o upsert de la sobre registro apagado aqui (vinculo ligado, o legado) e recusado, nao "aplicado"', async () => {
      await outbox.vincular('plantas', ID_PLANTA, ID_PROP);
      // Apagado por SQL de replicação: o vínculo fica ligado, como no legado de antes de 10/11
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL sincronizacao.replicando = 'on'`);
        await tx.plantas.update({ where: { id: ID_PLANTA }, data: { deleted_at: new Date() } });
      });
      const linha = await prisma.plantas.findUniqueOrThrow({ where: { id: ID_PLANTA } });

      const r = await service.aplicar({
        recurso: 'plantas', registro_id: ID_PLANTA, operacao: 'upsert', versao: '99', origem: OUTRO,
        payload: { ...montarPayload('plantas', linha), nome: 'Nao entra' },
      });

      expect(r.resultado).toBe('recusado_apagado');
      expect((await prisma.plantas.findUniqueOrThrow({ where: { id: ID_PLANTA } })).nome).toBe('Planta aviso');
    });

    it('com o registro apagado aqui, recusa e nao religa', async () => {
      await outbox.vincular('plantas', ID_PLANTA, ID_PROP);
      await receber('desvinculo', ID_PLANTA);
      await prisma.plantas.update({ where: { id: ID_PLANTA }, data: { deleted_at: new Date() } });

      const r = await vinculoDeLa('Nao entra');

      expect(r.resultado).toBe('recusado_apagado');
      expect(await vinculoAtivo('plantas', ID_PLANTA)).toBe(false);
      expect((await prisma.plantas.findUniqueOrThrow({ where: { id: ID_PLANTA } })).nome).toBe('Planta aviso');
    });

    it('o selo daqui mostra a recusa de la, e ela some com o proximo aceite', async () => {
      await outbox.vincular('plantas', ID_PLANTA, ID_PROP);
      const enviado = (resultado: string) =>
        prisma.sincronizacao_auditoria.create({ data: { direcao: 'enviado', recurso: 'plantas', registro_id: ID_PLANTA, origem: ESTE, resultado } });

      await enviado('ignorado_desvinculado');
      const [recusado] = await service.estado('plantas', [ID_PLANTA]);
      expect(recusado).toMatchObject({ compartilhado: true, recusado: 'lá este registro deixou de ser compartilhado' });

      await new Promise((r) => setTimeout(r, 5)); // criado_em em milissegundos: o aceite vem depois
      await enviado('aplicado');
      const [aceito] = await service.estado('plantas', [ID_PLANTA]);
      expect(aceito.recusado).toBeNull();
    });
  });

  describe('exclusao recebida', () => {
    it('vira aviso, com a data da exclusao de la, e a reentrega nao duplica', async () => {
      await outbox.vincular('plantas', ID_PLANTA, ID_PROP);

      expect((await receber('delete', ID_PLANTA, 'plantas', '99', '2026-10-26T19:25:00.000Z')).resultado).toBe('exclusao_nao_aplicada');
      // A segunda vez o vínculo já está desligado: ignorada, sem segundo aviso
      expect((await receber('delete', ID_PLANTA, 'plantas', '99', '2026-10-26T19:25:00.000Z')).resultado).toBe('ignorado_desvinculado');

      const daPlanta = (await avisos()).filter((a) => a.registro_id === ID_PLANTA);
      expect(daPlanta).toHaveLength(1);
      expect(daPlanta[0]).toMatchObject({ recurso: 'plantas', nome: 'Planta aviso', origem: OUTRO, apagado_em: '2026-10-26T19:25:00.000Z', abaixo: 0 });
      expect((await prisma.plantas.findUnique({ where: { id: ID_PLANTA } }))?.deleted_at).toBeNull();
    });

    it('com versao menor que a daqui, ainda vira aviso (a edicao concorrente nao a anula)', async () => {
      await outbox.vincular('plantas', ID_PLANTA, ID_PROP);
      await prisma.plantas.update({ where: { id: ID_PLANTA }, data: { nome: 'Editada aqui' } }); // versão sobe

      const r = await receber('delete', ID_PLANTA, 'plantas', '1');

      expect(r.resultado).toBe('exclusao_nao_aplicada');
      expect((await avisos()).some((a) => a.registro_id === ID_PLANTA)).toBe(true);
    });

    it('restaurado la: o aviso daqui se fecha como restaurado, e o vinculo segue desligado', async () => {
      await outbox.vincular('plantas', ID_PLANTA, ID_PROP);
      await receber('delete', ID_PLANTA);

      const r = await receber('restauro', ID_PLANTA);

      expect(r.resultado).toBe('restauro_recebido');
      expect((await pendenteDe(ID_PLANTA))?.decisao).toBe('restaurado');
      expect((await avisos()).some((a) => a.registro_id === ID_PLANTA)).toBe(false);
      expect(await vinculoAtivo('plantas', ID_PLANTA)).toBe(false);
    });

    it('a planta apagada la com a instalacao: um aviso so na lista, com a instalacao debaixo', async () => {
      await outbox.vincular('unidades', ID_UNIDADE, ID_PROP);
      await receber('delete', ID_UNIDADE, 'unidades');
      await receber('delete', ID_PLANTA);

      const lista = await service.listarAvisosDeExclusao();

      expect(lista.avisos.filter((a) => [ID_PLANTA, ID_UNIDADE].includes(a.registro_id))).toEqual([
        expect.objectContaining({ registro_id: ID_PLANTA, abaixo: 1 }),
      ]);
    });
  });

  describe('a decisao sobre o aviso', () => {
    it('apagar apaga aqui com a instalacao; a instalacao ainda compartilhada avisa o outro lado', async () => {
      await outbox.vincular('unidades', ID_UNIDADE, ID_PROP);
      await receber('delete', ID_PLANTA);
      await prisma.sincronizacao_outbox.deleteMany({ where: { registro_id: { in: DA_SINCRONIZACAO } } });

      const { apagados } = await service.decidirAvisoDeExclusao((await avisoDe(ID_PLANTA)).id, 'apagar', ID_PROP);

      expect(apagados).toBe(2);
      expect((await prisma.plantas.findUnique({ where: { id: ID_PLANTA } }))?.deleted_at).not.toBeNull();
      expect((await prisma.unidades.findUnique({ where: { id: ID_UNIDADE } }))?.deleted_at).not.toBeNull();
      // A instalação estava compartilhada: apagá-la aqui é exclusão normal (o trigger
      // desliga o vínculo e manda o aviso dela)
      expect(await vinculoAtivo('unidades', ID_UNIDADE)).toBe(false);
      expect((await eventos(ID_UNIDADE)).map((e) => e.operacao)).toEqual(['delete']);
      const auditoria = await prisma.sincronizacao_auditoria.findFirst({ where: { registro_id: ID_PLANTA, resultado: 'exclusao_apagada' } });
      expect(auditoria?.ator).toBe(ID_PROP);
      expect(await avisos()).not.toContainEqual(expect.objectContaining({ registro_id: ID_PLANTA }));
    });

    it('manter deixa so aqui; decidir de novo e 409, aviso que nao existe e 404', async () => {
      await outbox.vincular('plantas', ID_PLANTA, ID_PROP);
      await receber('delete', ID_PLANTA);
      const aviso = await avisoDe(ID_PLANTA);

      await service.decidirAvisoDeExclusao(aviso.id, 'manter', ID_PROP);

      expect((await prisma.plantas.findUnique({ where: { id: ID_PLANTA } }))?.deleted_at).toBeNull();
      expect(await prisma.sincronizacao_auditoria.findFirst({ where: { registro_id: ID_PLANTA, resultado: 'exclusao_mantida' } })).not.toBeNull();
      await expect(service.decidirAvisoDeExclusao(aviso.id, 'apagar')).rejects.toBeInstanceOf(ConflictException);
      await expect(service.decidirAvisoDeExclusao('999999999999', 'apagar')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.decidirAvisoDeExclusao('não-é-número', 'apagar')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('manter a planta mantem a instalacao: o aviso de baixo fecha junto, com linha propria na auditoria', async () => {
      await outbox.vincular('unidades', ID_UNIDADE, ID_PROP);
      await receber('delete', ID_UNIDADE, 'unidades');
      await receber('delete', ID_PLANTA);

      const { avisosFechados } = await service.decidirAvisoDeExclusao((await avisoDe(ID_PLANTA)).id, 'manter', ID_PROP);

      expect(avisosFechados).toBe(1);
      expect((await pendenteDe(ID_UNIDADE))?.decisao).toBe('manter');
      expect(await prisma.sincronizacao_auditoria.findFirst({ where: { registro_id: ID_UNIDADE, resultado: 'exclusao_mantida' } })).toMatchObject({
        ator: ID_PROP,
        detalhe: expect.stringContaining(`plantas/${ID_PLANTA}`),
      });
      expect((await prisma.unidades.findUnique({ where: { id: ID_UNIDADE } }))?.deleted_at).toBeNull();
    });

    it('o alcance diz o que vai junto e o que la nao foi apagado', async () => {
      await prisma.unidades.create({ data: { id: ID_UNIDADE_2, nome: 'Só daqui', planta_id: ID_PLANTA } });
      await criarEquipamentos();
      await outbox.vincular('unidades', ID_UNIDADE, ID_PROP);
      await receber('delete', ID_UNIDADE, 'unidades');
      await receber('delete', ID_PLANTA);

      const alcance = await service.alcanceDoAvisoDeExclusao((await avisoDe(ID_PLANTA)).id);

      // As duas instalações e os dois equipamentos (o sub-equipamento entra pelo pai);
      // lá só a planta e a primeira instalação foram apagadas
      expect(alcance).toEqual({ unidades: 2, equipamentos: 2, naoApagadosLa: { unidades: 1, equipamentos: 2, nomesDasInstalacoes: ['Só daqui'] } });
      await expect(service.alcanceDoAvisoDeExclusao('999999999999')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('apagar pelo aviso deixa o usuario inativo, como a tela', async () => {
      await prisma.usuarios.create({ data: { id: ID_USUARIO, nome: 'Usuario aviso', email: 'usuario.aviso@exemplo.local' } });
      await outbox.vincular('usuarios', ID_USUARIO, ID_PROP);
      await receber('delete', ID_USUARIO, 'usuarios');

      await service.decidirAvisoDeExclusao((await avisoDe(ID_USUARIO)).id, 'apagar', ID_PROP);

      const u = await prisma.usuarios.findUniqueOrThrow({ where: { id: ID_USUARIO } });
      expect(u.deleted_at).not.toBeNull();
      expect(u.is_active).toBe(false);
      expect(u.status).toBe('Inativo');
    });
  });

  describe('apagar e restaurar aqui o que e compartilhado (o trigger)', () => {
    it('apagar desliga o vinculo junto e manda o aviso; restaurar manda o restauro e nao religa', async () => {
      await outbox.vincular('plantas', ID_PLANTA, ID_PROP);
      await prisma.sincronizacao_outbox.deleteMany({ where: { registro_id: { in: DA_SINCRONIZACAO } } });

      await prisma.plantas.update({ where: { id: ID_PLANTA }, data: { deleted_at: new Date() } });
      expect(await vinculoAtivo('plantas', ID_PLANTA)).toBe(false);
      expect((await eventos(ID_PLANTA)).map((e) => e.operacao)).toEqual(['delete']);

      await prisma.plantas.update({ where: { id: ID_PLANTA }, data: { deleted_at: null, nome: 'Restaurada' } });
      expect((await eventos(ID_PLANTA)).map((e) => e.operacao)).toEqual(['delete', 'restauro']);
      expect(await vinculoAtivo('plantas', ID_PLANTA)).toBe(false);

      // Editar depois de restaurado não manda nada (o vínculo segue desligado)
      await prisma.plantas.update({ where: { id: ID_PLANTA }, data: { nome: 'Depois' } });
      expect(await eventos(ID_PLANTA)).toHaveLength(2);
    });

    it('restaurar pelo SQL manual, com replicando, tambem manda o restauro (o jeito da casa de restaurar)', async () => {
      await outbox.vincular('plantas', ID_PLANTA, ID_PROP);
      await prisma.plantas.update({ where: { id: ID_PLANTA }, data: { deleted_at: new Date() } });
      await prisma.sincronizacao_outbox.deleteMany({ where: { registro_id: ID_PLANTA } });

      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL sincronizacao.replicando = 'on'`);
        await tx.plantas.update({ where: { id: ID_PLANTA }, data: { deleted_at: null } });
      });

      expect((await eventos(ID_PLANTA)).map((e) => e.operacao)).toEqual(['restauro']);
    });

    it('restaurar o que nunca foi compartilhado nao manda nada', async () => {
      await prisma.plantas.update({ where: { id: ID_PLANTA }, data: { deleted_at: new Date() } });
      await prisma.plantas.update({ where: { id: ID_PLANTA }, data: { deleted_at: null } });
      expect(await eventos(ID_PLANTA)).toHaveLength(0);
    });
  });

  describe('excluir o que e compartilhado pede confirmacao', () => {
    it('a cascata conta o que esta compartilhado debaixo, com o nome das instalacoes', async () => {
      await outbox.vincular('unidades', ID_UNIDADE, ID_PROP);

      const c = await compartilhadosNaCascata(prisma, 'plantas', ID_PLANTA);

      expect(c).toMatchObject({ total: 2, plantas: 1, unidades: 1, equipamentos: 0, nomesDasInstalacoes: ['Instalação aviso'] });
      expect((await compartilhadosNaCascata(prisma, 'unidades', ID_UNIDADE)).total).toBe(1);
    });

    it('sem a confirmacao, 409; com ela, exclui (planta e instalacao)', async () => {
      await outbox.vincular('unidades', ID_UNIDADE, ID_PROP);
      const plantas = new PlantasService(db, {} as never);
      const unidades = new UnidadesService(db, {} as never);

      await expect(unidades.remove(ID_UNIDADE)).rejects.toBeInstanceOf(ConflictException);
      await expect(plantas.remove(ID_PLANTA)).rejects.toThrow(/compartilhada com o outro produto \(1 planta e 1 instalação\)/);
      expect((await prisma.plantas.findUnique({ where: { id: ID_PLANTA } }))?.deleted_at).toBeNull();

      await plantas.remove(ID_PLANTA, true);
      expect((await prisma.plantas.findUnique({ where: { id: ID_PLANTA } }))?.deleted_at).not.toBeNull();
    });

    it('o que nao e compartilhado exclui sem pedir nada', async () => {
      const plantas = new PlantasService(db, {} as never);
      await expect(plantas.remove(ID_PLANTA)).resolves.toMatchObject({ message: expect.stringMatching(/removida/) });
    });

    it('excluir a planta leva o sub-equipamento, que so tem o pai (a arvore da cascata e a da exclusao)', async () => {
      await criarEquipamentos();
      expect(await descendentes(prisma, 'plantas', ID_PLANTA, { soVivos: true })).toEqual(
        expect.arrayContaining([{ recurso: 'equipamentos', registro_id: ID_SUB }]),
      );

      const r = await new PlantasService(db, {} as never).remove(ID_PLANTA);

      expect(r).toMatchObject({ deletedUnits: 1, deletedEquipments: 2 });
      expect((await prisma.equipamentos.findUniqueOrThrow({ where: { id: ID_SUB } })).deleted_at).not.toBeNull();
    });

    it('excluir a instalacao leva o sub-equipamento tambem', async () => {
      await criarEquipamentos();

      const r = await new UnidadesService(db, {} as never).remove(ID_UNIDADE);

      expect(r).toMatchObject({ deletedEquipments: 2 });
      expect((await prisma.equipamentos.findUniqueOrThrow({ where: { id: ID_SUB } })).deleted_at).not.toBeNull();
    });
  });

  describe('o upsert recebido', () => {
    it('com deleted_at nao apaga aqui (a exclusao so atravessa como aviso)', async () => {
      await outbox.vincular('plantas', ID_PLANTA, ID_PROP);
      const linha = await prisma.plantas.findUniqueOrThrow({ where: { id: ID_PLANTA } });

      const r = await service.aplicar({
        recurso: 'plantas', registro_id: ID_PLANTA, operacao: 'upsert', versao: '99', origem: OUTRO,
        payload: { ...montarPayload('plantas', linha), nome: 'Editada la', deleted_at: new Date().toISOString() },
      });

      expect(r.resultado).toBe('aplicado');
      const depois = await prisma.plantas.findUniqueOrThrow({ where: { id: ID_PLANTA } });
      expect(depois.nome).toBe('Editada la');
      expect(depois.deleted_at).toBeNull();
    });
  });
});
