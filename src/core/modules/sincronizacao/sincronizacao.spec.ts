import { PrismaClient } from '@prisma/client';
import { SincronizacaoService } from './sincronizacao.service';
import { OutboxService } from './outbox.service';
import { montarPayload, filtrarParaEsteBanco } from './recursos';

/**
 * As duas coisas que, se estiverem erradas, quebram calado:
 *
 *   o LACO — o Service manda para o NexOn, o NexOn grava, a gravacao gera
 *   evento de volta, e os dois ficam se empurrando o mesmo registro para
 *   sempre. Nao da erro: da carga.
 *
 *   o DESEMPATE — os dois lados precisam eleger o MESMO vencedor sozinhos,
 *   sem se falar. Se divergirem, cada banco fica com uma versao diferente do
 *   mesmo cadastro e nada aponta para isso.
 */
describe('sincronizacao (banco real)', () => {
  const prisma = new PrismaClient();
  const service = new SincronizacaoService(prisma as any);
  const outbox = new OutboxService(prisma as any);

  const ID_PROP = 'TESTESYNCPROPRIETARIO0001';
  const ID_PLANTA = 'TESTESYNCPLANTA000000001';

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO sincronizacao_no (travar, origem) VALUES (TRUE, 'service')
       ON CONFLICT (travar) DO UPDATE SET origem = 'service'`);
    await prisma.usuarios.upsert({
      where: { id: ID_PROP }, update: {},
      create: { id: ID_PROP, nome: 'Prop sync', email: 'sync.teste@exemplo.local' },
    });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM sincronizacao_outbox WHERE registro_id = $1`, ID_PLANTA);
    await prisma.$executeRawUnsafe(`DELETE FROM sincronizacao_auditoria WHERE registro_id = $1`, ID_PLANTA);
    await prisma.$executeRawUnsafe(`DELETE FROM sincronizacao_vinculos WHERE registro_id = $1`, ID_PLANTA);
    await prisma.plantas.deleteMany({ where: { id: ID_PLANTA } });
    await prisma.plantas.create({
      data: {
        id: ID_PLANTA, nome: 'Planta sync', proprietario_id: ID_PROP,
        cnpj: '00000000000436', localizacao: 'T', horario_funcionamento: '8-18',
        logradouro: 'R 1', cidade: 'Goiania', uf: 'GO', cep: '74000000',
      },
    });
    // A criacao acima roda ANTES do vinculo existir, entao nao gera evento.
    await prisma.$executeRawUnsafe(`DELETE FROM sincronizacao_outbox WHERE registro_id = $1`, ID_PLANTA);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM sincronizacao_outbox WHERE registro_id = $1`, ID_PLANTA);
    await prisma.$executeRawUnsafe(`DELETE FROM sincronizacao_auditoria WHERE registro_id = $1`, ID_PLANTA);
    await prisma.$executeRawUnsafe(`DELETE FROM sincronizacao_vinculos WHERE registro_id = $1`, ID_PLANTA);
    await prisma.plantas.deleteMany({ where: { id: ID_PLANTA } });
    await prisma.$disconnect();
  });

  const pendentes = () => prisma.sincronizacao_outbox.count({
    where: { registro_id: ID_PLANTA, entregue_em: null },
  });

  /**
   * O payload como o worker monta: a linha INTEIRA.
   *
   * Montar a mao com tres campos passaria por cima de uma diferenca que importa
   * — `plantas` exige `cnpj` no create, e um payload parcial so funcionaria
   * quando a linha ja existisse do outro lado. O teste tem de usar o mesmo
   * caminho do worker para provar alguma coisa.
   */
  const payloadReal = async (nome: string) => {
    const linha = await prisma.plantas.findUnique({ where: { id: ID_PLANTA } });
    return { ...montarPayload('plantas', linha as any), nome };
  };

  describe('o portao', () => {
    it('registro NAO vinculado nao gera evento nenhum', async () => {
      await prisma.plantas.update({ where: { id: ID_PLANTA }, data: { nome: 'Mudei' } });

      // Sincronizar tudo automaticamente faria cadastro novo vazar para o outro
      // produto sem ninguem ter decidido.
      expect(await pendentes()).toBe(0);
    });

    it('vincular ja enfileira o registro inteiro, sem esperar uma edicao', async () => {
      await outbox.vincular('plantas', ID_PLANTA, ID_PROP);

      // Vincular nao altera a planta, entao nenhum trigger dispara: se o evento
      // inicial nao fosse inserido a mao, o botao diria "compartilhado" e nada
      // teria atravessado ate alguem editar.
      expect(await pendentes()).toBe(1);
    });

    it('depois de vinculado, editar gera evento', async () => {
      await outbox.vincular('plantas', ID_PLANTA, ID_PROP);
      await prisma.plantas.update({ where: { id: ID_PLANTA }, data: { nome: 'Editada' } });

      expect(await pendentes()).toBe(2);
    });

    it('desvincular corta o fluxo sem apagar a planta', async () => {
      await outbox.vincular('plantas', ID_PLANTA, ID_PROP);
      await outbox.desvincular('plantas', ID_PLANTA);
      await prisma.plantas.update({ where: { id: ID_PLANTA }, data: { nome: 'Depois' } });

      expect(await pendentes()).toBe(1); // so o inicial
      expect(await prisma.plantas.findUnique({ where: { id: ID_PLANTA } })).not.toBeNull();
    });
  });

  describe('o laco', () => {
    it('aplicar evento do outro lado NAO gera evento de volta', async () => {
      await outbox.vincular('plantas', ID_PLANTA, ID_PROP);
      await prisma.sincronizacao_outbox.deleteMany({ where: { registro_id: ID_PLANTA } });

      await service.aplicar({
        recurso: 'plantas', registro_id: ID_PLANTA, operacao: 'upsert',
        versao: '99', origem: 'nexon',
        payload: await payloadReal('Veio do NexOn'),
      });

      // Se isto falhar, os dois produtos entram em laco infinito — e sem erro
      // nenhum, so carga crescente nos dois servidores.
      expect(await pendentes()).toBe(0);
      const p = await prisma.plantas.findUnique({ where: { id: ID_PLANTA } });
      expect(p?.nome).toBe('Veio do NexOn');
    });

    it('a marca de replicacao nao vaza para a escrita seguinte', async () => {
      await outbox.vincular('plantas', ID_PLANTA, ID_PROP);
      await service.aplicar({
        recurso: 'plantas', registro_id: ID_PLANTA, operacao: 'upsert',
        versao: '99', origem: 'nexon',
        payload: await payloadReal('Do NexOn'),
      });
      await prisma.sincronizacao_outbox.deleteMany({ where: { registro_id: ID_PLANTA } });

      await prisma.plantas.update({ where: { id: ID_PLANTA }, data: { nome: 'Edicao local' } });

      // `SET LOCAL` morre no fim da transacao. Se vazasse pela conexao do pool,
      // edicoes locais parariam de sincronizar silenciosamente.
      expect(await pendentes()).toBe(1);
    });
  });

  describe('o desempate', () => {
    const aplicar = async (versao: string, origem: string, nome: string) =>
      service.aplicar({
        recurso: 'plantas', registro_id: ID_PLANTA, operacao: 'upsert',
        versao, origem, payload: await payloadReal(nome),
      });

    it('versao maior vence', async () => {
      await outbox.vincular('plantas', ID_PLANTA, ID_PROP);
      await aplicar('50', 'nexon', 'Versao 50');

      expect((await aplicar('51', 'nexon', 'Versao 51')).resultado).toBe('aplicado');
      expect((await prisma.plantas.findUnique({ where: { id: ID_PLANTA } }))?.nome).toBe('Versao 51');
    });

    it('versao menor e descartada, e o descarte fica registrado', async () => {
      await outbox.vincular('plantas', ID_PLANTA, ID_PROP);
      await aplicar('50', 'nexon', 'Versao 50');

      expect((await aplicar('49', 'nexon', 'Versao 49')).resultado).toBe('ignorado_versao');
      expect((await prisma.plantas.findUnique({ where: { id: ID_PLANTA } }))?.nome).toBe('Versao 50');

      // O unico rastro de uma edicao perdida. Sem ele ninguem responde "por que
      // minha alteracao sumiu".
      const auditoria = await prisma.sincronizacao_auditoria.findFirst({
        where: { registro_id: ID_PLANTA, resultado: 'ignorado_versao' },
      });
      expect(auditoria?.detalhe).toMatch(/venceu/);
    });

    it('empate de versao desempata pela origem, e sempre para o mesmo lado', async () => {
      await outbox.vincular('plantas', ID_PLANTA, ID_PROP);
      await aplicar('50', 'nexon', 'Do NexOn');

      // 'service' > 'nexon' em ordem alfabetica. Os dois nos rodam esta mesma
      // comparacao e chegam ao mesmo vencedor sem trocar mensagem — e isso que
      // faz os dois bancos convergirem.
      expect((await aplicar('50', 'service', 'Do Service')).resultado).toBe('aplicado');
      expect((await aplicar('50', 'nexon', 'NexOn de novo')).resultado).toBe('ignorado_versao');
      expect((await prisma.plantas.findUnique({ where: { id: ID_PLANTA } }))?.nome).toBe('Do Service');
    });

    it('reentrega do mesmo evento e inofensiva', async () => {
      await outbox.vincular('plantas', ID_PLANTA, ID_PROP);
      await aplicar('50', 'nexon', 'Uma vez');

      // O worker do outro lado reenvia quando nao tem certeza de que chegou. Se
      // isto virasse erro, a fila dele travaria numa entrega que deu certo.
      expect((await aplicar('50', 'nexon', 'Uma vez')).resultado).toBe('ignorado_duplicado');
    });
  });

  describe('dependencia', () => {
    it('recusa nomeando o que falta, em vez de arrastar junto', async () => {
      const r = await service.aplicar({
        recurso: 'plantas', registro_id: ID_PLANTA, operacao: 'upsert',
        versao: '1', origem: 'nexon',
        payload: { ...(await payloadReal('Orfa')), proprietario_id: 'NAOEXISTE00000000000000' },
      });

      // Um clique que silenciosamente copiasse o usuario e os privilegios dele
      // para o outro produto seria um buraco de seguranca, nao conveniencia.
      expect(r.resultado).toBe('dependencia_ausente');
      expect(r.detalhe).toMatch(/propriet/i);
    });
  });

  describe('o que nunca viaja', () => {
    it('senha, remember_token e role ficam fora do payload de saida', async () => {
      const usuario = await prisma.usuarios.findUnique({ where: { id: ID_PROP } });
      const payload = montarPayload('usuarios', usuario as any);

      expect(payload).not.toHaveProperty('senha');
      expect(payload).not.toHaveProperty('remember_token');
      expect(payload).not.toHaveProperty('role');
      expect(payload.email).toBe('sync.teste@exemplo.local');
    });

    it('e tambem sao barrados na ENTRADA, nao so na saida', async () => {
      const { dados, ignorados } = filtrarParaEsteBanco('usuarios', {
        nome: 'Fulano', senha: '$2b$hash', role: 'admin', campo_que_nao_existe: 1,
      });

      // A barreira vale nos dois sentidos: um remetente comprometido nao grava
      // senha nem eleva privilegio por aqui.
      expect(dados).toEqual({ nome: 'Fulano' });
      expect(ignorados.sort()).toEqual(['campo_que_nao_existe', 'role', 'senha']);
    });
  });
});
