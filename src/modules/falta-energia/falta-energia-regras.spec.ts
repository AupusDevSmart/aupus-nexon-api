import {
  atendidaPeloRobo,
  automacaoLigada,
  chaveDoEvento,
  duracao,
  lerAviso,
  lerRetornoWhatsaupus,
  minutosConfirmacao,
  montarPayloadWhatsaupus,
  normalizarUc,
  pendenciasParaRobo,
  type DadosInstalacao,
} from './falta-energia-regras';

const agora = new Date('2026-11-24T15:00:00Z');

const dados = (o: Partial<DadosInstalacao> = {}): DadosInstalacao => ({
  uc: '10/0123456-7',
  concessionariaNome: 'EQUATORIAL GOIÁS',
  concessionariaUf: 'GO',
  planta: { nome: 'Fazenda Boa Vista', logradouro: 'Rod. GO-060 km 12', bairro: 'Zona Rural', cidade: 'Trindade', uf: 'GO', cep: '75380-000' },
  proprietario: { nome: 'João da Silva', cpfCnpj: '123.456.789-09', telefone: '(62) 99876-5432' },
  ...o,
});

describe('lerAviso', () => {
  it('entende falta e retorno nos formatos aceitos', () => {
    expect(lerAviso({ evento: 'falta' }, agora)?.tipo).toBe('falta');
    expect(lerAviso({ evento: 'retorno' }, agora)?.tipo).toBe('retorno');
    expect(lerAviso({ rede: 0 }, agora)?.tipo).toBe('falta');
    expect(lerAviso({ rede: 1 }, agora)?.tipo).toBe('retorno');
    expect(lerAviso({ estado: 'sem_rede' }, agora)?.tipo).toBe('falta');
    expect(lerAviso({ estado: 'normal' }, agora)?.tipo).toBe('retorno');
  });

  it('ignora o que não entende', () => {
    expect(lerAviso(null, agora)).toBeNull();
    expect(lerAviso({ evento: 'talvez' }, agora)).toBeNull();
    expect(lerAviso({ outra: 1 }, agora)).toBeNull();
    expect(lerAviso('falta', agora)).toBeNull();
  });

  it('usa o relógio da TON em segundos, ms ou ISO; descarta relógio sem NTP', () => {
    const seg = Math.floor(agora.getTime() / 1000) - 120;
    expect(lerAviso({ evento: 'falta', ts: seg }, agora)!.em.getTime()).toBe(seg * 1000);
    expect(lerAviso({ evento: 'falta', ts: seg * 1000 }, agora)!.em.getTime()).toBe(seg * 1000);
    expect(lerAviso({ evento: 'falta', ts: '2026-11-24T14:58:00Z' }, agora)!.em.toISOString()).toBe('2026-11-24T14:58:00.000Z');
    expect(lerAviso({ evento: 'falta', ts: 12 }, agora)!.em).toEqual(agora);
  });
});

describe('cadastro', () => {
  it('agrupa pela unidade e, sem unidade, pela planta', () => {
    expect(chaveDoEvento(' u1 ', 'p1')).toBe('u:u1');
    expect(chaveDoEvento(null, 'p1')).toBe('p:p1');
  });

  it('UC só com dígitos', () => {
    expect(normalizarUc('10/0123456-7')).toBe('1001234567');
    expect(normalizarUc('123')).toBeNull();
    expect(normalizarUc(null)).toBeNull();
  });

  it('robô só para Equatorial Goiás', () => {
    expect(atendidaPeloRobo({ concessionariaNome: 'Equatorial Goiás', concessionariaUf: 'GO', uf: 'GO' })).toBe(true);
    expect(atendidaPeloRobo({ concessionariaNome: null, concessionariaUf: null, uf: 'go' })).toBe(true);
    expect(atendidaPeloRobo({ concessionariaNome: 'Equatorial Pará', concessionariaUf: 'PA', uf: 'PA' })).toBe(false);
    expect(atendidaPeloRobo({ concessionariaNome: 'CHESP', concessionariaUf: 'GO', uf: 'GO' })).toBe(false);
  });

  it('lista o que falta para o robô', () => {
    expect(pendenciasParaRobo(dados())).toEqual([]);
    expect(pendenciasParaRobo(dados({ uc: null, proprietario: null }))).toEqual([
      'número da UC da unidade',
      'proprietário da planta',
      'telefone do proprietário',
    ]);
    expect(pendenciasParaRobo(dados({ concessionariaNome: 'Enel', concessionariaUf: 'SP' }))).toEqual([
      'concessionária atendida pelo robô (só Equatorial Goiás)',
    ]);
  });
});

describe('montarPayloadWhatsaupus', () => {
  it('segue o contrato do webhook do WhatsAupus', () => {
    const p = montarPayloadWhatsaupus({
      eventoId: 'ev1',
      dados: dados({ proprietario: { nome: 'João', cpfCnpj: '123.456.789-09', telefone: '+55 62 99876-5432' } }),
      inicio: agora,
      equipamentoNome: 'TON 01',
      callbackUrl: 'https://api/x/tok',
    });
    expect(p).toMatchObject({
      eventId: 'ev1',
      uc: '1001234567',
      referencia: 'Fazenda Boa Vista - Rod. GO-060 km 12 - Zona Rural - Trindade/GO',
      escopo: 'Meu imóvel',
      endereco: { logradouro: 'Rod. GO-060 km 12', cidade: 'Trindade', uf: 'GO' },
      cliente: { nome: 'João', cpfCnpj: '12345678909', telefone: '62998765432' },
      ocorrencia: { tipo: 'falta_energia', inicio: agora.toISOString() },
      callbackUrl: 'https://api/x/tok',
    });
    expect(p.ocorrencia.descricao).toContain('TON 01');
  });
});

describe('lerRetornoWhatsaupus', () => {
  it('lê o callback com protocolo', () => {
    expect(
      lerRetornoWhatsaupus({ status: 'completed', protocoloEquatorial: '2026112400123', complaintId: 'c1', ucNova: '000405952101297', previsao: ' até 4 h ' }),
    ).toEqual({
      status: 'completed',
      protocolo: '2026112400123',
      erro: null,
      complaintId: 'c1',
      ucNova: '000405952101297',
      previsao: 'até 4 h',
    });
  });

  it('limpa o protocolo e lê falha', () => {
    expect(lerRetornoWhatsaupus({ status: 'COMPLETED', protocoloEquatorial: ' 123 456<script>' }).protocolo).toBe('123456script');
    expect(lerRetornoWhatsaupus({ status: 'failed', errorMessage: 'UC inválida' })).toMatchObject({ status: 'failed', erro: 'UC inválida', protocolo: null });
    expect(lerRetornoWhatsaupus(undefined).status).toBe('');
  });
});

describe('config e textos', () => {
  it('confirmação padrão 3 min, aceita 0 a 120', () => {
    expect(minutosConfirmacao(undefined)).toBe(3);
    expect(minutosConfirmacao('0')).toBe(0);
    expect(minutosConfirmacao('500')).toBe(3);
    expect(minutosConfirmacao('abc')).toBe(3);
  });

  it('automação liga por padrão', () => {
    expect(automacaoLigada(undefined)).toBe(true);
    expect(automacaoLigada('false')).toBe(false);
    expect(automacaoLigada('0')).toBe(false);
  });

  it('duração legível', () => {
    expect(duracao(new Date(0), new Date(12 * 60_000))).toBe('12 min');
    expect(duracao(new Date(0), new Date(65 * 60_000))).toBe('1 h 05 min');
  });
});
