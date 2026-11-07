import {
  armadoAte,
  cameraDoCaminho,
  decidirEvento,
  dentroDaJanela,
  ehJpeg,
  ehLoopback,
  ehMp4,
  emailDoAlerta,
  estaArmado,
  expandirTipos,
  hhmm,
  inicioDaNoite,
  instanteLocal,
  interpretarDados,
  intervaloDoDia,
  modoVigente,
  montarRtsp,
  normalizarAnalise,
  partesLocais,
  streamAtivo,
  timeDe,
  tokenDaQuery,
  type ConfigArmamento,
} from './cameras-regras';

// São Paulo = UTC−3 (sem horário de verão desde 2019).
const noite = new Date('2026-11-07T22:00:00Z'); // 19:00 local
const tarde = new Date('2026-11-07T15:00:00Z'); // 12:00 local
const madrugada = new Date('2026-11-08T08:00:00Z'); // 05:00 local

const agenda: ConfigArmamento = {
  armamento_modo: 'agenda',
  armado_manual: false,
  armado_manual_ate: null,
  agenda_inicio: new Date('1970-01-01T18:00:00Z'),
  agenda_fim: new Date('1970-01-01T06:30:00Z'),
};

describe('cameras-regras · horário local', () => {
  it('converte UTC para partes em America/Sao_Paulo', () => {
    expect(partesLocais(noite)).toMatchObject({ ano: 2026, mes: 11, dia: 7, hora: 19, minuto: 0 });
    expect(partesLocais(madrugada)).toMatchObject({ dia: 8, hora: 5 });
  });

  it('instanteLocal é o inverso de partesLocais', () => {
    expect(instanteLocal(2026, 11, 7, 19, 0).toISOString()).toBe('2026-11-07T22:00:00.000Z');
    expect(instanteLocal(2026, 11, 8, 0, 0).toISOString()).toBe('2026-11-08T03:00:00.000Z');
  });

  it('intervaloDoDia cobre o dia local inteiro', () => {
    const r = intervaloDoDia('2026-11-07')!;
    expect(r.inicio.toISOString()).toBe('2026-11-07T03:00:00.000Z');
    expect(r.fim.toISOString()).toBe('2026-11-08T03:00:00.000Z');
    expect(intervaloDoDia('07/11/2026')).toBeNull();
    expect(intervaloDoDia('2026-13-01')).toBeNull();
  });

  it('hhmm e timeDe convertem a coluna time', () => {
    expect(hhmm(new Date('1970-01-01T18:00:00Z'))).toBe('18:00');
    expect(hhmm('06:30')).toBe('06:30');
    expect(hhmm(null)).toBeNull();
    expect(timeDe('06:30')!.toISOString()).toBe('1970-01-01T06:30:00.000Z');
    expect(timeDe('25:00')).toBeNull();
  });
});

describe('cameras-regras · armamento', () => {
  it('janela com virada de meia-noite', () => {
    expect(dentroDaJanela(19 * 60, 18 * 60, 6 * 60 + 30)).toBe(true);
    expect(dentroDaJanela(5 * 60, 18 * 60, 6 * 60 + 30)).toBe(true);
    expect(dentroDaJanela(12 * 60, 18 * 60, 6 * 60 + 30)).toBe(false);
    expect(dentroDaJanela(6 * 60 + 30, 18 * 60, 6 * 60 + 30)).toBe(false);
    expect(dentroDaJanela(10 * 60, 8 * 60, 12 * 60)).toBe(true);
    expect(dentroDaJanela(0, 9 * 60, 9 * 60)).toBe(true);
  });

  it('agenda: armado à noite e na madrugada, desarmado de dia', () => {
    expect(estaArmado(agenda, noite)).toBe(true);
    expect(estaArmado(agenda, madrugada)).toBe(true);
    expect(estaArmado(agenda, tarde)).toBe(false);
    expect(armadoAte(agenda, noite)!.toISOString()).toBe('2026-11-08T09:30:00.000Z');
    expect(modoVigente(agenda, noite)).toBe('agenda');
  });

  it('sem config vale a agenda padrão 18:00–06:30', () => {
    expect(estaArmado(null, noite)).toBe(true);
    expect(estaArmado(null, tarde)).toBe(false);
    expect(armadoAte(null, tarde)!.toISOString()).toBe('2026-11-08T09:30:00.000Z');
  });

  it('override manual com prazo futuro sobrepõe a agenda nos dois sentidos', () => {
    const ate = new Date('2026-11-07T23:00:00Z');
    const desarmadoAgora = { ...agenda, armado_manual: false, armado_manual_ate: ate };
    expect(estaArmado(desarmadoAgora, noite)).toBe(false);
    expect(armadoAte(desarmadoAgora, noite)).toBe(ate);
    expect(modoVigente(desarmadoAgora, noite)).toBe('manual');

    const armadoDeDia = { ...agenda, armado_manual: true, armado_manual_ate: new Date('2026-11-07T16:00:00Z') };
    expect(estaArmado(armadoDeDia, tarde)).toBe(true);
    // Prazo vencido: volta a valer a agenda.
    expect(estaArmado(armadoDeDia, noite)).toBe(true);
    expect(estaArmado({ ...armadoDeDia, armado_manual_ate: new Date('2026-11-07T14:00:00Z') }, tarde)).toBe(false);
  });

  it('manual: armado_manual com ou sem prazo', () => {
    const manual: ConfigArmamento = { ...agenda, armamento_modo: 'manual', armado_manual: true, armado_manual_ate: null };
    expect(estaArmado(manual, tarde)).toBe(true);
    expect(armadoAte(manual, tarde)).toBeNull();
    const comPrazo = { ...manual, armado_manual_ate: new Date('2026-11-07T16:00:00Z') };
    expect(estaArmado(comPrazo, tarde)).toBe(true);
    expect(estaArmado(comPrazo, noite)).toBe(false);
    expect(estaArmado({ ...manual, armado_manual: false }, noite)).toBe(false);
    expect(modoVigente(manual, tarde)).toBe('manual');
  });

  it('desarmado nunca arma', () => {
    const d = { ...agenda, armamento_modo: 'desarmado', armado_manual: true };
    expect(estaArmado(d, noite)).toBe(false);
    expect(armadoAte(d, noite)).toBeNull();
    expect(modoVigente(d, noite)).toBe('desarmado');
  });

  it('início da noite é o último agenda_inicio', () => {
    expect(inicioDaNoite(agenda, noite).toISOString()).toBe('2026-11-07T21:00:00.000Z');
    expect(inicioDaNoite(agenda, madrugada).toISOString()).toBe('2026-11-07T21:00:00.000Z');
    expect(inicioDaNoite(agenda, tarde).toISOString()).toBe('2026-11-06T21:00:00.000Z');
  });
});

describe('cameras-regras · eventos', () => {
  it('detecção armada de classe de alerta vira alerta com clipe', () => {
    expect(decidirEvento('pessoa', true, null)).toEqual({
      alerta: true,
      descartado: false,
      motivo_descarte: null,
      enviar_clipe: true,
    });
    expect(decidirEvento('veiculo', true, { clipe_s: 0 }).enviar_clipe).toBe(false);
  });

  it('desarmado e classe ignorada descartam', () => {
    expect(decidirEvento('pessoa', false, null)).toMatchObject({ alerta: false, descartado: true, motivo_descarte: 'desarmado' });
    expect(decidirEvento('animal', true, null)).toMatchObject({ descartado: true, motivo_descarte: 'classe_ignorada' });
    expect(decidirEvento('movimento', true, { classes_alerta: ['movimento'] })).toMatchObject({ alerta: true, descartado: false });
  });

  it('sistema e foto', () => {
    expect(decidirEvento('sem_sinal', false, null)).toMatchObject({ alerta: true, descartado: false, enviar_clipe: false });
    expect(decidirEvento('sinal_restabelecido', true, null)).toMatchObject({ alerta: false, descartado: false });
    expect(decidirEvento('foto', true, null)).toMatchObject({ alerta: false, descartado: false, enviar_clipe: false });
  });

  it('expande o filtro de tipos', () => {
    expect(expandirTipos('pessoa,veiculo')).toEqual(['pessoa', 'veiculo']);
    expect(expandirTipos('sistema')).toEqual(['sem_sinal', 'sinal_restabelecido']);
    expect(expandirTipos('pessoa, sistema')).toEqual(['pessoa', 'sem_sinal', 'sinal_restabelecido']);
    expect(expandirTipos('')).toBeNull();
    expect(expandirTipos('gato')).toBeNull();
  });

  it('interpreta dados do multipart', () => {
    expect(interpretarDados('{"area_pct":3.2}')).toEqual({ area_pct: 3.2 });
    expect(interpretarDados({ a: 1 })).toEqual({ a: 1 });
    expect(interpretarDados(undefined)).toEqual({});
    expect(interpretarDados('nao-json')).toBeNull();
    expect(interpretarDados('[1]')).toBeNull();
  });

  it('normaliza a análise com os padrões do contrato', () => {
    expect(normalizarAnalise(null)).toEqual({
      ativa: true,
      sensibilidade: 50,
      area_minima_pct: 0.5,
      fps_analise: 4,
      classificar: true,
      classes_alerta: ['pessoa', 'veiculo'],
      clipe_s: 12,
      zonas: [],
    });
    expect(normalizarAnalise({ sensibilidade: 80, classes_alerta: ['pessoa'], lixo: 1 })).toMatchObject({
      sensibilidade: 80,
      classes_alerta: ['pessoa'],
    });
  });
});

describe('cameras-regras · agente e mídia', () => {
  const cam = { fabricante: 'intelbras', ip: '192.168.0.108', porta_rtsp: 554, usuario: 'admin', canal: 1 };

  it('monta RTSP com credenciais codificadas', () => {
    expect(montarRtsp(cam, 'p@ss:w/rd', 0)).toBe('rtsp://admin:p%40ss%3Aw%2Frd@192.168.0.108:554/cam/realmonitor?channel=1&subtype=0');
    expect(montarRtsp(cam, 'x', 1)).toContain('subtype=1');
    expect(montarRtsp({ ...cam, fabricante: 'hikvision', canal: 2 }, 'x', 1)).toContain('/Streaming/Channels/202');
  });

  it('caminho do stream e token da query', () => {
    expect(cameraDoCaminho('cam-abc123')).toBe('abc123');
    expect(cameraDoCaminho('outra')).toBeNull();
    expect(tokenDaQuery('a=1&token=xyz')).toBe('xyz');
    expect(tokenDaQuery('?token=xyz')).toBe('xyz');
    expect(tokenDaQuery('')).toBeNull();
  });

  it('stream ativo por 90 s ou contínuo', () => {
    const agora = new Date('2026-11-07T12:00:00Z');
    expect(streamAtivo(new Date('2026-11-07T11:59:00Z'), false, agora)).toBe(true);
    expect(streamAtivo(new Date('2026-11-07T11:58:00Z'), false, agora)).toBe(false);
    expect(streamAtivo(null, true, agora)).toBe(true);
  });

  it('loopback e assinaturas de arquivo', () => {
    expect(ehLoopback('127.0.0.1')).toBe(true);
    expect(ehLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(ehLoopback('::1')).toBe(true);
    expect(ehLoopback('10.0.0.5')).toBe(false);
    expect(ehJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe(true);
    expect(ehJpeg(Buffer.from('PNG'))).toBe(false);
    expect(ehMp4(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(8)]))).toBe(true);
    expect(ehMp4(Buffer.alloc(20))).toBe(false);
  });

  it('e-mail do alerta escapa HTML e traz o link', () => {
    const { assunto, html } = emailDoAlerta({
      tipo: 'pessoa',
      inicio_em: noite,
      confianca: 0.87,
      camera_nome: 'Cabine <SSU>',
      unidade_nome: 'UFV Boa Vista',
      planta_nome: 'Fazenda',
      link: 'https://nexon.aupusenergia.com.br/supervisorio/sinoptico-ativo/u1',
    });
    expect(assunto).toBe('[NexON] Pessoa detectada — Cabine <SSU> · UFV Boa Vista');
    expect(html).toContain('Cabine &lt;SSU&gt;');
    expect(html).toContain('07/11/2026 19:00');
    expect(html).toContain('87%');
    expect(html).toContain('sinoptico-ativo/u1');
  });
});
