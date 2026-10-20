import { contarChamados, LinhaChamado, montarChamados, rotuloNotificado, rotuloPapel } from './chamados';

const linha = (o: Partial<LinhaChamado>): LinhaChamado => ({
  id: 'c1',
  numero: 12,
  equipamento_id: 'p1',
  equipamento_nome: 'Pivô 1',
  titulo: 'Pivô parado',
  status: 'ABERTO',
  created_at: new Date('2026-10-10T13:00:00Z'),
  autor_nome: 'João',
  autor_role: 'operador',
  fechado_em: null,
  ...o,
});

describe('chamados no relatório', () => {
  it('papel em texto corrido', () => {
    expect(rotuloPapel('gerente')).toBe('analista de operação');
    expect(rotuloPapel('propietario')).toBe('proprietário');
    expect(rotuloPapel('cativo')).toBeNull();
    expect(rotuloPapel(null)).toBeNull();
  });

  it('só encaminhamento ENVIADO aparece, no formato de exibição', () => {
    const e = { chamado_id: 'c1', contato: null, referencia_externa: null, status: 'ENVIADO' };
    expect(rotuloNotificado({ ...e, destino: 'SMART_SERVICE', referencia_externa: '2318' })).toBe('Smart Service (OS 2318)');
    expect(rotuloNotificado({ ...e, destino: 'SMART_SERVICE', referencia_externa: '01JABCD' })).toBe('Smart Service');
    expect(rotuloNotificado({ ...e, destino: 'WHATSAPP', contato: 'João' })).toBe('WhatsApp (João)');
    expect(rotuloNotificado({ ...e, destino: 'EMAIL', contato: 'manutencao@x.com' })).toBe('E-mail manutencao@x.com');
    expect(rotuloNotificado({ ...e, destino: 'EMAIL', status: 'PENDENTE' })).toBeNull();
  });

  it('monta o bloco com ISO de Brasília, notificados sem repetição e atendidoEm só quando fechado', () => {
    const encs = [
      { chamado_id: 'c1', destino: 'WHATSAPP', contato: 'João', status: 'ENVIADO', referencia_externa: null },
      { chamado_id: 'c1 ', destino: 'WHATSAPP', contato: 'João', status: 'ENVIADO', referencia_externa: null },
    ];
    const [c] = montarChamados([linha({})], encs);
    expect(c).toEqual({
      numero: 12,
      equipamento: 'Pivô 1',
      titulo: 'Pivô parado',
      abertoEm: '2026-10-10T10:00:00-03:00',
      abertoPor: 'João',
      abertoPorPapel: 'operador',
      notificado: ['WhatsApp (João)'],
      status: 'ABERTO',
      atendidoEm: null,
    });
    const [f] = montarChamados([linha({ status: 'FECHADO', fechado_em: new Date('2026-10-11T12:00:00Z'), equipamento_nome: null })], []);
    expect(f.atendidoEm).toBe('2026-10-11T09:00:00-03:00');
    expect(f.equipamento).toBe('—');
  });

  it('conta abertos no fim do período e atendidos dentro dele, por equipamento', () => {
    const ini = Date.parse('2026-10-01T03:00:00Z');
    const fim = Date.parse('2026-11-01T03:00:00Z');
    const linhas = [
      linha({}),
      linha({ id: 'c2', fechado_em: new Date('2026-10-15T00:00:00Z') }),
      linha({ id: 'c3', fechado_em: new Date('2026-11-05T00:00:00Z') }),
      linha({ id: 'c4', equipamento_id: 'outro' }),
    ];
    expect(contarChamados(linhas, ['p1'], ini, fim)).toEqual({ abertos: 2, atendidos: 1 });
  });
});
