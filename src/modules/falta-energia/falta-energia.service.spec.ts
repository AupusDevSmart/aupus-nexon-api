import { FaltaEnergiaService } from './falta-energia.service';

/** Tabela falta_energia_eventos em memória, só com o que o serviço usa. */
function tabela() {
  const linhas: any[] = [];
  const casa = (l: any, w: any = {}) =>
    Object.entries(w).every(([k, v]: [string, any]) => {
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('not' in v) return l[k] !== v.not;
        if ('lte' in v) return l[k] <= v.lte;
        if ('gte' in v) return l[k] >= v.gte;
        if ('in' in v) return v.in.includes(l[k]);
      }
      return l[k] === v;
    });
  const aplica = (l: any, data: any) => {
    for (const [k, v] of Object.entries<any>(data)) l[k] = v && typeof v === 'object' && 'increment' in v ? (l[k] ?? 0) + v.increment : v;
    l.updated_at = new Date();
  };
  return {
    linhas,
    create: jest.fn(async ({ data }) => {
      const l = { tentativas: 0, avisos: 1, fim_em: null, chamado_id: null, protocolo: null, whatsaupus_id: null, created_at: new Date(), updated_at: new Date(), ...data };
      linhas.push(l);
      return l;
    }),
    findFirst: jest.fn(async ({ where }) => linhas.filter((l) => casa(l, where)).sort((a, b) => b.inicio_em - a.inicio_em)[0] ?? null),
    findUnique: jest.fn(async ({ where }) => linhas.find((l) => l.id === where.id) ?? null),
    findUniqueOrThrow: jest.fn(async ({ where }) => linhas.find((l) => l.id === where.id)),
    findMany: jest.fn(async ({ where }) => linhas.filter((l) => casa(l, where))),
    update: jest.fn(async ({ where, data }) => {
      const l = linhas.find((x) => x.id === where.id);
      aplica(l, data);
      return l;
    }),
    updateMany: jest.fn(async ({ where, data }) => {
      const ls = linhas.filter((l) => casa(l, where));
      ls.forEach((l) => aplica(l, data));
      return { count: ls.length };
    }),
  };
}

function montar() {
  const eventos = tabela();
  const prisma: any = {
    falta_energia_eventos: eventos,
    equipamentos: { findFirst: jest.fn(async () => ({ id: 'ton1', nome: 'TON 01', planta_id: 'p1', unidade_id: 'u1' })) },
    unidades: {
      findFirst: jest.fn(async () => ({
        id: 'u1', nome: 'Pivô 1', planta_id: 'p1', numero_uc: '1001234567', estado: 'GO',
        concessionaria: { nome: 'EQUATORIAL GOIÁS', estado: 'GO' },
      })),
    },
    plantas: {
      findFirst: jest.fn(async () => ({
        id: 'p1', nome: 'Fazenda Boa Vista', logradouro: 'GO-060', bairro: 'Rural', cidade: 'Trindade', uf: 'GO', cep: null, numero_uc: null, proprietario_id: 'd1',
      })),
    },
    usuarios: { findFirst: jest.fn(async () => ({ id: 'd1', nome: 'João', cpf_cnpj: '12345678909', telefone: '62998765432' })) },
    $queryRaw: jest.fn(async () => [
      { chave: 'whatsapp_base_url', valor: 'https://wpp.teste' },
      { chave: 'whatsapp_api_key', valor: 'chave' },
    ]),
  };
  const chamados: any = {
    abrir: jest.fn(async () => ({ id: 'c1', numero: 42 })),
    editar: jest.fn(async () => ({})),
    mudarStatus: jest.fn(async () => ({})),
    adicionarNota: jest.fn(async () => ({})),
  };
  const auditoria: any = { registrar: jest.fn(async () => undefined) };
  const scope: any = { assertPlantaInScope: jest.fn(), getScope: jest.fn(async () => null), isScoped: () => false };
  const mqtt: any = { setEnergiaHook: jest.fn() };
  const svc = new FaltaEnergiaService(prisma, chamados, auditoria, scope, mqtt);
  return { svc, eventos, chamados, auditoria, mqtt };
}

const acoes = (auditoria: any) => auditoria.registrar.mock.calls.map((c: any[]) => c[0].acao);

describe('FaltaEnergiaService', () => {
  const fetchOriginal = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.FALTA_ENERGIA_CONFIRMAR_MIN = '0';
    delete process.env.FALTA_ENERGIA_ATIVO;
    fetchMock = jest.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, complaintId: 'cmp1', status: 'RECEIVED' }) }));
    global.fetch = fetchMock as any;
  });
  afterAll(() => {
    global.fetch = fetchOriginal;
  });

  it('registra o hook do MQTT', () => {
    const { svc, mqtt } = montar();
    svc.onModuleInit();
    expect(mqtt.setEnergiaHook).toHaveBeenCalled();
  });

  it('falta → chamado externo → robô → protocolo → energia volta: chamado resolvido', async () => {
    const { svc, eventos, chamados, auditoria } = montar();

    await svc.receberDaTon('ton1', { evento: 'falta' });
    await svc.receberDaTon('ton1', { evento: 'falta' }); // repetido: mesmo evento
    expect(eventos.linhas).toHaveLength(1);
    expect(eventos.linhas[0]).toMatchObject({ status: 'AGUARDANDO', chave: 'u:u1', uc: '1001234567', avisos: 2 });

    await svc.tick();
    expect(chamados.abrir).toHaveBeenCalledTimes(1);
    expect(chamados.abrir.mock.calls[0][0]).toMatchObject({
      tipo: 'EXTERNO', orgao: 'EQUATORIAL GOIÁS', motivo: 'FALTA_ENERGIA', planta_id: 'p1', unidade_id: 'u1', equipamento_id: 'ton1',
    });
    expect(chamados.abrir.mock.calls[0][1]).toBeUndefined(); // ação do sistema

    const [url, req] = fetchMock.mock.calls[0];
    expect(url).toBe('https://wpp.teste/api/v1/webhook/nexon/falta-energia');
    expect(req.headers['x-api-key']).toBe('chave');
    const corpo = JSON.parse(req.body);
    expect(corpo).toMatchObject({ eventId: eventos.linhas[0].id, uc: '1001234567', cliente: { nome: 'João', telefone: '62998765432' } });
    expect(eventos.linhas[0]).toMatchObject({ status: 'NO_ROBO', chamado_id: 'c1', whatsaupus_id: 'cmp1' });

    const token = corpo.callbackUrl.split('/').pop();
    await expect(svc.retornoWhatsaupus('x'.repeat(48), {})).rejects.toThrow('Retorno desconhecido');
    await svc.retornoWhatsaupus(token, { status: 'completed', protocoloEquatorial: '2026112400123', complaintId: 'cmp1' });
    expect(eventos.linhas[0]).toMatchObject({ status: 'PROTOCOLO', protocolo: '2026112400123' });
    expect(chamados.editar).toHaveBeenCalledWith('c1', expect.objectContaining({ protocolo: '2026112400123' }));
    expect(chamados.mudarStatus).toHaveBeenCalledWith('c1', expect.objectContaining({ status: 'EM_ANDAMENTO' }));

    await svc.receberDaTon('ton1', { evento: 'retorno' });
    expect(eventos.linhas[0].fim_em).toBeInstanceOf(Date);
    expect(chamados.mudarStatus).toHaveBeenLastCalledWith('c1', expect.objectContaining({ status: 'RESOLVIDO' }));

    expect(acoes(auditoria)).toEqual(['falta_energia_aviso', 'falta_energia_enviada', 'falta_energia_protocolo', 'falta_energia_retorno']);
    const aud = auditoria.registrar.mock.calls[2][0];
    expect(aud).toMatchObject({ objetoTipo: 'falta_energia', objetoId: eventos.linhas[0].id, plantaIds: ['p1'], unidadeIds: ['u1'] });
    expect(aud.mensagem).toContain('2026112400123');
  });

  it('piscada: energia volta antes da confirmação e nada é aberto', async () => {
    process.env.FALTA_ENERGIA_CONFIRMAR_MIN = '3';
    const { svc, eventos, chamados, auditoria } = montar();
    await svc.receberDaTon('ton1', { evento: 'falta' });
    await svc.tick();
    expect(chamados.abrir).not.toHaveBeenCalled();
    await svc.receberDaTon('ton1', { evento: 'retorno' });
    expect(eventos.linhas[0].status).toBe('CANCELADO');
    expect(acoes(auditoria)).toEqual(['falta_energia_aviso', 'falta_energia_retorno']);
  });

  it('WhatsAupus fora do ar: tenta de novo e, na 5ª, FALHOU com nota no chamado', async () => {
    const { svc, eventos, chamados, auditoria } = montar();
    fetchMock.mockImplementation(async () => ({ ok: false, status: 502, text: async () => 'bad gateway' }));
    await svc.receberDaTon('ton1', { evento: 'falta' });
    await svc.tick();
    expect(eventos.linhas[0]).toMatchObject({ status: 'ENVIANDO', tentativas: 1 });
    for (let i = 0; i < 4; i++) await svc.enviar(eventos.linhas[0].id);
    expect(eventos.linhas[0]).toMatchObject({ status: 'FALHOU', tentativas: 5 });
    expect(chamados.adicionarNota.mock.calls.at(-1)[1].texto).toContain('Abra na mão');
    expect(acoes(auditoria)).toContain('falta_energia_falhou');
  });

  it('sem UC: abre o chamado, não chama o robô e explica o que falta', async () => {
    const { svc, eventos, chamados } = montar();
    (svc as any).prisma.unidades.findFirst.mockResolvedValue({
      id: 'u1', nome: 'Pivô 1', planta_id: 'p1', numero_uc: null, estado: 'GO', concessionaria: null,
    });
    await svc.receberDaTon('ton1', { evento: 'falta' });
    await svc.tick();
    expect(chamados.abrir).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(eventos.linhas[0].status).toBe('SEM_DADOS');
    expect(chamados.adicionarNota.mock.calls[0][1].texto).toContain('número da UC');
  });

  it('robô falhou no WhatsAupus: FALHOU e nota com os telefones da concessionária', async () => {
    const { svc, eventos, chamados } = montar();
    await svc.receberDaTon('ton1', { evento: 'falta' });
    await svc.tick();
    const token = JSON.parse(fetchMock.mock.calls[0][1].body).callbackUrl.split('/').pop();
    await svc.retornoWhatsaupus(token, { status: 'failed', errorMessage: 'UC inválida' });
    expect(eventos.linhas[0]).toMatchObject({ status: 'FALHOU', ultimo_erro: 'UC inválida' });
    expect(chamados.adicionarNota.mock.calls.at(-1)[1].texto).toContain('62 3243-2020');
  });

  it('atendente assumiu: nota uma vez e o protocolo chega depois', async () => {
    const { svc, eventos, chamados, auditoria } = montar();
    await svc.receberDaTon('ton1', { evento: 'falta' });
    await svc.tick();
    const token = JSON.parse(fetchMock.mock.calls[0][1].body).callbackUrl.split('/').pop();
    await svc.retornoWhatsaupus(token, { status: 'needs_human', errorMessage: 'Clara mudou o menu' });
    await svc.retornoWhatsaupus(token, { status: 'needs_human', errorMessage: 'Clara mudou o menu' });
    const notas = chamados.adicionarNota.mock.calls.map((c: any[]) => c[1].texto).filter((t: string) => t.includes('Atendente'));
    expect(notas).toHaveLength(1);
    expect(eventos.linhas[0].status).toBe('NO_ROBO');
    await svc.retornoWhatsaupus(token, { status: 'completed', protocoloEquatorial: '486057723', ucNova: '000405952101297' });
    expect(eventos.linhas[0]).toMatchObject({ status: 'PROTOCOLO', protocolo: '486057723' });
    expect(chamados.adicionarNota.mock.calls.at(-1)[1].texto).toContain('000405952101297');
    expect(acoes(auditoria).filter((a: string) => a === 'falta_energia_falhou')).toHaveLength(1);
  });

  it('automação desligada não abre nada', async () => {
    process.env.FALTA_ENERGIA_ATIVO = 'false';
    const { svc, chamados } = montar();
    await svc.receberDaTon('ton1', { evento: 'falta' });
    await svc.tick();
    expect(chamados.abrir).not.toHaveBeenCalled();
  });
});
