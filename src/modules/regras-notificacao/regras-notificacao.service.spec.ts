import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { RegrasNotificacaoService } from './regras-notificacao.service';
import { diffRegra, resumirAlteracoes } from './regras-notificacao-auditoria';

const regraBase = {
  id: 'r1'.padEnd(26, 'x'),
  nome: 'Falha nas usinas',
  evento: 'falha',
  limite_minutos: null,
  antecedencia_dias: null,
  canais: ['push', 'email'],
  papeis: ['admin'],
  planta_ids: ['p1'],
  usuario_ids: [],
  ativo: true,
  created_by: null,
  updated_by: null,
  created_at: new Date(),
  updated_at: new Date(),
  deleted_at: null,
};

function montar(scope: string[] | null = null) {
  const prisma = {
    regras_notificacao: {
      create: jest.fn(async ({ data }) => ({ ...regraBase, ...data })),
      update: jest.fn(async ({ data }) => ({ ...regraBase, ...data })),
      findFirst: jest.fn(async () => ({ ...regraBase })),
    },
    plantas: { findMany: jest.fn(async () => [{ id: 'p1', nome: 'Usina 1' }]) },
    usuarios: { findMany: jest.fn(async () => []) },
  };
  const scopeService = {
    getScope: jest.fn(async () => scope),
    isScoped: (s: unknown) => Array.isArray(s),
  };
  const auditoria = { registrar: jest.fn(async () => undefined) };
  const service = new RegrasNotificacaoService(prisma as any, scopeService as any, auditoria as any);
  return { service, prisma, auditoria };
}

const admin = { id: 'u1', role: 'admin', nome: 'Ana', email: 'ana@x.com' };

describe('RegrasNotificacaoService (NEXON-25)', () => {
  it('cria regra e grava na trilha com plantas e autor', async () => {
    const { service, auditoria } = montar();
    await service.create(
      { nome: ' Falha nas usinas ', evento: 'falha', canais: ['push', 'email'], papeis: ['admin'], planta_ids: ['p1'] },
      admin,
      { dispositivo: 'Chrome', ip: '1.1.1.1', userAgent: 'ua' } as any,
    );
    const r = (auditoria.registrar.mock.calls[0] as any[])[0];
    expect(r.acao).toBe('regra_notificacao');
    expect(r.plantaIds).toEqual(['p1']);
    expect(r.mensagem).toContain('Regra de notificação criada — Falha nas usinas');
    expect(r.mensagem).toContain('Push no app, E-mail');
    expect(r.detalhes.operacao).toBe('criada');
    expect(r.detalhes.usuario.nome).toBe('Ana');
    expect(r.detalhes.regra.plantas).toEqual([{ id: 'p1', nome: 'Usina 1' }]);
  });

  it('sem comunicação recebe 30 min por padrão; outros eventos ficam sem parâmetro', async () => {
    const { service, prisma } = montar();
    await service.create({ nome: 'Offline', evento: 'sem_comunicacao', canais: ['push'], papeis: ['operador'] }, admin);
    expect(prisma.regras_notificacao.create.mock.calls[0][0].data.limite_minutos).toBe(30);
    expect(prisma.regras_notificacao.create.mock.calls[0][0].data.antecedencia_dias).toBeNull();
  });

  it('exige quem recebe', async () => {
    const { service } = montar();
    await expect(service.create({ nome: 'X', evento: 'falha', canais: ['push'] }, admin)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('edição grava só o que mudou e não audita quando nada muda', async () => {
    const { service, auditoria, prisma } = montar();
    await service.update(regraBase.id, { canais: ['email', 'push'] }, admin);
    expect(prisma.regras_notificacao.update).not.toHaveBeenCalled();
    expect(auditoria.registrar).not.toHaveBeenCalled();

    await service.update(regraBase.id, { ativo: false, canais: ['whatsapp'] }, admin);
    const r = (auditoria.registrar.mock.calls[0] as any[])[0];
    expect(r.detalhes.campos_alterados).toEqual(['canais', 'ativo']);
    expect(r.mensagem).toContain('canais: WhatsApp; desativada');
  });

  it('exclusão é lógica e auditada', async () => {
    const { service, auditoria, prisma } = montar();
    await service.remove(regraBase.id, admin);
    expect(prisma.regras_notificacao.update.mock.calls[0][0].data.deleted_at).toBeInstanceOf(Date);
    expect((auditoria.registrar.mock.calls[0] as any[])[0].mensagem).toContain('excluida');
  });

  it('usuário com escopo não cria regra para todas as plantas nem fora das dele', async () => {
    const { service } = montar(['p2']);
    await expect(
      service.create({ nome: 'X', evento: 'falha', canais: ['push'], papeis: ['operador'] }, { id: 'u2', role: 'operador' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.create(
        { nome: 'X', evento: 'falha', canais: ['push'], papeis: ['operador'], planta_ids: ['p1'] },
        { id: 'u2', role: 'operador' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('diffRegra / resumirAlteracoes', () => {
  it('compara arrays sem ordem e ignora campo não enviado', () => {
    expect(diffRegra({ canais: ['a', 'b'], nome: 'x' }, { canais: ['b', 'a'] })).toEqual([]);
    expect(resumirAlteracoes(diffRegra({ evento: 'falha' }, { evento: 'sem_comunicacao' }))).toBe(
      'evento: Sem comunicação',
    );
  });
});
