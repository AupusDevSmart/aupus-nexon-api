import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { AxiosError, AxiosHeaders } from 'axios';
import { EntregaWorker, motivoDaFalha } from './entrega.worker';
import { OutboxService } from './outbox.service';

const ESTE = 'nexon';

/**
 * O que o worker manda para uma exclusão (10/11/2026): a hora em que ela
 * aconteceu (o aviso do outro lado diz "apagado em 26/10", não a data em que a
 * fila andou), e a exclusão cujo registro foi restaurado antes da entrega vai
 * como desvínculo, não como "apagado". Pelo `montarEnvio` do evento do próprio
 * teste: a rodada inteira entregaria a fila dos outros specs, que rodam juntos
 * no mesmo banco. Precisa do SQL 2026-11-10.
 */
describe('o envio da exclusao (banco real)', () => {
  const prisma = new PrismaClient();
  const worker = new EntregaWorker(prisma as unknown as PrismaService);
  const outbox = new OutboxService(prisma as unknown as PrismaService);
  const ID_PROP = 'TESTEENTREGAPROPRIETARIO1';
  const ID_PLANTA = 'TESTEENTREGAPLANTA0000001';
  const IDS = [ID_PROP, ID_PLANTA];

  const limpar = async () => {
    const where = { registro_id: { in: IDS } };
    await prisma.sincronizacao_outbox.deleteMany({ where });
    await prisma.sincronizacao_auditoria.deleteMany({ where });
    await prisma.sincronizacao_vinculos.deleteMany({ where });
    await prisma.plantas.deleteMany({ where: { id: ID_PLANTA } });
  };

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO sincronizacao_no (travar, origem) VALUES (TRUE, '${ESTE}') ON CONFLICT (travar) DO UPDATE SET origem = '${ESTE}'`,
    );
    await prisma.usuarios.upsert({ where: { id: ID_PROP }, update: {}, create: { id: ID_PROP, nome: 'Prop entrega', email: 'entrega.sync@exemplo.local' } });
  });

  beforeEach(async () => {
    await limpar();
    await prisma.plantas.create({ data: { id: ID_PLANTA, nome: 'Planta entrega', proprietario_id: ID_PROP } });
    await outbox.vincular('plantas', ID_PLANTA, ID_PROP);
  });

  afterAll(async () => {
    await limpar();
    await prisma.$disconnect();
  });

  /** O evento de exclusão que o trigger enfileirou para a planta */
  const exclusao = () => prisma.sincronizacao_outbox.findFirstOrThrow({ where: { registro_id: ID_PLANTA, operacao: 'delete' } });

  it('a exclusao vai com a hora em que aconteceu aqui', async () => {
    await prisma.plantas.update({ where: { id: ID_PLANTA }, data: { deleted_at: new Date() } });
    const evento = await exclusao();

    const envio = await worker.montarEnvio(evento, ESTE);

    expect(envio).toMatchObject({ registro_id: ID_PLANTA, operacao: 'delete', criado_em: evento.criado_em.toISOString(), payload: { id: ID_PLANTA } });
  });

  it('restaurada antes da entrega: vai como desvinculo, nao como "apagado"', async () => {
    await prisma.plantas.update({ where: { id: ID_PLANTA }, data: { deleted_at: new Date() } });
    await prisma.plantas.update({ where: { id: ID_PLANTA }, data: { deleted_at: null } });

    const envio = await worker.montarEnvio(await exclusao(), ESTE);

    expect(envio).toMatchObject({ registro_id: ID_PLANTA, operacao: 'desvinculo', payload: { id: ID_PLANTA } });
  });

  it('o upsert de registro apagado vai sem deleted_at (a exclusao nao atravessa no upsert)', async () => {
    await prisma.plantas.update({ where: { id: ID_PLANTA }, data: { nome: 'Planta entrega' } }); // a edição enfileira o upsert
    const upsert = await prisma.sincronizacao_outbox.findFirstOrThrow({ where: { registro_id: ID_PLANTA, operacao: 'upsert' } });
    await prisma.plantas.update({ where: { id: ID_PLANTA }, data: { deleted_at: new Date() } });

    const envio = await worker.montarEnvio(upsert, ESTE);

    expect(envio?.payload).toMatchObject({ id: ID_PLANTA, nome: 'Planta entrega' });
    expect(envio?.payload).not.toHaveProperty('deleted_at');
  });

  it('compartilhar vai como vinculo, com o conteudo (la grava ao religar)', async () => {
    const vinculo = await prisma.sincronizacao_outbox.findFirstOrThrow({ where: { registro_id: ID_PLANTA, operacao: 'vinculo' } });

    const envio = await worker.montarEnvio(vinculo, ESTE);

    expect(envio).toMatchObject({ operacao: 'vinculo', payload: { id: ID_PLANTA, nome: 'Planta entrega' } });
  });

  it('restaurar vai como restauro, so com o id', async () => {
    await prisma.plantas.update({ where: { id: ID_PLANTA }, data: { deleted_at: new Date() } });
    await prisma.plantas.update({ where: { id: ID_PLANTA }, data: { deleted_at: null } });
    const restauro = await prisma.sincronizacao_outbox.findFirstOrThrow({ where: { registro_id: ID_PLANTA, operacao: 'restauro' } });

    const envio = await worker.montarEnvio(restauro, ESTE);

    expect(envio).toMatchObject({ operacao: 'restauro', payload: { id: ID_PLANTA } });
    expect(Object.keys(envio?.payload as object)).toEqual(['id']);
  });

  it('o restauro de registro apagado de novo antes de sair nao vai (fecharia la o aviso que continua valendo)', async () => {
    await prisma.plantas.update({ where: { id: ID_PLANTA }, data: { deleted_at: new Date() } });
    await prisma.plantas.update({ where: { id: ID_PLANTA }, data: { deleted_at: null } });
    const restauro = await prisma.sincronizacao_outbox.findFirstOrThrow({ where: { registro_id: ID_PLANTA, operacao: 'restauro' } });
    await prisma.plantas.update({ where: { id: ID_PLANTA }, data: { deleted_at: new Date() } });

    expect(await worker.montarEnvio(restauro, ESTE)).toBeNull();
  });
});

/** O motivo que fica na fila e na saúde quando o outro lado recusa (o envelope `{ error: { message } }`) */
describe('o motivo da falha da entrega', () => {
  const recusa = (status: number, data: unknown) =>
    new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', undefined, undefined, {
      status, statusText: '', headers: {}, config: { headers: new AxiosHeaders() }, data,
    });

  it('le a mensagem do envelope de erro, com o status', () => {
    expect(motivoDaFalha(recusa(400, { success: false, error: { message: 'operação desconhecida: vinculo' } }))).toBe('400: operação desconhecida: vinculo');
  });

  it('junta a lista da validacao', () => {
    expect(motivoDaFalha(recusa(400, { error: { message: ['versao vazia', 'origem vazia'] } }))).toBe('400: versao vazia; origem vazia');
  });

  it('sem corpo, fica a mensagem do proprio erro (timeout, rede)', () => {
    expect(motivoDaFalha(new Error('timeout of 15000ms exceeded'))).toBe('timeout of 15000ms exceeded');
    expect(motivoDaFalha(recusa(502, '<html>Bad Gateway</html>'))).toBe('Request failed with status code 502');
  });
});
