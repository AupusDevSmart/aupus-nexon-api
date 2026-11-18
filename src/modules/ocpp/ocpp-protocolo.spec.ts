import {
  CORRENTE_MIN_A,
  destravarConector,
  ErroPayload,
  iniciarRemoto,
  lerConfiguracao,
  lerMedicoes,
  lerParametros,
  lerPerfis,
  lerQuadro,
  limparPerfilCorrente,
  montarCall,
  montarErro,
  montarResultado,
  mudarConfiguracao,
  mudarDisponibilidade,
  pararRemoto,
  pedirMensagem,
  PERFIL_CORRENTE_ID,
  perfilCorrenteMaxima,
  reiniciar,
  statusDa,
  validarEntrada,
} from './ocpp-protocolo';

/**
 * NEXON-130 — OCPP 1.6-J: montagem e interpretação dos quadros e das mensagens, conforme a
 * especificação que o manual do Chint Wallbox declara (p. 14 e 23).
 */
describe('OCPP 1.6-J: quadros', () => {
  it('lê CALL, CALLRESULT e CALLERROR', () => {
    expect(lerQuadro('[2,"a1","Heartbeat",{}]')).toEqual({ tipo: 'call', id: 'a1', acao: 'Heartbeat', payload: {} });
    expect(lerQuadro('[3,"a2",{"status":"Accepted"}]')).toEqual({ tipo: 'resultado', id: 'a2', payload: { status: 'Accepted' } });
    expect(lerQuadro('[4,"a3","NotSupported","sem perfil",{"x":1}]')).toEqual({ tipo: 'erro', id: 'a3', codigo: 'NotSupported', descricao: 'sem perfil', detalhes: { x: 1 } });
  });

  it('aceita identificador numérico e CALL sem payload', () => {
    expect(lerQuadro('[2,17,"Heartbeat"]')).toEqual({ tipo: 'call', id: '17', acao: 'Heartbeat', payload: {} });
  });

  it('o que não é OCPP-J vira inválido, com o id quando dá para responder', () => {
    expect(lerQuadro('não é json')).toMatchObject({ tipo: 'invalido', id: null, codigo: 'FormationViolation' });
    expect(lerQuadro('{"a":1}')).toMatchObject({ tipo: 'invalido', id: null });
    expect(lerQuadro('[2,"x"]')).toMatchObject({ tipo: 'invalido', id: 'x', codigo: 'FormationViolation' });
    expect(lerQuadro('[2,"x","Heartbeat",[1]]')).toMatchObject({ tipo: 'invalido', id: 'x', codigo: 'FormationViolation' });
    expect(lerQuadro('[9,"x",{}]')).toMatchObject({ tipo: 'invalido', id: 'x', codigo: 'ProtocolError' });
  });

  it('monta os três tipos de quadro', () => {
    expect(JSON.parse(montarCall('u1', 'Reset', { type: 'Soft' }))).toEqual([2, 'u1', 'Reset', { type: 'Soft' }]);
    expect(JSON.parse(montarResultado('u2', { currentTime: 'x' }))).toEqual([3, 'u2', { currentTime: 'x' }]);
    expect(JSON.parse(montarErro('u3', 'NotImplemented', 'Ação não tratada'))).toEqual([4, 'u3', 'NotImplemented', 'Ação não tratada', {}]);
  });
});

describe('OCPP 1.6-J: mensagens do carregador', () => {
  const erro = (fn: () => unknown) => {
    try { fn(); } catch (e) { return (e as ErroPayload).codigo; }
    return null;
  };

  it('BootNotification: guarda fabricante, modelo, série e firmware', () => {
    const p = validarEntrada('BootNotification', { chargePointVendor: 'CHINT', chargePointModel: 'NTW-EC2A22W1-L', chargePointSerialNumber: '20260703000025', firmwareVersion: '1.2.3', extra: 'ignorado' });
    expect(p).toEqual({ chargePointVendor: 'CHINT', chargePointModel: 'NTW-EC2A22W1-L', chargePointSerialNumber: '20260703000025', firmwareVersion: '1.2.3' });
  });

  it('StatusNotification: estado, erro e código do fabricante', () => {
    const p = validarEntrada('StatusNotification', { connectorId: 1, errorCode: 'OtherError', status: 'Faulted', vendorErrorCode: 'E07', timestamp: '2026-11-18T12:00:00Z' });
    expect(p).toMatchObject({ connectorId: 1, errorCode: 'OtherError', status: 'Faulted', vendorErrorCode: 'E07' });
    expect((p.timestamp as Date).toISOString()).toBe('2026-11-18T12:00:00.000Z');
  });

  it('StartTransaction e StopTransaction: inteiros aceitos também como texto numérico', () => {
    expect(validarEntrada('StartTransaction', { connectorId: '1', idTag: 'ABC123', meterStart: '1500', timestamp: '2026-11-18T12:00:00Z' }))
      .toMatchObject({ connectorId: 1, idTag: 'ABC123', meterStart: 1500 });
    expect(validarEntrada('StopTransaction', { transactionId: 7, meterStop: 9000, timestamp: '2026-11-18T13:00:00Z', reason: 'Remote' }))
      .toMatchObject({ transactionId: 7, meterStop: 9000, reason: 'Remote' });
  });

  it('registrador torto não vira erro eterno: fração arredonda, estouro e negativo são limitados, tag longa do fim é cortada', () => {
    expect(validarEntrada('StartTransaction', { connectorId: 1, idTag: 'A', meterStart: 1500.6 }).meterStart).toBe(1501);
    expect(validarEntrada('StopTransaction', { transactionId: 1, meterStop: '8500.4' }).meterStop).toBe(8500);
    expect(validarEntrada('StopTransaction', { transactionId: 1, meterStop: 9_999_999_999 }).meterStop).toBe(2_147_483_647);
    expect(validarEntrada('StopTransaction', { transactionId: 1, meterStop: -5 }).meterStop).toBe(0);
    expect(validarEntrada('StopTransaction', { transactionId: 1, meterStop: 10, idTag: 'X'.repeat(30) }).idTag).toHaveLength(20);
  });

  it('data inválida não derruba a transação: vira null (a central usa a hora dela)', () => {
    expect(validarEntrada('StartTransaction', { connectorId: 1, idTag: 'A', meterStart: 0, timestamp: 'ontem' }).timestamp).toBeNull();
    expect(validarEntrada('StartTransaction', { connectorId: 1, idTag: 'A', meterStart: 0 }).timestamp).toBeNull();
  });

  it('recusa com o código OCPP certo', () => {
    expect(erro(() => validarEntrada('Inventada', {}))).toBe('NotImplemented');
    expect(erro(() => validarEntrada('Authorize', {}))).toBe('OccurenceConstraintViolation');
    expect(erro(() => validarEntrada('StartTransaction', { connectorId: 1, idTag: 'A', meterStart: 'muito' }))).toBe('TypeConstraintViolation');
    expect(erro(() => validarEntrada('StartTransaction', { connectorId: 1.5, idTag: 'A', meterStart: 0 }))).toBe('TypeConstraintViolation');
    expect(erro(() => validarEntrada('Authorize', { idTag: 'X'.repeat(21) }))).toBe('PropertyConstraintViolation');
    expect(erro(() => validarEntrada('MeterValues', { connectorId: 1, meterValue: 'x' }))).toBe('TypeConstraintViolation');
    expect(erro(() => validarEntrada('Heartbeat', 'x'))).toBe('FormationViolation');
  });

  it('texto descritivo longo é cortado, não recusado', () => {
    const p = validarEntrada('BootNotification', { chargePointVendor: 'V'.repeat(200), chargePointModel: 'M' });
    expect(p.chargePointVendor).toHaveLength(80);
  });
});

describe('OCPP 1.6-J: MeterValues', () => {
  it('lê energia, potência, corrente, tensão e temperatura de uma amostra', () => {
    const [m] = lerMedicoes([{
      timestamp: '2026-11-18T12:01:00Z',
      sampledValue: [
        { value: '12500', measurand: 'Energy.Active.Import.Register', unit: 'Wh' },
        { value: '7.2', measurand: 'Power.Active.Import', unit: 'kW' },
        { value: '31.4', measurand: 'Current.Import', unit: 'A' },
        { value: '221', measurand: 'Voltage', unit: 'V' },
        { value: '41', measurand: 'Temperature', unit: 'Celsius' },
      ],
    }]);
    expect(m).toMatchObject({ energiaWh: 12500, potenciaW: 7200, correnteA: 31.4, tensaoV: 221, temperaturaC: 41, soc: null, contexto: 'Sample.Periodic' });
    expect(m.ts?.toISOString()).toBe('2026-11-18T12:01:00.000Z');
  });

  it('sem measurand é o registrador de energia em Wh; kWh vira Wh', () => {
    expect(lerMedicoes([{ timestamp: '2026-11-18T12:00:00Z', sampledValue: [{ value: '900' }] }])[0].energiaWh).toBe(900);
    expect(lerMedicoes([{ sampledValue: [{ value: '1.25', unit: 'kWh' }] }])[0]).toMatchObject({ energiaWh: 1250, ts: null });
  });

  it('trifásico: potência soma as fases, corrente é a maior, tensão é a média fase-neutro', () => {
    const [m] = lerMedicoes([{
      timestamp: '2026-11-18T12:00:00Z',
      sampledValue: [
        { value: '2400', measurand: 'Power.Active.Import', phase: 'L1' },
        { value: '2300', measurand: 'Power.Active.Import', phase: 'L2' },
        { value: '2500', measurand: 'Power.Active.Import', phase: 'L3' },
        { value: '10.4', measurand: 'Current.Import', phase: 'L1' },
        { value: '10.9', measurand: 'Current.Import', phase: 'L2' },
        { value: '10.1', measurand: 'Current.Import', phase: 'L3' },
        { value: '220', measurand: 'Voltage', phase: 'L1-N' },
        { value: '222', measurand: 'Voltage', phase: 'L2-N' },
        { value: '224', measurand: 'Voltage', phase: 'L3-N' },
        { value: '381', measurand: 'Voltage', phase: 'L1-L2' },
      ],
    }]);
    expect(m).toMatchObject({ potenciaW: 7200, correnteA: 10.9, tensaoV: 222 });
    expect(m.fases.corrente).toEqual({ L1: 10.4, L2: 10.9, L3: 10.1 });
  });

  it('converte Fahrenheit e Kelvin, lê SoC e ignora dado assinado e valor não numérico', () => {
    const [m] = lerMedicoes([{
      sampledValue: [
        { value: '104', measurand: 'Temperature', unit: 'Fahrenheit' },
        { value: '63', measurand: 'SoC', unit: 'Percent' },
        { value: 'AAECAw==', measurand: 'Energy.Active.Import.Register', format: 'SignedData' },
        { value: 'abc', measurand: 'Power.Active.Import' },
      ],
    }]);
    expect(m).toMatchObject({ temperaturaC: 40, soc: 63, energiaWh: null, potenciaW: null });
    expect(lerMedicoes([{ sampledValue: [{ value: '300', measurand: 'Temperature', unit: 'K' }] }])[0].temperaturaC).toBe(26.9);
  });

  it('mesma grandeza em dois pontos: vale a da saída (Outlet)', () => {
    const [m] = lerMedicoes([{
      sampledValue: [
        { value: '7000', measurand: 'Power.Active.Import', location: 'Outlet' },
        { value: '7100', measurand: 'Power.Active.Import', location: 'Inlet' },
      ],
    }]);
    expect(m.potenciaW).toBe(7000);
  });

  it('payload torto não quebra', () => {
    expect(lerMedicoes(null)).toEqual([]);
    expect(lerMedicoes([{ sampledValue: 'x' }, 7, { timestamp: 'x', sampledValue: [null] }])).toHaveLength(1);
  });
});

describe('OCPP 1.6-J: mensagens da central', () => {
  it('iniciar e parar remotamente', () => {
    expect(iniciarRemoto('ABC123', 1)).toEqual({ acao: 'RemoteStartTransaction', payload: { idTag: 'ABC123', connectorId: 1 } });
    expect(iniciarRemoto('ABC123')).toEqual({ acao: 'RemoteStartTransaction', payload: { idTag: 'ABC123' } });
    expect(pararRemoto(42)).toEqual({ acao: 'RemoteStopTransaction', payload: { transactionId: 42 } });
    expect(() => iniciarRemoto('X'.repeat(21))).toThrow();
    expect(() => iniciarRemoto('')).toThrow();
    expect(() => pararRemoto(1.5)).toThrow();
  });

  it('corrente máxima: perfil de carga em ampères, sem fim', () => {
    const c = perfilCorrenteMaxima({ conector: 1, limiteA: 16, inicio: new Date('2026-11-18T12:00:00Z') });
    expect(c).toEqual({
      acao: 'SetChargingProfile',
      payload: {
        connectorId: 1,
        csChargingProfiles: {
          chargingProfileId: PERFIL_CORRENTE_ID, stackLevel: 0, chargingProfilePurpose: 'TxDefaultProfile', chargingProfileKind: 'Absolute',
          chargingSchedule: { startSchedule: '2026-11-18T12:00:00.000Z', chargingRateUnit: 'A', chargingSchedulePeriod: [{ startPeriod: 0, limit: 16 }] },
        },
      },
    });
    const estacao = perfilCorrenteMaxima({ conector: 1, limiteA: 16, proposito: 'ChargePointMaxProfile' });
    expect(estacao.payload.connectorId).toBe(0);
    expect(() => perfilCorrenteMaxima({ conector: 1, limiteA: CORRENTE_MIN_A - 1 })).toThrow();
    expect(limparPerfilCorrente()).toEqual({ acao: 'ClearChargingProfile', payload: { id: PERFIL_CORRENTE_ID } });
  });

  it('bloquear, destravar, reiniciar, pedir leitura e configuração', () => {
    expect(mudarDisponibilidade(0, 'Inoperative')).toEqual({ acao: 'ChangeAvailability', payload: { connectorId: 0, type: 'Inoperative' } });
    expect(destravarConector(1)).toEqual({ acao: 'UnlockConnector', payload: { connectorId: 1 } });
    expect(() => destravarConector(0)).toThrow();
    expect(reiniciar()).toEqual({ acao: 'Reset', payload: { type: 'Soft' } });
    expect(pedirMensagem('MeterValues', 1)).toEqual({ acao: 'TriggerMessage', payload: { requestedMessage: 'MeterValues', connectorId: 1 } });
    expect(lerConfiguracao()).toEqual({ acao: 'GetConfiguration', payload: {} });
    expect(lerConfiguracao(['HeartbeatInterval'])).toEqual({ acao: 'GetConfiguration', payload: { key: ['HeartbeatInterval'] } });
    expect(mudarConfiguracao('MeterValueSampleInterval', '60')).toEqual({ acao: 'ChangeConfiguration', payload: { key: 'MeterValueSampleInterval', value: '60' } });
    expect(() => mudarConfiguracao('', '1')).toThrow();
  });

  it('lê a resposta do carregador: status, parâmetros e perfis suportados', () => {
    expect(statusDa({ status: 'Rejected' })).toBe('Rejected');
    expect(statusDa({})).toBe('');
    const r = lerParametros({
      configurationKey: [
        { key: 'SupportedFeatureProfiles', readonly: true, value: 'Core, SmartCharging,RemoteTrigger' },
        { key: 'HeartbeatInterval', readonly: false, value: '240' },
        { key: 'SemValor', readonly: false },
      ],
      unknownKey: ['Inexistente'],
    });
    expect(r.parametros.map((p) => p.chave)).toEqual(['HeartbeatInterval', 'SemValor', 'SupportedFeatureProfiles']);
    expect(r.parametros[1]).toEqual({ chave: 'SemValor', valor: null, somente_leitura: false });
    expect(r.desconhecidas).toEqual(['Inexistente']);
    expect(lerPerfis(r.parametros)).toEqual(['Core', 'SmartCharging', 'RemoteTrigger']);
    expect(lerPerfis([])).toEqual([]);
  });
});
