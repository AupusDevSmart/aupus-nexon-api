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

import { agregarEstatisticas, duracaoHoras, podeMudarStatus, ultimosMeses } from './chamados-regras';

describe('NEXON-144: externo', () => {
  it('troca de status só no externo e para outro status', () => {
    expect(podeMudarStatus('INTERNO', 'ABERTO', 'RESOLVIDO')).toHaveProperty('erro');
    expect(podeMudarStatus('EXTERNO', 'ABERTO', 'ABERTO')).toHaveProperty('erro');
    expect(podeMudarStatus('EXTERNO', 'ABERTO', 'FECHADO')).toHaveProperty('erro');
    expect(podeMudarStatus('EXTERNO', 'RESOLVIDO', 'EM_ANDAMENTO')).toEqual({ ok: true });
  });

  it('duração conta da ocorrência até o encerramento', () => {
    const c = { ocorrencia_em: new Date('2026-11-20T10:00:00Z'), aberto_em: new Date('2026-11-20T11:00:00Z'), created_at: new Date('2026-11-20T12:00:00Z'), fechado_em: new Date('2026-11-20T16:30:00Z') };
    expect(duracaoHoras(c)).toBe(6.5);
  });

  it('últimos meses atravessa a virada do ano', () => {
    expect(ultimosMeses(3, new Date('2026-02-10T15:00:00Z'))).toEqual(['2025-12', '2026-01', '2026-02']);
  });

  it('agrega totais, meses e órgãos', () => {
    const agora = new Date('2026-11-24T15:00:00Z');
    const base = { motivo: 'FALTA_ENERGIA', planta_id: 'p1', equipamento_id: null, aberto_em: null, previsao_em: null, ocorrencia_em: null };
    const r = agregarEstatisticas(
      [
        { ...base, tipo: 'EXTERNO', status: 'RESOLVIDO', orgao: 'Equatorial', created_at: new Date('2026-11-10T12:00:00Z'), fechado_em: new Date('2026-11-10T16:00:00Z') },
        { ...base, tipo: 'EXTERNO', status: 'ABERTO', orgao: 'Equatorial', created_at: new Date('2026-11-23T15:00:00Z'), fechado_em: null, previsao_em: new Date('2026-11-24T12:00:00Z') },
        { ...base, motivo: 'FALHA', tipo: 'INTERNO', status: 'ENCAMINHADO', orgao: null, equipamento_id: 'e1', created_at: new Date('2026-10-05T12:00:00Z'), fechado_em: null },
      ],
      agora,
    );
    expect(r.totais).toMatchObject({ total: 3, abertos: 2, externos_abertos: 1, internos_abertos: 1, resolvidos: 1, resolvidos_no_mes: 1, previsao_vencida: 1, horas_media_resolucao: 4, horas_media_falta_energia: 4 });
    expect(r.por_mes.slice(-2)).toEqual([{ mes: '2026-10', abertos: 1, resolvidos: 0 }, { mes: '2026-11', abertos: 2, resolvidos: 1 }]);
    expect(r.por_orgao).toEqual([{ chave: 'Equatorial', total: 2 }]);
  });
});
