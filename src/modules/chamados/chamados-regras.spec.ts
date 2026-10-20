import {
  emailDoChamado,
  interpretarBusca,
  normalizarTelefone,
  podeEncaminhar,
  podeFechar,
  textoWhatsapp,
  validarContato,
  type ChamadoParaMensagem,
} from './chamados-regras';

const chamado: ChamadoParaMensagem = {
  numero: 42,
  titulo: 'Inversor parado',
  descricao: 'Sem geração desde as 10h <urgente>',
  motivo: 'ALARME',
  prioridade: 'ALTA',
  autor_nome: 'Diego',
  created_at: new Date('2026-10-20T13:00:00Z'),
  equipamento: { nome: 'Inversor 1', tag: 'INV-01' },
  unidade: { nome: 'Usina A' },
  planta: { nome: 'Fazenda Boa Vista' },
};

describe('chamados-regras', () => {
  it('normaliza telefone com e sem DDI', () => {
    expect(normalizarTelefone('(62) 99999-0000')).toBe('5562999990000');
    expect(normalizarTelefone('+55 62 99999-0000')).toBe('5562999990000');
    expect(normalizarTelefone('1234')).toBeNull();
  });

  it('valida contato por destino', () => {
    expect(validarContato('SMART_SERVICE', 'x')).toEqual({ contato: null });
    expect(validarContato('EMAIL', ' Op@Aupus.com ')).toEqual({ contato: 'op@aupus.com' });
    expect(validarContato('EMAIL', 'nao-e-email')).toHaveProperty('erro');
    expect(validarContato('WHATSAPP', '')).toEqual({ erro: 'Informe o WhatsApp de destino' });
    expect(validarContato('WHATSAPP', '62 99999-0000')).toEqual({ contato: '5562999990000' });
  });

  it('fechado não encaminha nem fecha de novo', () => {
    expect(podeEncaminhar('ABERTO')).toBe(true);
    expect(podeEncaminhar('ENCAMINHADO')).toBe(true);
    expect(podeEncaminhar('FECHADO')).toBe(false);
    expect(podeFechar('FECHADO')).toBe(false);
    expect(podeFechar('ENCAMINHADO')).toBe(true);
  });

  it('monta WhatsApp com número, equipamento, local e observação', () => {
    const t = textoWhatsapp(chamado, 'Levar escada');
    expect(t).toContain('*NexON · Chamado #42 — Inversor parado*');
    expect(t).toContain('Equipamento: Inversor 1 (INV-01)');
    expect(t).toContain('Local: Fazenda Boa Vista · Usina A');
    expect(t).toContain('Motivo: Alarme · Prioridade: Alta');
    expect(t).toContain('Observação: Levar escada');
  });

  it('escapa HTML no e-mail', () => {
    const { assunto, html } = emailDoChamado(chamado);
    expect(assunto).toBe('[NexON] Chamado #42 — Inversor parado');
    expect(html).toContain('&lt;urgente&gt;');
    expect(html).not.toContain('<urgente>');
  });

  it('interpreta busca por número ou texto', () => {
    expect(interpretarBusca('#12')).toEqual({ numero: 12, texto: '#12' });
    expect(interpretarBusca('inversor')).toEqual({ texto: 'inversor' });
    expect(interpretarBusca('  ')).toEqual({});
  });
});
