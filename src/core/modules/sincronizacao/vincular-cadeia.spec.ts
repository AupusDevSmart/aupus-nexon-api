import { PrismaClient } from '@prisma/client';
import { OutboxService } from './outbox.service';

/**
 * Vincular um equipamento tem que arrastar a hierarquia inteira JUNTO.
 *
 * Nao existe planta sem proprietario nem instalacao sem planta. Vincular so o
 * equipamento faria o receptor recusar por dependencia ausente, o evento entrar
 * em backoff, e o registro so aparecer do outro lado quando alguem, por acaso,
 * compartilhasse a planta. Enquanto isso o botao ja teria dito "compartilhado".
 */
describe('vincular com cadeia (banco real)', () => {
  const prisma = new PrismaClient();
  const outbox = new OutboxService(prisma as any);

  const ID_PROP = 'TESTEVINPROPRIETARIO00001';
  const ID_PLANTA = 'TESTEVINPLANTA0000000001';
  const ID_UNIDADE = 'TESTEVINUNIDADE000000001';
  const ID_EQUIP = 'TESTEVINEQUIP00000000001';
  const TODOS = [ID_EQUIP, ID_UNIDADE, ID_PLANTA, ID_PROP];

  const limpar = async () => {
    for (const id of TODOS) {
      await prisma.$executeRawUnsafe(`DELETE FROM sincronizacao_outbox WHERE registro_id = $1`, id);
      await prisma.$executeRawUnsafe(`DELETE FROM sincronizacao_vinculos WHERE registro_id = $1`, id);
    }
    await prisma.equipamentos.deleteMany({ where: { id: ID_EQUIP } });
    await prisma.unidades.deleteMany({ where: { id: ID_UNIDADE } });
    await prisma.plantas.deleteMany({ where: { id: ID_PLANTA } });
    await prisma.usuarios.deleteMany({ where: { id: ID_PROP } });
  };

  beforeEach(async () => {
    await limpar();
    await prisma.$executeRawUnsafe(
      `INSERT INTO sincronizacao_no (travar, origem) VALUES (TRUE,'service')
       ON CONFLICT (travar) DO UPDATE SET origem='service'`);

    await prisma.usuarios.create({
      data: { id: ID_PROP, nome: 'Dono Vinculo', email: 'vinculo.teste@exemplo.local' },
    });
    await prisma.plantas.create({
      data: {
        id: ID_PLANTA, nome: 'Planta Vinculo', proprietario_id: ID_PROP,
        cnpj: '00000000000441', localizacao: 'T', horario_funcionamento: '8-18',
        logradouro: 'R 1', cidade: 'Goiania', uf: 'GO', cep: '74000000',
      },
    });
    await prisma.unidades.create({
      data: {
        id: ID_UNIDADE, planta_id: ID_PLANTA, nome: 'Instalacao Vinculo', tipo: 'Carga',
        estado: 'GO', cidade: 'Goiania', latitude: 0, longitude: 0, potencia: 0,
      },
    });
    await prisma.equipamentos.create({
      data: {
        id: ID_EQUIP, nome: 'Equipamento Vinculo', classificacao: 'UC',
        criticidade: '3', unidade_id: ID_UNIDADE,
      },
    });
  });

  afterAll(async () => {
    await limpar();
    await prisma.$disconnect();
  });

  it('vincular o equipamento vincula tambem instalacao, planta e proprietario', async () => {
    await outbox.vincular('equipamentos', ID_EQUIP);

    const vinculos = await prisma.sincronizacao_vinculos.findMany({
      where: { registro_id: { in: TODOS }, ativo: true },
      select: { recurso: true },
    });

    expect(vinculos.map(v => v.recurso).sort()).toEqual(
      ['equipamentos', 'plantas', 'unidades', 'usuarios'],
    );
  });

  it('os eventos saem na ordem da hierarquia, do mais basico ao mais especifico', async () => {
    await outbox.vincular('equipamentos', ID_EQUIP);

    const eventos = await prisma.sincronizacao_outbox.findMany({
      where: { registro_id: { in: TODOS } },
      orderBy: { id: 'asc' },
      select: { recurso: true },
    });

    // O worker entrega em ordem de id. Se a planta saisse antes do dono, o
    // receptor recusaria por dependencia ausente e gastaria um backoff.
    expect(eventos.map(e => e.recurso)).toEqual(
      ['usuarios', 'plantas', 'unidades', 'equipamentos'],
    );
  });

  it('nao revincula o que ja estava compartilhado', async () => {
    await outbox.vincular('plantas', ID_PLANTA); // arrasta o proprietario junto
    const antes = await prisma.sincronizacao_outbox.count({
      where: { registro_id: { in: TODOS } },
    });

    await outbox.vincular('equipamentos', ID_EQUIP);
    const depois = await prisma.sincronizacao_outbox.count({
      where: { registro_id: { in: TODOS } },
    });

    // So instalacao + equipamento sao novos; planta e dono ja estavam.
    expect(depois - antes).toBe(2);
  });

  it('alvo inexistente nao vincula nada', async () => {
    await expect(
      outbox.vincular('equipamentos', 'NAOEXISTE0000000000000000'),
    ).rejects.toThrow();

    const vinculos = await prisma.sincronizacao_vinculos.count({
      where: { registro_id: { in: TODOS }, ativo: true },
    });
    expect(vinculos).toBe(0);
  });

  /**
   * NAO ha teste de "elo do meio quebrado", e o motivo vale registrar: as FKs
   * do banco impedem montar esse cenario. Tentei apontar a instalacao para uma
   * planta fantasma e o equipamento para um pai inexistente — o Postgres recusou
   * os dois UPDATEs (`unidades_planta_id_fkey`, `equipamentos_equipamento_pai_id_fkey`).
   *
   * Ou seja, referencia pendurada no meio da hierarquia nao existe neste banco,
   * e o rollback do `$transaction` que cobriria esse caso e garantia do
   * Postgres, nao logica minha — testar isso seria testar o banco de dados.
   */
});
