import {
  ALARMES_CHINT,
  codigoDoFabricante,
  correnteDe,
  descreverFalha,
  duracaoMin,
  estadoDoStatus,
  gerarIdTag,
  limiteAtingido,
  limiteDaRecarga,
  limiteEnergiaDe,
  limiteTempoDe,
  motivoDoOcpp,
  motivoFinal,
  origemDaRecarga,
  podeNoCarregador,
  grupoDoMorador,
  parametroSecreto,
  potenciaMediaW,
  semSegredo,
  textoMotivoFim,
} from './carregador-ocpp.regras';

/** NEXON-130 — regras do carregador OCPP: estado, falhas do manual, limites, fim e permissão. */
describe('Carregador OCPP: estado e falhas', () => {
  it('status do OCPP vira o estado da tela', () => {
    expect(['Available', 'Preparing', 'Charging', 'SuspendedEV', 'SuspendedEVSE', 'Finishing', 'Reserved', 'Unavailable', 'Faulted', 'Outro', null].map(estadoDoStatus))
      .toEqual(['disponivel', 'conectado', 'carregando', 'pausado', 'pausado', 'finalizando', 'reservado', 'indisponivel', 'falha', 'desconhecido', 'desconhecido']);
  });

  it('a tabela de erros do manual do Chint (p. 25–26) está inteira', () => {
    expect(Object.keys(ALARMES_CHINT)).toEqual(['E01', 'E02', 'E03', 'E04', 'E05', 'E06', 'E07', 'E08', 'E09', 'E10', 'E11', 'E12', 'E13', 'E14', 'E20', 'E21', 'E22', 'E30', 'E31']);
    expect(ALARMES_CHINT.E07.titulo).toBe('Botão de parada de emergência pressionado');
  });

  it('acha o código do fabricante no vendorErrorCode ou no info', () => {
    expect(codigoDoFabricante('E07')).toBe('E07');
    expect(codigoDoFabricante(null, 'Error e7')).toBe('E07');
    expect(codigoDoFabricante('E 21')).toBe('E21');
    expect(codigoDoFabricante('E99')).toBeNull();
    expect(codigoDoFabricante('TEMPE12RATURA')).toBeNull();
    expect(codigoDoFabricante(null, undefined)).toBeNull();
  });

  it('falha com o texto do manual quando o carregador manda o código', () => {
    expect(descreverFalha({ status: 'Faulted', errorCode: 'OtherError', vendorErrorCode: 'E07' })).toEqual({
      codigo: 'E07', ocpp: 'OtherError', titulo: 'Botão de parada de emergência pressionado',
      solucao: 'Girar o botão de emergência no sentido indicado para liberar.', severidade: 'CRITICA',
    });
  });

  it('sem código do fabricante, vale o erro padrão do OCPP', () => {
    expect(descreverFalha({ status: 'Faulted', errorCode: 'GroundFailure' })).toMatchObject({ codigo: null, titulo: 'Falha de aterramento', solucao: null, severidade: 'CRITICA' });
    expect(descreverFalha({ status: 'Charging', errorCode: 'WeakSignal' })).toMatchObject({ titulo: 'Sinal fraco da rede', severidade: 'BAIXA' });
    expect(descreverFalha({ status: 'Faulted', errorCode: 'NoError' })).toMatchObject({ ocpp: 'OtherError', titulo: 'Falha no carregador', severidade: 'ALTA' });
  });

  it('sem erro não há falha', () => {
    expect(descreverFalha({ status: 'Charging', errorCode: 'NoError' })).toBeNull();
    expect(descreverFalha({ status: 'Available' })).toBeNull();
  });
});

describe('Carregador OCPP: limites de uso', () => {
  it('limite de tempo: 5 a 1440 min, inteiro; vazio tira', () => {
    expect([null, '', undefined].map(limiteTempoDe)).toEqual([null, null, null]);
    expect(limiteTempoDe(60)).toBe(60);
    expect(limiteTempoDe('120')).toBe(120);
    expect([4, 1441, 30.5, 'abc', -1].map(limiteTempoDe)).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  it('limite de energia: 1 a 200 kWh, duas casas; vazio tira', () => {
    expect(limiteEnergiaDe('15,5')).toBe(15.5);
    expect(limiteEnergiaDe(7.126)).toBe(7.13);
    expect(limiteEnergiaDe('')).toBeNull();
    expect([0.5, 201, 'x'].map(limiteEnergiaDe)).toEqual([undefined, undefined, undefined]);
  });

  it('corrente: 6 A (mínimo da IEC 61851) ao nominal do carregador, inteira', () => {
    expect(correnteDe(16)).toBe(16);
    expect(correnteDe(32)).toBe(32);
    expect(correnteDe(null)).toBeNull();
    expect([5, 33, 10.5].map((v) => correnteDe(v))).toEqual([undefined, undefined, undefined]);
    expect(correnteDe(20, 16)).toBeUndefined();
  });

  it('o limite da recarga nunca passa do padrão do carregador', () => {
    expect(limiteDaRecarga(null, null)).toBeNull();
    expect(limiteDaRecarga(null, 120)).toBe(120);
    expect(limiteDaRecarga(60, null)).toBe(60);
    expect(limiteDaRecarga(60, 120)).toBe(60);
    expect(limiteDaRecarga(180, 120)).toBe(120);
  });

  it('diz quando a recarga passou do limite', () => {
    const inicio = new Date('2026-11-18T12:00:00Z');
    const base = { inicio, kwhTotal: 4.2, limiteTempoMin: null, limiteEnergiaKwh: null };
    expect(limiteAtingido(base, new Date('2026-11-19T12:00:00Z'))).toBeNull();
    expect(limiteAtingido({ ...base, limiteTempoMin: 60 }, new Date('2026-11-18T12:59:59Z'))).toBeNull();
    expect(limiteAtingido({ ...base, limiteTempoMin: 60 }, new Date('2026-11-18T13:00:00Z'))).toBe('limite_tempo');
    expect(limiteAtingido({ ...base, limiteEnergiaKwh: 5 }, inicio)).toBeNull();
    expect(limiteAtingido({ ...base, kwhTotal: 5, limiteEnergiaKwh: 5 }, inicio)).toBe('limite_energia');
    expect(limiteAtingido({ ...base, kwhTotal: null, limiteEnergiaKwh: 5 }, inicio)).toBeNull();
  });

  it('duração e potência média entre duas leituras do registrador', () => {
    expect(duracaoMin(new Date('2026-11-18T12:00:00Z'), new Date('2026-11-18T13:05:59Z'))).toBe(65);
    expect(duracaoMin(new Date('2026-11-18T12:00:00Z'), new Date('2026-11-18T11:00:00Z'))).toBe(0);
    const t0 = Date.parse('2026-11-18T12:00:00Z');
    expect(potenciaMediaW({ ts: t0, energiaWh: 1000 }, { ts: t0 + 60_000, energiaWh: 1120 })).toBe(7200);
    expect(potenciaMediaW(undefined, { ts: t0, energiaWh: 1 })).toBeNull();
    expect(potenciaMediaW({ ts: t0, energiaWh: 1000 }, { ts: t0 + 3_600_000, energiaWh: 8000 })).toBeNull(); // leitura distante
    expect(potenciaMediaW({ ts: t0, energiaWh: 1000 }, { ts: t0 + 60_000, energiaWh: 900 })).toBeNull(); // registrador voltou
  });
});

describe('Carregador OCPP: fim da recarga, tag e permissão', () => {
  it('motivo do carregador (StopTransaction.reason)', () => {
    expect(['EmergencyStop', 'EVDisconnected', 'HardReset', 'SoftReset', 'Reboot', 'PowerLoss', 'Remote', 'UnlockCommand', 'DeAuthorized', 'Local', undefined, 'Other', 'Xyz'].map(motivoDoOcpp))
      .toEqual(['emergencia', 'desconectado', 'reinicio', 'reinicio', 'reinicio', 'queda_energia', 'parado_no_nexon', 'destravado', 'cartao_recusado', 'parado_no_carregador', 'parado_no_carregador', 'outro', 'outro']);
  });

  it('o motivo do NexON só vale quando o carregador parou por comando remoto', () => {
    expect(motivoFinal('limite_energia', 'Remote')).toBe('limite_energia');
    expect(motivoFinal('limite_tempo', 'EVDisconnected')).toBe('desconectado');
    expect(motivoFinal(null, 'Remote')).toBe('parado_no_nexon');
    expect(textoMotivoFim('limite_tempo')).toBe('Limite de tempo');
    expect(textoMotivoFim(null)).toBeNull();
  });

  it('tag da recarga é sempre descartável; o grupo do morador junta a tag e o cartão dele', () => {
    expect(gerarIdTag()).toMatch(/^NX[0-9A-F]{18}$/);
    expect(gerarIdTag()).not.toBe(gerarIdTag());
    expect(grupoDoMorador('mor-a')).toBe('MMORA');
    expect(grupoDoMorador('d1cfbd9e8f583810c70c96f01d ')).toBe('MD1CFBD9E8F583810C70');
    expect(grupoDoMorador('d1cfbd9e8f583810c70c96f01d')).toHaveLength(20);
  });

  it('segredo não vai para a trilha: chave dentro de URL e parâmetro de senha', () => {
    expect(semSegredo('wss://aupus-nexon-api.aupusenergia.com.br/ocpp/aaaabbbbccccdddd0000111122223333/WALLBOX-1'))
      .toBe('wss://aupus-nexon-api.aupusenergia.com.br/ocpp/•••/WALLBOX-1');
    expect(semSegredo('60')).toBe('60');
    expect(['AuthorizationKey', 'WifiPassword', 'ApiToken', 'senha_admin'].map(parametroSecreto)).toEqual([true, true, true, true]);
    expect(parametroSecreto('MeterValueSampleInterval')).toBe(false);
  });

  it('origem da recarga', () => {
    expect(['tag', 'automatico', 'porteiro', 'morador', null].map(origemDaRecarga)).toEqual(['cartao', 'automatico', 'nexon', 'nexon', 'nexon']);
  });

  it('quem pode o quê (ADR 0002): limites com o dono, técnico só com a equipe Aupus', () => {
    expect(podeNoCarregador('analista')).toEqual({ comandar: true, limites: true, bloquear: true, tecnico: true });
    expect(podeNoCarregador('proprietario')).toEqual({ comandar: true, limites: true, bloquear: true, tecnico: false });
    expect(podeNoCarregador('operador')).toEqual({ comandar: true, limites: false, bloquear: true, tecnico: false });
    expect(podeNoCarregador('morador')).toEqual({ comandar: true, limites: false, bloquear: false, tecnico: false });
  });
});
