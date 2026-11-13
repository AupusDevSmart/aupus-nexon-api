import { calcularCapacidades, type EquipamentoCapacidade, type EntradaCapacidades } from './capacidades';

const AGORA = new Date('2026-11-12T15:00:00Z');
const recente = new Date('2026-11-12T14:55:00Z');
const antiga = new Date('2026-11-09T13:00:00Z');

const eq = (p: Partial<EquipamentoCapacidade>): EquipamentoCapacidade => ({
  id: 'X', codigo: null, tipo_nome: null, categoria: null, tipo_equipamento: null, topico_mqtt: null,
  vinculado_iot: false, ultima_leitura: null, ...p,
});
const inversor = (id: string, ultima: Date | null = recente) =>
  eq({ id, codigo: 'INVERSOR', tipo_nome: 'Inversor Fotovoltaico', categoria: 'Inversor PV', topico_mqtt: `CF/${id}/data`, ultima_leitura: ultima });
const ton = eq({ id: 'TON', codigo: 'TON1', categoria: 'TON', topico_mqtt: 'CF/UFV', vinculado_iot: true });
const medConcDesenhado = eq({ id: 'MED', codigo: 'EQTL001', categoria: 'Padrão de Energia - Ramal de Entrada', tipo_equipamento: 'EQTL001' });
const medConc = (ultima: Date | null) =>
  eq({ id: 'MC', codigo: 'EQTL001', tipo_nome: 'Medidor Concessionária', categoria: 'Padrão de Energia - Ramal de Entrada', topico_mqtt: 'L/Medidor_1/data', ultima_leitura: ultima });
const pm = (p: Partial<EquipamentoCapacidade> = {}) =>
  eq({ id: 'PM', codigo: 'METER_M160', tipo_nome: 'Power Meter', categoria: 'Power Meter', topico_mqtt: 'L/PM/data', ultima_leitura: recente, ...p });

const base = (p: Partial<EntradaCapacidades>): EntradaCapacidades => ({
  equipamentos: [], demandaCarga: null, demandaGeracao: null, nuvem: null, agora: AGORA, ...p,
});

describe('calcularCapacidades (NEXON-110)', () => {
  it('CF: TON só com inversores e MED-01 desenhado sem vínculo IoT → só geração', () => {
    const c = calcularCapacidades(base({
      equipamentos: [inversor('IV1'), inversor('IV2'), ton, medConcDesenhado],
      demandaCarga: 300, demandaGeracao: 300,
      nuvem: { ativo: true, ultima_sync_em: recente, frequencia_min: 15 },
    }));
    expect(c.geracao).toEqual({ existe: true, fonte: 'ton', comunicando: true, ultima_leitura: recente.toISOString() });
    for (const k of ['medicao_entrada', 'carga', 'rede', 'grandezas_eletricas'] as const) expect(c[k].existe).toBe(false);
    expect(c.demanda_contratada).toMatchObject({ existe: true, fonte: 'manual' });
  });

  it('instalação completa com medidores offline: carga/rede/grandezas existem com comunicando:false', () => {
    const c = calcularCapacidades(base({ equipamentos: [inversor('IV1'), medConc(antiga), pm({ ultima_leitura: antiga })] }));
    for (const k of ['medicao_entrada', 'carga', 'rede', 'grandezas_eletricas'] as const) {
      expect(c[k]).toEqual({ existe: true, fonte: 'ton', comunicando: false, ultima_leitura: antiga.toISOString() });
    }
  });

  it('medidor sem nenhuma leitura continua existindo, sem última leitura', () => {
    const c = calcularCapacidades(base({ equipamentos: [medConc(null)] }));
    expect(c.rede).toEqual({ existe: true, fonte: 'ton', comunicando: false, ultima_leitura: null });
  });

  it('só nuvem: geração com fonte nuvem, o resto não existe', () => {
    const c = calcularCapacidades(base({ nuvem: { ativo: true, ultima_sync_em: recente, frequencia_min: 15 } }));
    expect(c.geracao).toMatchObject({ existe: true, fonte: 'nuvem', comunicando: true });
    expect(c.carga.existe).toBe(false);
    expect(c.demanda_contratada.existe).toBe(false);
  });

  it('nuvem inativa e sem inversor: geração não existe', () => {
    const c = calcularCapacidades(base({ nuvem: { ativo: false, ultima_sync_em: recente, frequencia_min: 15 } }));
    expect(c.geracao.existe).toBe(false);
  });

  it('só medidor da concessionária: rede existe, carga não (sem Power Meter a carga é desconhecida)', () => {
    const c = calcularCapacidades(base({ equipamentos: [medConc(recente)] }));
    expect(c.rede.existe).toBe(true);
    expect(c.medicao_entrada.existe).toBe(true);
    expect(c.carga.existe).toBe(false);
  });

  it('Power Meter → carga e grandezas, sem rede', () => {
    const c = calcularCapacidades(base({ equipamentos: [pm()] }));
    expect(c.carga.existe).toBe(true);
    expect(c.grandezas_eletricas.existe).toBe(true);
    expect(c.rede.existe).toBe(false);
  });

  it('Power Meter em circuito interno continua sendo carga (regra pela categoria)', () => {
    const c = calcularCapacidades(base({ equipamentos: [pm({ vinculado_iot: true })] }));
    expect(c.carga.existe).toBe(true);
  });

  it('gateway A966 dá rede mas não grandezas elétricas', () => {
    const a966 = eq({ id: 'A', codigo: 'A966', tipo_nome: 'IMS A966', categoria: 'Gateway', vinculado_iot: true, ultima_leitura: recente });
    const c = calcularCapacidades(base({ equipamentos: [a966] }));
    expect(c.rede.existe).toBe(true);
    expect(c.grandezas_eletricas.existe).toBe(false);
  });

  it('medidor ligado só pelo projeto IoT da TON (sem tópico próprio) existe', () => {
    const c = calcularCapacidades(base({ equipamentos: [eq({ id: 'M', codigo: 'EQTL001', categoria: 'Padrão de Energia - Ramal de Entrada', vinculado_iot: true })] }));
    expect(c.rede.existe).toBe(true);
  });
});
