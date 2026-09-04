import { PrismaClient } from '@prisma/client';
import { resolverCadeia } from './cadeia-de-dependencias';

/**
 * A hierarquia: nao existe planta sem proprietario, nem instalacao sem planta,
 * nem equipamento sem instalacao.
 *
 * O que se prova aqui e que a cadeia sai COMPLETA e na ORDEM certa — o mais
 * basico primeiro. Ordem errada nao quebra nada visivel: o receptor recusa por
 * dependencia ausente, o evento entra em retry e passa no ciclo seguinte. Custa
 * um backoff a toa e suja a auditoria com uma recusa evitavel, e ninguem ligaria
 * os pontos depois.
 */
describe('cadeia de dependencias (banco real)', () => {
  const prisma = new PrismaClient();

  const ID_PROP = 'TESTECADPROPRIETARIO00001';
  const ID_PLANTA = 'TESTECADPLANTA0000000001';
  const ID_UNIDADE = 'TESTECADUNIDADE000000001';
  const ID_EQUIP = 'TESTECADEQUIP00000000001';

  const limpar = async () => {
    for (const id of [ID_EQUIP, ID_UNIDADE, ID_PLANTA, ID_PROP]) {
      await prisma.$executeRawUnsafe(`DELETE FROM sincronizacao_vinculos WHERE registro_id = $1`, id);
    }
    await prisma.equipamentos.deleteMany({ where: { id: ID_EQUIP } });
    await prisma.unidades.deleteMany({ where: { id: ID_UNIDADE } });
    await prisma.plantas.deleteMany({ where: { id: ID_PLANTA } });
    await prisma.usuarios.deleteMany({ where: { id: ID_PROP } });
  };

  beforeEach(async () => {
    await limpar();

    await prisma.usuarios.create({
      data: { id: ID_PROP, nome: 'Dona da Planta', email: 'cadeia.teste@exemplo.local' },
    });
    await prisma.plantas.create({
      data: {
        id: ID_PLANTA, nome: 'Planta Cadeia', proprietario_id: ID_PROP,
        cnpj: '00000000000440', localizacao: 'T', horario_funcionamento: '8-18',
        logradouro: 'R 1', cidade: 'Goiania', uf: 'GO', cep: '74000000',
      },
    });
    await prisma.unidades.create({
      data: {
        id: ID_UNIDADE, planta_id: ID_PLANTA, nome: 'Instalacao Cadeia', tipo: 'Carga',
        estado: 'GO', cidade: 'Goiania', latitude: 0, longitude: 0, potencia: 0,
      },
    });
    await prisma.equipamentos.create({
      data: {
        id: ID_EQUIP, nome: 'Equipamento Cadeia', classificacao: 'UC',
        criticidade: '3', unidade_id: ID_UNIDADE,
      },
    });
  });

  afterAll(async () => {
    await limpar();
    await prisma.$disconnect();
  });

  const compartilhar = (recurso: string, id: string) =>
    prisma.sincronizacao_vinculos.create({
      data: { recurso, registro_id: id, origem: 'service', ativo: true },
    });

  it('equipamento puxa instalacao, planta e proprietario, do mais basico ao mais especifico', async () => {
    const cadeia = await resolverCadeia(prisma as any, 'equipamentos', ID_EQUIP);

    expect(cadeia.alvo.nome).toBe('Equipamento Cadeia');
    // A ordem E o resultado: vincular a planta antes do dono dela faria o
    // receptor recusar e reprocessar sem necessidade.
    expect(cadeia.faltando.map(e => e.recurso)).toEqual(['usuarios', 'plantas', 'unidades']);
    expect(cadeia.faltando.map(e => e.nome)).toEqual([
      'Dona da Planta', 'Planta Cadeia', 'Instalacao Cadeia',
    ]);
  });

  it('planta puxa so o proprietario', async () => {
    const cadeia = await resolverCadeia(prisma as any, 'plantas', ID_PLANTA);

    expect(cadeia.faltando.map(e => e.recurso)).toEqual(['usuarios']);
    expect(cadeia.faltando[0].comoChamar).toBe('o proprietário');
  });

  it('usuario nao puxa nada — e o topo da hierarquia', async () => {
    const cadeia = await resolverCadeia(prisma as any, 'usuarios', ID_PROP);

    expect(cadeia.faltando).toEqual([]);
  });

  it('para de subir no primeiro nivel ja compartilhado', async () => {
    // Com a planta ja compartilhada, o outro lado tambem ja tem o dono dela —
    // a cadeia acima foi resolvida quando ELA foi compartilhada.
    await compartilhar('plantas', ID_PLANTA);

    const cadeia = await resolverCadeia(prisma as any, 'equipamentos', ID_EQUIP);

    expect(cadeia.faltando.map(e => e.recurso)).toEqual(['unidades']);
  });

  it('cadeia vazia quando tudo acima ja esta compartilhado', async () => {
    await compartilhar('unidades', ID_UNIDADE);

    const cadeia = await resolverCadeia(prisma as any, 'equipamentos', ID_EQUIP);

    expect(cadeia.faltando).toEqual([]);
  });

  it('vinculo INATIVO conta como nao compartilhado', async () => {
    await prisma.sincronizacao_vinculos.create({
      data: { recurso: 'unidades', registro_id: ID_UNIDADE, origem: 'service', ativo: false },
    });

    // Quem parou de compartilhar quer que o registro volte a atravessar quando
    // for religado; tratar "existe linha" como "esta compartilhado" faria a
    // instalacao sumir da confirmacao e o evento ser recusado depois.
    const cadeia = await resolverCadeia(prisma as any, 'equipamentos', ID_EQUIP);

    expect(cadeia.faltando.map(e => e.recurso)).toContain('unidades');
  });

  it('nao lista o mesmo registro duas vezes quando ha dois caminhos ate ele', async () => {
    // Equipamento UAR: chega na instalacao pelo proprio unidade_id E pelo pai.
    const ID_FILHO = 'TESTECADFILHO00000000001';
    await prisma.equipamentos.deleteMany({ where: { id: ID_FILHO } });
    await prisma.equipamentos.create({
      data: {
        id: ID_FILHO, nome: 'Componente', classificacao: 'UAR', criticidade: '3',
        unidade_id: ID_UNIDADE, equipamento_pai_id: ID_EQUIP,
      },
    });

    const cadeia = await resolverCadeia(prisma as any, 'equipamentos', ID_FILHO);

    const unidades = cadeia.faltando.filter(e => e.recurso === 'unidades');
    expect(unidades).toHaveLength(1);

    await prisma.equipamentos.deleteMany({ where: { id: ID_FILHO } });
  });
});
